/* eslint-disable */
/**
 * Feature 20 — privacy guarantee tests.
 *
 * These are the tests to run in front of a sceptical security reviewer.
 * They take a message full of sensitive content, run the real detection
 * and payload path, and assert that no fragment of the original message
 * survives into anything that would be transmitted.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/core/detector.js");
const EP = require("../src/core/event-payload.js");

const SENSITIVE_MESSAGE = [
  "Hi, this is CONFIDENTIAL. Priya's card is 4111 1111 1111 1111,",
  "her PAN is ABCDE1234F, phone 9876543210, email priya.sharma@acmecorp.in.",
  "AWS key AKIAIOSFODNN7EXAMPLE, internal host 192.168.10.5.",
  "The cap table and the arbitration clause are attached. CTC revised.",
  "Tracking ref ACME-HT-9F3K2Q.",
].join(" ");

const CONTEXT = {
  companyId: "11111111-1111-1111-1111-111111111111",
  employeeHash: "emp_0123456789abcdef",
  aiTool: "chatgpt.com",
  department: "Finance",
  action: "redacted",
};

function scanSensitive() {
  D.reset();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  D.setCustomKeywords(["Project Northstar"]);
  return D.scan(SENSITIVE_MESSAGE);
}

test("the sensitive message is actually detected (guards the tests below)", () => {
  const r = scanSensitive();
  assert.equal(r.riskLevel, "High");
  assert.equal(r.confirmedLeak, true);
  assert.ok(r.patternTypes.length >= 6, "expected a rich match set, got " + r.patternTypes.join(","));
});

test("NO sensitive value from the original message appears in the outbound payload", () => {
  const scan = scanSensitive();
  const payload = EP.buildEventPayload(scan, CONTEXT);
  const serialised = JSON.stringify(payload);

  // The actual data the employee typed — none of it may travel.
  const mustNotAppear = [
    "4111", "1111 1111", "ABCDE1234F", "9876543210",
    "priya.sharma@acmecorp.in", "priya", "AKIAIOSFODNN7EXAMPLE",
    "192.168.10.5", "ACME-HT-9F3K2Q",
    // The matched keyword phrases themselves, as distinct from the
    // category names that describe them.
    "cap table", "arbitration clause", "internal only",
  ];

  for (const fragment of mustNotAppear) {
    assert.equal(
      serialised.toLowerCase().includes(fragment.toLowerCase()),
      false,
      `payload leaked the fragment "${fragment}": ${serialised}`
    );
  }
});

/**
 * The stronger form of the guarantee. Rather than blacklisting fragments
 * we happen to think of, this asserts the payload is composed ENTIRELY of
 * values drawn from a closed vocabulary fixed at build time. A payload
 * that can only contain pre-declared tokens cannot contain a message,
 * whatever that message says.
 *
 * Note this is why `pattern_types` may contain "confidentialityMarker"
 * even when the employee typed the word "CONFIDENTIAL": the payload names
 * the CATEGORY, which existed before the message did. It does not report
 * the word that was typed, where it appeared, or what surrounded it.
 */
test("every string in the payload comes from a closed, pre-declared vocabulary", () => {
  const P = require("../src/core/patterns.js");
  const scan = scanSensitive();
  const payload = EP.buildEventPayload(scan, CONTEXT);

  const FRAMEWORKS = [...new Set([...Object.values(P.COMPLIANCE_MAP), P.DEFAULT_FRAMEWORK])];

  const allowedValues = new Set([
    // supplied by the caller's own identity/context, not by the message
    CONTEXT.companyId, CONTEXT.employeeHash, CONTEXT.aiTool, payload.timestamp,
    // closed enums
    ...P.ALL_PATTERN_TYPES, ...FRAMEWORKS,
    ...EP.ALLOWED_ACTIONS, ...EP.ALLOWED_FP_REASONS, ...EP.ALLOWED_DEPARTMENTS,
    "Low", "Medium", "High", "Warn", "MandatoryRedaction", "text", "file",
  ]);

  const offenders = [];
  const walk = (value, path) => {
    if (typeof value === "string" && !allowedValues.has(value)) offenders.push(`${path} = ${value}`);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
  };
  Object.keys(payload).forEach((k) => walk(payload[k], k));

  assert.deepEqual(offenders, [], "payload contained values outside the closed vocabulary");
});

test("payload carries only schema-allowed fields", () => {
  const payload = EP.buildEventPayload(scanSensitive(), CONTEXT);
  assert.deepEqual(EP.assertNoContentLeak(payload), []);
  for (const key of Object.keys(payload)) {
    assert.ok(EP.ALLOWED_KEYS.includes(key), "unexpected key: " + key);
  }
});

test("match.value never reaches the payload even if added to the scan result", () => {
  const scan = scanSensitive();
  // Simulate a future bug: someone attaches raw text to the scan result.
  scan.rawText = SENSITIVE_MESSAGE;
  scan.debugMatches = scan.matches.map((m) => m.value);

  const payload = EP.buildEventPayload(scan, CONTEXT);
  const serialised = JSON.stringify(payload);

  assert.equal(payload.rawText, undefined);
  assert.equal(payload.debugMatches, undefined);
  assert.equal(serialised.includes("4111"), false);
});

test("an unknown action is coerced, not passed through as free text", () => {
  const payload = EP.buildEventPayload(scanSensitive(), {
    ...CONTEXT,
    action: "here is the full message the user typed",
  });
  assert.equal(payload.action, "warned");
});

test("an unknown false-positive reason is coerced to null", () => {
  const payload = EP.buildEventPayload(scanSensitive(), {
    ...CONTEXT,
    action: "marked_false_positive",
    falsePositiveReason: "actually it was about our client Foobar Industries",
  });
  assert.equal(payload.false_positive_reason, null);
});

test("an unknown department is coerced to Unspecified", () => {
  const payload = EP.buildEventPayload(scanSensitive(), { ...CONTEXT, department: "Priya's team" });
  assert.equal(payload.department, "Unspecified");
});

test("a long, sensitive filename is truncated before transmission", () => {
  const scan = scanSensitive();
  const payload = EP.buildEventPayload(scan, {
    ...CONTEXT,
    source: "file",
    fileName: "Q3-layoff-list-final-with-severance-amounts-and-employee-names-confidential.xlsx",
    fileType: "xlsx",
  });
  assert.ok(payload.file_name.length <= 64, "got: " + payload.file_name);
  assert.ok(payload.file_name.endsWith(".xlsx"), "extension preserved for IT triage");
});

test("file fields are null for text events", () => {
  const payload = EP.buildEventPayload(scanSensitive(), { ...CONTEXT, fileName: "x.pdf", fileType: "pdf" });
  assert.equal(payload.source, "text");
  assert.equal(payload.file_name, null);
  assert.equal(payload.file_type, null);
});

test("pattern_types and compliance_frameworks stay short identifiers (DB CHECK parity)", () => {
  const payload = EP.buildEventPayload(scanSensitive(), CONTEXT);
  assert.ok(payload.pattern_types.length <= 32);
  payload.pattern_types.forEach((t) => assert.ok(t.length <= 40, t));
  payload.compliance_frameworks.forEach((f) => assert.ok(f.length <= 60, f));
});

test("redaction preview stays local: it is present on the scan, absent from the payload", () => {
  const scan = scanSensitive();
  assert.ok(scan.redactedText.length > 0, "the UI needs this");
  const payload = EP.buildEventPayload(scan, CONTEXT);
  assert.equal(payload.redactedText, undefined);
  assert.equal(JSON.stringify(payload).includes("REDACTED]"), false);
});
