/* eslint-disable */
/**
 * Entropy-based secret detection (the backstop for unknown credentials).
 *
 * The interesting half of this file is the NEGATIVE corpus. Entropy
 * detection is easy to make catch things; the engineering is in making it
 * not fire on git SHAs, UUIDs, URLs and base64 blobs, which engineers
 * paste into AI tools constantly. A rule that cries wolf on a commit hash
 * gets the whole extension uninstalled by lunchtime.
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
 * The entropy function itself
 * =================================================================== */
test("shannonEntropy separates random data from prose", () => {
  const random = P.shannonEntropy("xK9mPq2LvR7nT4wZ8bY6cF3jH5gD1sA0");
  // Real prose repeats letters heavily. (A pangram would be a bad fixture
  // here — every letter exactly once makes it look maximally random.)
  const prose = P.shannonEntropy("pleasereviewthequarterlyreportbeforefridayafternoon");
  const repeated = P.shannonEntropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  assert.ok(random > 4.5, `random scored ${random.toFixed(2)}`);
  assert.ok(random > prose + 0.4, `random ${random.toFixed(2)} vs prose ${prose.toFixed(2)}`);
  assert.equal(repeated, 0, "a single repeated character carries no information");
  assert.equal(P.shannonEntropy(""), 0);
});

/* =================================================================== *
 * POSITIVE — secrets no prefix rule would catch
 * =================================================================== */
const SHOULD_FLAG = [
  ["internal service token", "auth token for the billing service: 7Kx9mPq2LvR4nT8wZ3bY6cF1jH5gD0sA"],
  ["generated password", "temp password is Xk92MnPq47LvRt83WzBy6cFj for the staging box"],
  ["rotated key, unknown prefix", "new key acme_v2_9KxmPq2LvR7nT4wZ8bY6cF3jH5gD1sA0zQ"],
  ["base64url token", "bearer eyJhbGc9-_xK9mPq2LvR7nT4wZ8bY6cF3jH5gD1sA0Qw"],
  ["long hex secret (not a digest length)", "secret: a3f9c2e8b1d7a4f6c9e2b8d1a7f4c6e9b2d8"],
];

for (const [why, text] of SHOULD_FLAG) {
  test(`flags ${why}`, () => {
    fresh();
    const r = D.scan(text);
    assert.ok(
      r.patternTypes.includes("genericSecret"),
      `expected genericSecret, got [${r.patternTypes.join(", ")}] for: ${text}`
    );
  });
}

/* =================================================================== *
 * NEGATIVE — technical strings that must NOT flag
 * =================================================================== */
const MUST_NOT_FLAG = [
  ["git SHA-1 commit hash", "reverted in 9f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a"],
  ["SHA-256 checksum", "sha256 is 4f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c8d7e6f5a4b3c2d1e0f9a"],
  ["UUID", "the request id was 550e8400-e29b-41d4-a716-446655440000"],
  ["uppercase UUID", "trace 550E8400-E29B-41D4-A716-446655440000 in the logs"],
  ["long URL", "see https://docs.example.com/guides/getting-started/configuration/advanced"],
  ["file path", "it lives in src/components/dashboard/widgets/ActivityChartContainer.tsx"],
  ["long word", "the word antidisestablishmentarianism has no digits in it"],
  ["repeated placeholder", "replace XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX with the real value"],
  ["version-ish identifier", "build 2024-10-release-candidate-3 shipped"],
  ["class name", "the AbstractSingletonProxyFactoryBean is doing too much"],
  ["numeric id run", "order 100200300400500600700800900 was cancelled"],
  ["readable slug", "post slug is how-to-configure-your-deployment-pipeline-2024"],
];

for (const [why, text] of MUST_NOT_FLAG) {
  test(`does NOT flag ${why}`, () => {
    fresh();
    const r = D.scan(text);
    const hits = r.matches.filter((m) => m.type === "genericSecret").map((m) => m.value);
    assert.equal(
      hits.length,
      0,
      `false positive on ${why}: ${JSON.stringify(hits)}`
    );
  });
}

/* =================================================================== *
 * Interaction with the named patterns
 * =================================================================== */
test("a known API key reports as apiKey, not as a generic blob", () => {
  fresh();
  const r = D.scan("my key is sk-proj-abc123XYZ456def789GHI012jkl for the test");
  assert.ok(r.patternTypes.includes("apiKey"), "should name the vendor pattern");
  const spans = r.matches.filter((m) => m.value.includes("sk-proj"));
  assert.equal(spans.length, 1, "the same span must not be reported twice");
  assert.equal(spans[0].type, "apiKey", `reported as ${spans[0].type}`);
});

test("an AWS key still reports as awsKey", () => {
  fresh();
  const r = D.scan("creds AKIAIOSFODNN7EXAMPLE need rotating");
  assert.ok(r.patternTypes.includes("awsKey"));
});

test("entropy match defaults to Warn so a heuristic is always overridable", () => {
  fresh();
  const r = D.scan("token 7Kx9mPq2LvR4nT8wZ3bY6cF1jH5gD0sA");
  assert.equal(r.overallTier, "Warn");
  assert.equal(r.riskLevel, "High");
});

test("IT can promote entropy matches to mandatory via the policy engine", () => {
  fresh();
  D.setPolicyOverrides({ genericSecret: "MandatoryRedaction" });
  const r = D.scan("token 7Kx9mPq2LvR4nT8wZ3bY6cF1jH5gD0sA");
  assert.equal(r.overallTier, "MandatoryRedaction");
});

test("entropy matches redact cleanly", () => {
  fresh();
  const r = D.scan("use 7Kx9mPq2LvR4nT8wZ3bY6cF1jH5gD0sA to connect");
  assert.ok(r.redactedText.includes("[SECRET REDACTED]"));
  assert.ok(!r.redactedText.includes("7Kx9mPq2"));
  assert.ok(r.redactedText.startsWith("use "));
  assert.ok(r.redactedText.endsWith(" to connect"));
});

test("genericSecret carries a compliance mapping", () => {
  assert.equal(P.COMPLIANCE_MAP.genericSecret, "Internal Security Policy");
  assert.ok(P.ALL_PATTERN_TYPES.includes("genericSecret"));
});

/* =================================================================== *
 * The documented trade-off, asserted so it can't be changed by accident
 * =================================================================== */
test("digest-length hex is deliberately excluded (SHA-1 / SHA-256)", () => {
  assert.equal(P.isHighEntropySecret("9f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a"), false, "40-char SHA-1");
  assert.equal(
    P.isHighEntropySecret("4f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c8d7e6f5a4b3c2d1e0f9a"),
    false,
    "64-char SHA-256"
  );
  // But a hex string of an uncommon length is still a candidate.
  assert.equal(P.isHighEntropySecret("a3f9c2e8b1d7a4f6c9e2b8d1a7f4c6e9b2d8"), true, "36-char hex");
});
