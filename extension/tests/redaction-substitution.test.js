/* eslint-disable */
/**
 * Realistic-value redaction (the feature added on top of the original
 * bracket-tag design).
 *
 * The design split, and why it isn't "replace everything with a fake
 * value":
 *
 *   STRUCTURED DATA (card numbers, emails, phone numbers, PANs, GSTINs,
 *   IFSC codes, IPs, AWS/API keys) has a well-known, industry-recognized
 *   "this is definitely fake" convention — Stripe's test card, RFC 2606's
 *   example.com, AWS's own documented EXAMPLE key, RFC 5737's
 *   documentation-only IP block. Swapping in one of these lets the
 *   sentence stay grammatical ("my card is 4242 4242 4242 4242, please
 *   help") instead of interrupting flow with a bracket tag, and the AI
 *   tool isn't confused by seeing [CARD NUMBER REDACTED] embedded
 *   mid-sentence.
 *
 *   BUSINESS-CONTEXT PHRASES (confidentiality markers, legal terms, HR
 *   terms, IP terms, health terms, custom keywords) and CONFIRMED LEAKS
 *   (honeytokens) have no such convention — there is no safe "fake trade
 *   secret" to substitute, and a confirmed leak should stay unambiguous
 *   rather than quietly blend into plausible text. These keep the
 *   explicit [X REMOVED] bracket tag.
 *
 * This file also locks in the mechanism that makes fake-value redaction
 * safe to preview: redactionSpans. The old preview UI found substitutions
 * by regex-scanning the OUTPUT text for bracket syntax — which silently
 * stops working the moment a substitution doesn't use brackets. Spans are
 * computed while building the string, so highlighting never depends on
 * what the substitute text looks like.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/core/detector.js");

function fresh() {
  D.reset();
  return D;
}

/* =================================================================== *
 * Table-driven: every structured pattern gets its documented fake value
 * =================================================================== */
const STRUCTURED_SUBSTITUTIONS = [
  ["cardNumber", "my card is 4111 1111 1111 1111 please", "4111", "4242 4242 4242 4242"],
  ["email", "reach me at priya.sharma@acmecorp.in thanks", "priya.sharma@acmecorp.in", "jane.doe@example.com"],
  ["phone", "call me on 9876543210 today", "9876543210", "98765 43210"],
  ["panCard", "his PAN is ABCDE1234F on file", "ABCDE1234F", "ABCDE1234F"], // dummy IS the real fixture value (no distinct original in this case, see note below)
  ["gstin", "invoice GSTIN 27AAPFU0939F1ZV attached", "27AAPFU0939F1ZV", "22AAAAA0000A1Z5"],
  ["ifscCode", "branch code HDFC0009999 for transfer", "HDFC0009999", "HDFC0001234"],
  ["ipAddress", "the box at 192.168.1.44 is down", "192.168.1.44", "192.0.2.1"],
  ["awsKey", "rotate AKIAZZZZZZZZZZZZZZZZ please", "AKIAZZZZZZZZZZZZZZZZ", "AKIAIOSFODNN7EXAMPLE"],
  ["apiKey", "key is sk-proj-abc123XYZ456def789GHI012jkl", "sk-proj-abc123XYZ456def789GHI012jkl", "sk-EXAMPLE0000000000000000000000000000"],
];

for (const [type, text, original, fake] of STRUCTURED_SUBSTITUTIONS) {
  test(`${type}: redacts to the documented fake value, not a bracket tag`, () => {
    fresh();
    const r = D.scan(text);
    assert.ok(r.patternTypes.includes(type), `expected ${type} to be detected in: ${text}`);
    assert.ok(r.redactedText.includes(fake), `expected fake value "${fake}" in: ${r.redactedText}`);
    assert.ok(!r.redactedText.includes(original) || original === fake,
      `original value "${original}" should not survive redaction: ${r.redactedText}`);
    assert.ok(!/\[[A-Z ]+(REDACTED|REMOVED)\]/.test(r.redactedText),
      `structured pattern ${type} must not use bracket-tag syntax: ${r.redactedText}`);
  });
}

/* =================================================================== *
 * Business-context phrases and confirmed leaks: still bracket-tagged
 * =================================================================== */
const BRACKET_TAG_KEPT = [
  ["confidentialityMarker", "this memo is CONFIDENTIAL, share carefully", "[CONFIDENTIALITY MARKER REMOVED]"],
  ["legalTerm", "the arbitration clause needs review", "[LEGAL TERM REMOVED]"],
  ["hrTerm", "her CTC was revised", "[HR TERM REMOVED]"],
  ["corporateStrategyTerm", "the cap table changed", "[STRATEGY TERM REMOVED]"],
  ["ipTerm", "that is a trade secret", "[IP TERM REMOVED]"],
  ["healthTerm", "attach the medical record", "[HEALTH TERM REMOVED]"],
];

for (const [type, text, tag] of BRACKET_TAG_KEPT) {
  test(`${type}: keeps the explicit bracket tag (no safe fake equivalent)`, () => {
    fresh();
    const r = D.scan(text);
    assert.ok(r.patternTypes.includes(type));
    assert.ok(r.redactedText.includes(tag), `expected "${tag}" in: ${r.redactedText}`);
  });
}

test("privateKey: EXCEPTION — stays a bracket tag (no safe 'fake PEM' convention)", () => {
  fresh();
  const r = D.scan("-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAK\n-----END RSA PRIVATE KEY-----");
  assert.ok(r.redactedText.includes("[PRIVATE KEY REMOVED]"), r.redactedText);
});

