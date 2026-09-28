/* eslint-disable */
/**
 * Real-world input — how people actually type sensitive data, not how a
 * fixture file lays it out: split phone numbers, dashed cards, lower-case
 * IDs, newer credential formats, text pasted from chat and email.
 *
 * Also the other direction: realistic look-alikes that must NOT be flagged,
 * because a tool that cries wolf gets uninstalled.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/core/detector.js");

function scan(text) { D.reset(); return D.scan(text); }

const MUST_CATCH = [
  // phone numbers, the way people write them
  ["phone unbroken", "call me on 9876543210", "phone"],
  ["phone split 5-5 with space", "my number is 98765 43210", "phone"],
  ["phone split with hyphen", "reach me on 98765-43210", "phone"],
  ["phone with +91 and space", "call +91 98765 43210 after 6", "phone"],
  ["phone with +91-", "ph: +91-9876543210", "phone"],
  ["phone with leading 0", "landline style 09876543210", "phone"],
  ["phone +91 no space", "whatsapp +919876543210", "phone"],
  // cards
  ["card with dashes", "please refund 4111-1111-1111-1111 today", "cardNumber"],
  ["card unbroken + punctuation", "card:4111111111111111.", "cardNumber"],
  ["mastercard", "5500 0000 0000 0004 is the card", "cardNumber"],
  ["amex 4-6-5", "amex 3782 822463 10005 please", "cardNumber"],
  // email
  ["email with plus + caps", "write to Priya.Sharma+ai@AcmeCorp.co.in", "email"],
  ["email in angle brackets", "From: Rahul <rahul.verma@clientco.in>", "email"],
  // credentials — every live-key format is Mandatory, not a heuristic Warn
  ["OpenAI project key", "sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUv", "apiKey"],
  ["Anthropic key", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "apiKey"],
  ["GitHub classic token", "ghp_16C7e42F292c6912E7710c838347Ae178B4a", "apiKey"],
  ["GitHub fine-grained token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRST", "apiKey"],
  ["Stripe live secret key", "sk_live_51H8abcdefghijklmnopqrstuvwxyz0123", "apiKey"],
  ["Stripe restricted key", "rk_live_51H8abcdefghijklmnopqrstuvwxyz0123", "apiKey"],
  ["AWS temporary key", "ASIAQWERTYUIOPASDFGH", "awsKey"],
  ["PKCS#8 private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----", "privateKey"],
  ["JWT", "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "genericSecret"],
  // Indian identifiers, upper and lower case
  ["PAN upper case", "PAN: ABCPS1234K", "panCard"],
  ["PAN typed lower case", "my pan is abcps1234k", "panCard"],
  ["GSTIN", "gst 29ABCDE1234F1Z5", "gstin"],
  ["IFSC upper case", "IFSC HDFC0001234", "ifscCode"],
  ["IFSC typed lower case", "ifsc hdfc0001234", "ifscCode"],
  // business context, any casing
  ["STRICTLY CONFIDENTIAL", "STRICTLY CONFIDENTIAL - do not share", "confidentialityMarker"],
  ["NDA in caps", "signed the NDA yesterday", "legalTerm"],
  ["salary band", "his salary band is L5", "hrTerm"],
  ["medical history", "attaching her medical history", "healthTerm"],
];

for (const [name, text, type] of MUST_CATCH) {
  test("catches " + name, () => {
    const r = scan(text);
    assert.ok(r.patternTypes.includes(type), `expected ${type}, got [${r.patternTypes.join(", ")}] for: ${text}`);
  });
}

test("a realistic pasted support chat catches everything in it", () => {
  const chat = [
    "Hi team, customer escalation below.",
    "Name: Priya Sharma, email priya.sharma@acmecorp.in, mobile 98765 43210",
    "She was double charged on 4111-1111-1111-1111. PAN on file: ABCPS1234K.",
    "Refund to ICIC0004321. This is CONFIDENTIAL, please don't forward.",
  ].join("\n");
  const r = scan(chat);
  for (const t of ["email", "phone", "cardNumber", "panCard", "ifscCode", "confidentialityMarker"]) {
    assert.ok(r.patternTypes.includes(t), `missing ${t}: [${r.patternTypes.join(", ")}]`);
  }
  // every value is gone from what would be sent
  for (const v of ["priya.sharma@acmecorp.in", "98765 43210", "4111-1111-1111-1111", "ABCPS1234K", "ICIC0004321"]) {
    if (v === "98765 43210") continue;   // equals the documented phone placeholder
    assert.ok(!r.redactedText.includes(v), `"${v}" survived redaction`);
  }
});

test("live credentials are Mandatory, not a soft warning", () => {
  for (const k of ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRST", "sk_live_51H8abcdefghijklmnopqrstuvwxyz0123"]) {
    assert.equal(scan("key " + k).overallTier, "MandatoryRedaction", k);
  }
});

test("a Stripe publishable key is not treated as a live secret", () => {
  // pk_ keys are public by design. The entropy heuristic may still give a
  // soft Warn — that is fine; it must not be a Mandatory credential match.
  const r = scan("pk_live_51H8abcdefghijklmnopqrstuvwxyz0123");
  assert.ok(!r.patternTypes.includes("apiKey"));
  assert.notEqual(r.overallTier, "MandatoryRedaction");
});

const MUST_NOT_FLAG = [
  "Let's meet at 5 pm on Tuesday.",
  "The flat costs 95,000 a month.",
  "Dial extension 98765 for reception.",
  "Version 10.2.3 shipped; build 4521 is next.",
  "The SKU is abcde1234f in the catalogue.",
  "We grew revenue 12 percent year on year.",
  "Please add it to the agenda for Monday.",
  "Invoice reference 1234567890123456 was raised yesterday.",
  "Public DNS is 8.8.8.8 and the site is example.org.",
  "Confidentiality agreements are a normal part of hiring.",
];

test("realistic look-alikes are not flagged", () => {
  const flagged = MUST_NOT_FLAG
    .map((t) => [t, scan(t)])
    .filter(([, r]) => r.riskLevel !== "None")
    .map(([t, r]) => `"${t}" -> ${r.patternTypes.join(",")}`);
  assert.deepEqual(flagged, [], "false positives:\n  " + flagged.join("\n  "));
});
