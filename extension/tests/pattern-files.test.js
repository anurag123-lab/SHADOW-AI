/* eslint-disable */
/**
 * Pattern-coverage files (demo-files/pattern-tests/).
 *
 * One realistic document per scenario — payroll export, invoice, clinic
 * referral, deploy config, secrets file, deal notes, HR notes, board memo,
 * server log, honeytoken leak, and a near-miss file that must stay clean.
 * Together they exercise every pattern type the detector knows, so a
 * change that silently stops one category firing fails here, not on stage.
 *
 * Verdicts are checked under DEFAULT policy. Dashboard overrides (e.g.
 * PAN lowered to Warn) change the live tier, not what is detected.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const D = require("../src/core/detector.js");
const P = require("../src/core/patterns.js");
const { FILES } = require("../../scripts/make-pattern-tests.js");

const DIR = path.join(__dirname, "..", "..", "demo-files", "pattern-tests");

function scan(file, keywords) {
  D.reset();
  D.setHoneytokens(["ACME-HT-9F3K2Q"]);
  if (keywords) D.setCustomKeywords(keywords);
  return D.scan(file.lines.join("\n"));
}

for (const file of FILES) {
  test(`${file.name}: ${file.what}`, () => {
    const r = scan(file);
    assert.equal(r.overallTier, file.expect.tier, `tier; detected [${r.patternTypes.join(", ")}]`);
    for (const t of file.expect.types) {
      assert.ok(r.patternTypes.includes(t), `expected ${t}, got [${r.patternTypes.join(", ")}]`);
    }
    assert.equal(r.confirmedLeak, !!file.expect.leak);
  });
}

test("northstar-update.md fires only once the custom keyword is configured", () => {
  const file = FILES.find((f) => f.name === "northstar-update.md");
  assert.equal(scan(file).overallTier, null);
  const r = scan(file, file.withKeywords.keywords);
  assert.equal(r.overallTier, "Warn");
  assert.deepEqual(r.patternTypes, ["customKeyword"]);
});

test("together the files cover every pattern type the detector knows", () => {
  const seen = new Set();
  for (const file of FILES) {
    scan(file, file.withKeywords && file.withKeywords.keywords).patternTypes.forEach((t) => seen.add(t));
  }
  const missing = P.ALL_PATTERN_TYPES.filter((t) => !seen.has(t));
  assert.deepEqual(missing, [], "no file exercises: " + missing.join(", "));
});

test("the plain-text files on disk match their definitions (not stale)", () => {
  for (const file of FILES.filter((f) => f.kind === "text")) {
    const p = path.join(DIR, file.name);
    assert.ok(fs.existsSync(p), `${file.name} missing — run: npm run demo:patterns`);
    assert.equal(fs.readFileSync(p, "utf8"), file.lines.join("\n") + "\n", `${file.name} is stale — run: npm run demo:patterns`);
  }
});
