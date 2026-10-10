// Plain-text passwords / secrets in notes and config ("db password: ...").
// Reported as genericSecret (Warn by default) — and code that merely
// mentions a password must NOT be flagged.
const test = require("node:test");
const assert = require("node:assert");
const D = require("../src/core/detector.js");

const hasSecret = (s) => { D.reset(); return D.scan(s).matches.some((m) => m.type === "genericSecret"); };

const CAUGHT = [
  "db password: Sup3rS3cret!2024",
  "DB_PASS=hunter2024",
  'password = "Tr0ub4dor&3"',
  "admin pwd is Welcome@123",
  "prod api key: 9f8e7d6c5b4a3928",
  "client_secret: aX9-77fQ",
];
const IGNORED = [
  "password: req.body.password",
  "password: string",
  "password: z.string().min(8)",
  "password=${DB_PASS}",
  "password: process.env.DB_PASS",
  "password: changeme",
  "password: ********",
  "passwordHash = bcrypt.hash(pw)",
  "Reset your password to continue",
  "const password = getPassword();",
  'type="password" name="pass"',
  "apiKey: config.apiKey",
  "secret: <your-secret>",
];

for (const s of CAUGHT) test(`flags plain-text credential: ${s.split(/[:=]| is /)[0].trim()}`, () => assert.ok(hasSecret(s)));
for (const s of IGNORED) test(`ignores code / placeholder: ${s}`, () => assert.ok(!hasSecret(s)));

test("only the value is redacted, the label stays", () => {
  D.reset();
  const text = "db password: Sup3rS3cret!2024";
  const out = D.redact(text, D.scan(text).matches);
  assert.ok(out.includes("db password:") && !out.includes("Sup3rS3cret"), out);
});

test("defaults to Warn (a heuristic is never mandatory unless IT promotes it)", () => {
  D.reset();
  const m = D.scan("db password: Sup3rS3cret!2024").matches.find((x) => x.type === "genericSecret");
  assert.equal(m.tier, "Warn");
});

test("a vendor key after a label is still reported as an API key", () => {
  D.reset();
  const key = "sk" + "_live_" + "51TestOnlyabcdefghijklmnopqrstuvwxyz0123";
  const types = D.scan("api key: " + key).matches.map((m) => m.type);
  assert.deepEqual(types, ["apiKey"]);
});