test("honeytoken: confirmed leak stays an explicit tag, never disguised as ordinary data", () => {
  fresh();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  const r = D.scan("the reference was ACME-HT-9F3K2Q on the sheet");
  assert.ok(r.redactedText.includes("[TRACKED IDENTIFIER REMOVED]"), r.redactedText);
  assert.ok(!r.redactedText.includes("ACME-HT-9F3K2Q"));
});

test("customKeyword: keeps the explicit bracket tag", () => {
  fresh();
  D.setCustomKeywords(["Project Northstar"]);
  const r = D.scan("update on project northstar please");
  assert.ok(r.redactedText.includes("[COMPANY TERM REMOVED]"), r.redactedText);
});

test("genericSecret (entropy match): keeps the explicit bracket tag", () => {
  fresh();
  const r = D.scan("token 7Kx9mPq2LvR4nT8wZ3bY6cF1jH5gD0sA");
  assert.ok(r.redactedText.includes("[SECRET REDACTED]"), r.redactedText);
});

/* =================================================================== *
 * redactionSpans — the mechanism that makes highlighting robust
 * =================================================================== */
test("redactWithSpans reports the exact [start,end) of each substitution", () => {
  fresh();
  const text = "Hi, my card is 4111 1111 1111 1111 and I need a refund.";
  const { text: redacted, spans } = D.redactWithSpans(text, D.scan(text).matches);

  assert.equal(spans.length, 1);
  const s = spans[0];
  assert.equal(redacted.slice(s.start, s.end), "4242 4242 4242 4242");
  assert.equal(s.type, "cardNumber");
  assert.equal(s.confirmedLeak, false);
});

test("scan() exposes redactionSpans consistent with redactedText", () => {
  fresh();
  const r = D.scan("mail a@b.com and call 9876543210 please");
  assert.equal(r.redactionSpans.length, 2);
  for (const s of r.redactionSpans) {
    const slice = r.redactedText.slice(s.start, s.end);
    assert.ok(slice === "jane.doe@example.com" || slice === "98765 43210",
      `span did not slice out a known substitute: "${slice}"`);
  }
});

test("spans are ordered and non-overlapping even with multiple mixed matches", () => {
  fresh();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  const text = "CONFIDENTIAL: card 4111 1111 1111 1111, email a@b.com, ref ACME-HT-9F3K2Q";
  const r = D.scan(text);

  assert.ok(r.redactionSpans.length >= 3);
  let lastEnd = -1;
  for (const s of r.redactionSpans.slice().sort((a, b) => a.start - b.start)) {
    assert.ok(s.start >= lastEnd, `span overlaps the previous one: start=${s.start} lastEnd=${lastEnd}`);
    assert.ok(s.end <= r.redactedText.length);
    lastEnd = s.end;
  }
});

test("the honeytoken span is flagged confirmedLeak so the UI can style it distinctly", () => {
  fresh();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  const r = D.scan("leaked ACME-HT-9F3K2Q into the chat");
  const htSpan = r.redactionSpans.find((s) => s.type === "honeytoken");
  assert.ok(htSpan, "expected a honeytoken span");
  assert.equal(htSpan.confirmedLeak, true);
});

test("mixed message: structured data gets a fake value, business term keeps its tag, in the SAME output", () => {
  fresh();
  const text = "CONFIDENTIAL: my card is 4111 1111 1111 1111, contact a@b.com";
  const r = D.scan(text);

  assert.ok(r.redactedText.includes("4242 4242 4242 4242"), r.redactedText);
  assert.ok(r.redactedText.includes("jane.doe@example.com"), r.redactedText);
  assert.ok(r.redactedText.includes("[CONFIDENTIALITY MARKER REMOVED]"), r.redactedText);
  assert.ok(!r.redactedText.includes("4111"));
  assert.ok(!r.redactedText.includes("a@b.com"));
});

/* =================================================================== *
 * redact() (the string-only wrapper) still works for existing callers
 * =================================================================== */
test("redact() remains a plain string wrapper around redactWithSpans", () => {
  fresh();
  const text = "call 9876543210 now";
  const matches = D.scan(text).matches;
  assert.equal(D.redact(text, matches), D.redactWithSpans(text, matches).text);
});

test("redact()/redactWithSpans() handle no matches without throwing", () => {
  fresh();
  assert.equal(D.redact("clean text", []), "clean text");
  assert.deepEqual(D.redactWithSpans("clean text", []), { text: "clean text", spans: [] });
});

/* =================================================================== *
 * Privacy boundary: fake values never travel further than the local
 * redaction preview, same guarantee as before this feature existed.
 * =================================================================== */
test("event-payload.js never includes redactedText or redactionSpans, even with fake substitutions present", () => {
  fresh();
  const EP = require("../src/core/event-payload.js");
  const r = D.scan("card 4111 1111 1111 1111 and a@b.com");
  const payload = EP.buildEventPayload(r, {
    companyId: "c", employeeHash: "emp_0123456789abcdef",
    aiTool: "chatgpt.com", department: "Finance", action: "redacted",
  });
  assert.equal(payload.redactedText, undefined);
  assert.equal(payload.redactionSpans, undefined);
  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes("4242 4242 4242 4242"), "fake substitute must not reach the payload either — it is a UI-only value");
  assert.ok(!serialised.includes("jane.doe@example.com"));
});
