/* eslint-disable */
/**
 * A heuristic match must never hide a named one.
 *
 * Config lines are the commonest way keys get pasted:
 *   STRIPE_SECRET_KEY=sk_live_...
 * The whole line is one high-entropy token that starts BEFORE the key, so
 * the generic (Warn) match used to win the overlap and a live key was
 * reported as a soft warning instead of a Mandatory credential.
 *
 * Keys are assembled at runtime so no secret-shaped literal is stored in
 * the repository.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/core/detector.js");

const STRIPE = "sk" + "_live_" + "51TestOnlyabcdefghijklmnopqrstuvwxyz0123";
const OPENAI = "sk-" + "proj-" + "TestOnlyAbCdEf1234567890GhIjKlMn";
const GITHUB = "ghp" + "_" + "16C7e42F292c6912E7710c838347Ae178B4a";

function scan(t) { D.reset(); return D.scan(t); }

for (const [name, line] of [
  ["Stripe key in an .env line", "STRIPE_SECRET_KEY=" + STRIPE],
  ["OpenAI key in an .env line", "OPENAI_API_KEY=" + OPENAI],
  ["GitHub token in an .env line", "GITHUB_TOKEN=" + GITHUB],
  ["key in a JSON config", '{"stripe":"' + STRIPE + '"}'],
]) {
  test(name + " is reported as a live API key (Mandatory)", () => {
    const r = scan(line);
    assert.ok(r.patternTypes.includes("apiKey"), "got " + r.patternTypes.join(","));
    assert.ok(!r.patternTypes.includes("genericSecret"), "the heuristic must not hide the named match");
    assert.equal(r.overallTier, "MandatoryRedaction");
  });
}

test("an unknown random token is still caught by the heuristic", () => {
  const r = scan("token 7Kx9mPq2LvR4nT8wZ3bY6cF1jH5gD0sA");
  assert.deepEqual(r.patternTypes, ["genericSecret"]);
});

test("the redacted .env line keeps its variable name", () => {
  const r = scan("STRIPE_SECRET_KEY=" + STRIPE);
  assert.ok(r.redactedText.startsWith("STRIPE_SECRET_KEY="), r.redactedText);
  assert.ok(!r.redactedText.includes(STRIPE));
});
