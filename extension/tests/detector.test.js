/* eslint-disable */
/**
 * Detector unit tests — run with: npm test
 * Node's built-in test runner. No DOM, no browser, no framework install.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/core/detector.js");
const P = require("../src/core/patterns.js");

function fresh() {
  D.reset();
  return D;
}

/* =================================================================== *
 * Feature 1 — clean text
 * =================================================================== */
test("clean text returns None / null tier", () => {
  fresh();
  const r = D.scan("Can you help me rewrite this paragraph to sound more concise?");
  assert.equal(r.riskLevel, "None");
  assert.equal(r.overallTier, null);
  assert.equal(r.matches.length, 0);
  assert.deepEqual(r.patternTypes, []);
});

test("empty and non-string input is handled", () => {
  fresh();
  for (const input of ["", "   ", null, undefined, 42, {}]) {
    const r = D.scan(input);
    assert.equal(r.riskLevel, "None");
    assert.equal(r.matches.length, 0);
  }
});

/* =================================================================== *
 * Feature 1 — each pattern type in isolation
 * =================================================================== */
const POSITIVE_CASES = [
  ["email", "Please forward it to priya.sharma@acmecorp.in when ready"],
  ["apiKey", "my key is sk-proj-abc123XYZ456def789GHI012jkl for the test"],
  ["apiKey", "token ghp_1234567890abcdefghijklmnopqrstuvwxyz12"],
  ["apiKey", "google key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"],
  ["awsKey", "creds AKIAIOSFODNN7EXAMPLE need rotating"],
  ["cardNumber", "charge it to 4111 1111 1111 1111 please"],
  ["phone", "call me on 9876543210 after lunch"],
  ["ipAddress", "the box at 192.168.1.44 is unreachable"],
  ["ipAddress", "try 10.0.12.7 instead"],
  ["privateKey", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAK\n-----END RSA PRIVATE KEY-----"],
  ["panCard", "his PAN is ABCDE1234F on the form"],
  ["ifscCode", "branch code HDFC0001234 for the transfer"],
  ["gstin", "invoice GSTIN 27AAPFU0939F1ZV attached"],
  ["healthTerm", "attach the medical record before the appointment"],
  ["confidentialityMarker", "This deck is marked INTERNAL ONLY, be careful"],
  ["legalTerm", "the arbitration clause needs review"],
  ["hrTerm", "her CTC was revised last quarter"],
  ["corporateStrategyTerm", "the cap table changes after this round"],
  ["ipTerm", "that counts as a trade secret under the policy"],
];

for (const [type, text] of POSITIVE_CASES) {
  test(`detects ${type}: "${text.slice(0, 40)}..."`, () => {
    fresh();
    const r = D.scan(text);
    assert.ok(
      r.patternTypes.includes(type),
      `expected ${type}, got [${r.patternTypes.join(", ")}]`
    );
    assert.notEqual(r.riskLevel, "None");
    assert.ok(r.matches.every((m) => typeof m.label === "string" && m.label.length > 0),
      "every match must carry a human-readable label (Feature 19)");
  });
}

/* =================================================================== *
 * Feature 1 acceptance — benign corpus, ZERO flags allowed
 * =================================================================== */
const BENIGN_CORPUS = [
  "Can you summarise this article in three bullet points?",
  "Write a polite follow-up email to a client who hasn't replied in a week.",
  "Explain the difference between a stack and a queue with an example.",
  "What's a good title for a blog post about remote work productivity?",
  "Rewrite this sentence so it sounds less formal.",
  "Give me five ideas for a team offsite in Bangalore.",
  "How do I center a div using flexbox?",
  "Translate 'good morning, hope you are well' into Hindi.",
  "What are the pros and cons of using TypeScript on a small project?",
  "Draft a short thank-you note for a customer who left a good review.",
  "Summarise the key themes in this quarter's customer feedback.",
  "Can you make this paragraph about 20 percent shorter?",
  "Suggest a subject line for a newsletter about our new feature.",
  "What does the acronym API stand for in simple terms?",
  "Write a SQL query that counts rows grouped by created date.",
  "Help me structure a 10 minute presentation on team velocity.",
  "What is a reasonable timeline for onboarding a junior developer?",
  "Give me a checklist for reviewing a pull request.",
  "How should I phrase a request for an extension on a deadline?",
  "Explain what a webhook is to someone non-technical.",
  "List common mistakes people make when writing unit tests.",
  "Create a weekly meal plan for someone who works late.",
  "What is the capital of Australia and why isn't it Sydney?",
  "Turn these rough notes into a clean set of meeting minutes.",
  "Suggest three names for an internal tool that tracks deployments.",
  "How do I improve the readability of a long function?",
  "Write a friendly reminder about tomorrow's standup at 10 am.",
  "What's the difference between authentication and authorization?",
  "Recommend a book about product management for beginners.",
  "Explain recursion using an everyday analogy.",
  "Draft an agenda for a 30 minute retrospective.",
  "How many working days are there between March 1 and April 15?",
  "Give feedback on this paragraph's tone, it feels too stiff.",
  "What are good metrics to track for a support team?",
  "Write a one paragraph summary of what our team does.",
  "How do I convert a CSV file into JSON using a script?",
  "Suggest improvements to this error message wording.",
  "What questions should I ask in a user research interview?",
  "Explain the difference between Docker images and containers.",
  "Help me write a short bio for a conference speaker page.",
  "What's a polite way to decline a meeting invitation?",
  "Describe the steps in a typical code review process.",
  "Give me a regex that matches a four digit year.",
  "How do I make this chart easier to read at a glance?",
  "Write a tagline for a productivity app aimed at students.",
  "What is technical debt and how do teams usually manage it?",
  "Summarise the main argument of this opinion piece.",
  "Suggest a folder structure for a small web project.",
  "How do I phrase a status update when a project is delayed?",
  "What are some good icebreaker questions for a new team?",
  "Explain why unit tests should be independent of each other.",
  "Draft a short announcement about our office moving floors.",
  "Order number 100200300 shipped on the 3rd of this month.",
  "The build finished in 1234 seconds which seems slow.",
  "Version 2.10.4 is now live on staging, please retest.",
];

test(`benign corpus (${BENIGN_CORPUS.length} sentences) produces zero flags`, () => {
  fresh();
  const failures = [];
  for (const sentence of BENIGN_CORPUS) {
    const r = D.scan(sentence);
    if (r.riskLevel !== "None") {
      failures.push(`"${sentence}" -> ${r.patternTypes.join(",")} (${r.matches.map((m) => m.value).join(" | ")})`);
    }
  }
  assert.equal(failures.length, 0, "false positives:\n  " + failures.join("\n  "));
  assert.ok(BENIGN_CORPUS.length >= 50, "corpus must hold at least 50 sentences");
});

test("card-number rule does not fire on non-Luhn digit runs", () => {
  fresh();
  const r = D.scan("Invoice reference 1234567890123456 was raised yesterday.");
  assert.ok(!r.patternTypes.includes("cardNumber"));
});

/* =================================================================== *
 * Feature 3 — honeytokens
 * =================================================================== */
test("honeytoken is detected and marked as a confirmed leak", () => {
  fresh();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  const r = D.scan("The reference on that sheet was ACME-HT-9F3K2Q I think");
  assert.ok(r.patternTypes.includes("honeytoken"));
  assert.equal(r.confirmedLeak, true);
  assert.equal(r.overallTier, "MandatoryRedaction");
});

test("honeytoken matching is case-insensitive", () => {
  fresh();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  assert.equal(D.scan("value acme-ht-9f3k2q here").confirmedLeak, true);
});

test("NON-NEGOTIABLE: policy override cannot downgrade a honeytoken", () => {
  fresh();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  // Hostile configuration: explicitly try to weaken honeytoken enforcement.
  D.setPolicyOverrides({ honeytoken: "Warn" });
  const r = D.scan("leaked ACME-HT-9F3K2Q into the chat");
  assert.equal(r.overallTier, "MandatoryRedaction");
  const ht = r.matches.find((m) => m.type === "honeytoken");
  assert.equal(ht.tier, "MandatoryRedaction");
  assert.equal(D.tierFor(ht), "MandatoryRedaction");
});

test("honeytokens shorter than 4 chars are rejected (avoids matching everything)", () => {
  fresh();
  assert.equal(D.setHoneytokens(["ab", "x", "valid-token"]), 1);
});

/* =================================================================== *
 * Feature 8 — policy engine
 * =================================================================== */
test("policy override raises a Warn pattern to MandatoryRedaction", () => {
  fresh();
  const before = D.scan("email me at test.user@example.com");
  assert.equal(before.overallTier, "Warn");

  D.setPolicyOverrides({ email: "MandatoryRedaction" });
  const after = D.scan("email me at test.user@example.com");
  assert.equal(after.overallTier, "MandatoryRedaction");
});

test("policy override lowers a Mandatory pattern to Warn (non-honeytoken only)", () => {
  fresh();
  D.setPolicyOverrides({ cardNumber: "Warn" });
  const r = D.scan("card 4111 1111 1111 1111");
  assert.equal(r.overallTier, "Warn");
});

test("malformed policy values are ignored, not trusted", () => {
  fresh();
  D.setPolicyOverrides({ cardNumber: "Off", email: "allow", apiKey: "MandatoryRedaction" });
  const cfg = D.getConfig();
  assert.deepEqual(cfg.policyOverrides, { apiKey: "MandatoryRedaction" });
  assert.equal(D.scan("card 4111 1111 1111 1111").overallTier, "MandatoryRedaction");
});

/* =================================================================== *
 * Feature 9 — custom keywords
 * =================================================================== */
test("custom keywords are detected case-insensitively at Medium risk", () => {
  fresh();
  D.setCustomKeywords(["Project Northstar"]);
  const r = D.scan("any update on project northstar timelines?");
  assert.ok(r.patternTypes.includes("customKeyword"));
  assert.equal(r.riskLevel, "Medium");
  assert.equal(r.overallTier, "Warn");
});

test("custom keyword tier is controllable via the policy engine", () => {
  fresh();
  D.setCustomKeywords(["Project Northstar"]);
  D.setPolicyOverrides({ customKeyword: "MandatoryRedaction" });
  assert.equal(D.scan("project northstar update").overallTier, "MandatoryRedaction");
});

test("keyword matching respects word boundaries", () => {
  fresh();
  // "nda" is a legal term; "agenda" and "Panda" must not trip it.
  const r = D.scan("Please add it to the agenda, and bring the Panda mug.");
  assert.ok(!r.patternTypes.includes("legalTerm"), "matched: " + JSON.stringify(r.matches.map(m => m.value)));
});

/* =================================================================== *
 * Redaction (Features 4, 5, 7)
 * =================================================================== */
test("structured data is redacted to a realistic FAKE value, not a bracket tag", () => {
  fresh();
  const text = "Hi, my card is 4111 1111 1111 1111 and I need a refund today.";
  const r = D.scan(text);
  // The fake substitute (Stripe's public test card) reads naturally in the sentence.
  assert.ok(r.redactedText.includes("4242 4242 4242 4242"), r.redactedText);
  assert.ok(r.redactedText.startsWith("Hi, my card is "));
  assert.ok(r.redactedText.endsWith(" and I need a refund today."));
  // The ORIGINAL card number must not survive.
  assert.ok(!r.redactedText.includes("4111"));
  // No bracket-tag syntax should appear for a structured-data match.
  assert.ok(!r.redactedText.includes("[CARD NUMBER"));
});

test("a keyword/business-term match still uses an explicit bracket tag", () => {
  fresh();
  const text = "This document is CONFIDENTIAL, please do not forward.";
  const r = D.scan(text);
  // No safe 'fake confidential marker' exists, so this stays an explicit tag —
  // unlike structured PII, there's nothing natural to substitute it with.
  assert.ok(r.redactedText.includes("[CONFIDENTIALITY MARKER REMOVED]"), r.redactedText);
  assert.ok(!r.redactedText.toUpperCase().includes("CONFIDENTIAL,"));
});

test("multiple matches in one message are all redacted", () => {
  fresh();
  // A DIFFERENT AWS-shaped key than our own EXAMPLE placeholder, so this
  // test can distinguish 'original value gone' from 'placeholder present'
  // instead of the two coincidentally being the same string.
  const r = D.scan("mail a@b.com and call 9876543210 about AKIAZZZZZZZZZZZZZZZZ");
  assert.ok(!r.redactedText.includes("a@b.com"));
  assert.ok(!r.redactedText.includes("9876543210"));
  assert.ok(!r.redactedText.includes("AKIAZZZZZZZZZZZZZZZZ"));
  // Realistic placeholders take their place.
  assert.ok(r.redactedText.includes("jane.doe@example.com"), r.redactedText);
  assert.ok(r.redactedText.includes("98765 43210"), r.redactedText);
  assert.ok(r.redactedText.includes("AKIAIOSFODNN7EXAMPLE"), r.redactedText);
  assert.equal(r.riskLevel, "High");
});

test("overlapping matches do not corrupt the redacted output", () => {
  fresh();
  D.setHoneytokens(["4111111111111111"]);
  const r = D.scan("value 4111111111111111 here");
  assert.equal(r.redactedText.indexOf("4111"), -1);
  assert.equal(r.confirmedLeak, true);
});

/* =================================================================== *
 * Feature 16 — compliance tagging
 * =================================================================== */
test("compliance frameworks are derived from matched pattern types", () => {
  fresh();
  const r = D.scan("card 4111 1111 1111 1111 for user a@b.com with medical record attached");
  assert.ok(r.complianceFrameworks.includes("PCI DSS"));
  assert.ok(r.complianceFrameworks.includes("GDPR"));
  assert.ok(r.complianceFrameworks.includes("HIPAA"));
});

test("unmapped business patterns fall back to Internal Policy", () => {
  fresh();
  const r = D.scan("the board minutes are attached");
  assert.deepEqual(r.complianceFrameworks, ["Internal Policy"]);
});

/* =================================================================== *
 * Robustness
 * =================================================================== */
test("very large input is truncated rather than freezing the tab", () => {
  fresh();
  const big = "lorem ipsum ".repeat(30000) + " a@b.com";
  const started = Date.now();
  const r = D.scan(big);
  assert.ok(Date.now() - started < 2000, "scan must stay well under the debounce budget");
  assert.equal(r.truncated, true);
});

test("scan is synchronous and returns a plain object", () => {
  fresh();
  const r = D.scan("a@b.com");
  assert.ok(!(r instanceof Promise));
  assert.equal(typeof r.riskLevel, "string");
});

test("every pattern type declares a compliance mapping or inherits the default", () => {
  for (const type of P.ALL_PATTERN_TYPES) {
    const framework = P.COMPLIANCE_MAP[type] || P.DEFAULT_FRAMEWORK;
    assert.ok(typeof framework === "string" && framework.length > 0, type);
  }
});
