/**
 * Proves multi-user isolation actually works — not by reading the RLS
 * policies and reasoning about them, but by running the real flow as a
 * SECOND, genuinely separate account and checking what happens.
 *
 * Everything tested so far has been one person (one auth.uid()) using the
 * extension repeatedly. That never exercises the part of the design that
 * matters for "every user who installs this": does a brand-new signup
 * get their OWN employee_hash, can they only write events attributed to
 * themselves, and are they blocked from reading anyone's events at all —
 * including their own, since only admins may read.
 *
 * Uses the ANON key + a real password grant to get an access token, the
 * same way the extension's own auth flow does — not the service_role
 * key, which would bypass RLS and prove nothing.
 *
 * Run: node test-multiuser.js          run the checks
 *      node test-multiuser.js --clean  remove the test account after
 */
require("dotenv").config();
const https = require("https");

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The anon key isn't in notifier/.env (deliberately — this file only
// holds the service_role key). Pull it from the extension's compiled
// config, the same value that ships to every real user's browser.
const anonKeyMatch = require("fs")
  .readFileSync(require("path").join(__dirname, "..", "extension", "src", "core", "config.js"), "utf8")
  .match(/SUPABASE_ANON_KEY = "([^"]+)"/);
const ANON_KEY = anonKeyMatch && anonKeyMatch[1];

const TEST_EMAIL = "shadowai-multiuser-test@example.com";
const TEST_PASSWORD = "TestUser2Pass!42";
const JOIN_CODE = "783755EA";

function req(method, path, { key, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(URL_BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { apikey: key };
    if (token) headers.Authorization = "Bearer " + token;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const r = https.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const PASS = (msg) => console.log("  \x1b[32mPASS\x1b[0m  " + msg);
const FAIL = (msg) => { console.log("  \x1b[31mFAIL\x1b[0m  " + msg); failures++; };
let failures = 0;

async function findExistingUser(email) {
  const res = await req("GET", "/auth/v1/admin/users?per_page=200", { key: SERVICE_KEY, token: SERVICE_KEY });
  return (res.body.users || []).find((u) => u.email === email);
}

async function clean() {
  const existing = await findExistingUser(TEST_EMAIL);
  if (!existing) { console.log("\n  no test account to remove\n"); return; }
  await req("DELETE", "/auth/v1/admin/users/" + existing.id, { key: SERVICE_KEY, token: SERVICE_KEY });
  console.log("\n  removed test account " + TEST_EMAIL + "\n");
}

async function run() {
  if (!ANON_KEY) { console.error("\n  could not read the anon key from extension config\n"); process.exit(1); }

  console.log("\nShadow AI Guard — multi-user isolation test");
  console.log("=".repeat(62));

  // ---- 1. Create (or reuse) a second, genuinely separate account ----
  let user = await findExistingUser(TEST_EMAIL);
  if (!user) {
    const created = await req("POST", "/auth/v1/admin/users", {
      key: SERVICE_KEY, token: SERVICE_KEY,
      body: { email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true },
    });
    if (created.status >= 400) { console.error("  could not create test user:", created.raw); process.exit(1); }
    user = created.body;
  }
  console.log("\n  test account: " + TEST_EMAIL + "  (id " + user.id + ")\n");

  // ---- 2. Sign in as that user via the ANON key + password grant — ----
  // ---- exactly what the extension's signInWithPassword() does.    ----
  const signIn = await req("POST", "/auth/v1/token?grant_type=password", {
    key: ANON_KEY,
    body: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  if (signIn.status >= 400 || !signIn.body.access_token) {
    FAIL("sign in as the second user — " + signIn.raw);
    return summarize();
  }
  PASS("signed in as a second, independent account (real password grant, anon key)");
  const token = signIn.body.access_token;

  // ---- 3. Enrol via join_company_as_employee, using THEIR token ----
  const enrol = await req("POST", "/rest/v1/rpc/join_company_as_employee", {
    key: ANON_KEY, token,
    body: { p_join_code: JOIN_CODE, p_department: "Sales" },
  });
  if (enrol.status >= 400 || !enrol.body || !enrol.body[0]) {
    FAIL("enrol as employee — " + enrol.raw);
    return summarize();
  }
  const identity = enrol.body[0];
  PASS("enrolled via join code " + JOIN_CODE + " — got employee_hash " + identity.employee_hash);

  // ---- 4. Confirm the hash is DIFFERENT from the first employee's ----
  const KNOWN_FIRST_EMPLOYEE_HASH = "emp_d06155b9d9d84986";
  if (identity.employee_hash === KNOWN_FIRST_EMPLOYEE_HASH) {
    FAIL("second user got the SAME employee_hash as the first — identity collision!");
  } else {
    PASS("employee_hash is unique — distinct from the first enrolled employee (" + KNOWN_FIRST_EMPLOYEE_HASH + ")");
  }

  // ---- 5. Re-enrol with the SAME token — must return the SAME hash ----
  // (idempotency: re-joining must not fork one person into two identities)
  const enrolAgain = await req("POST", "/rest/v1/rpc/join_company_as_employee", {
    key: ANON_KEY, token,
    body: { p_join_code: JOIN_CODE, p_department: "Sales" },
  });
  const hashAgain = enrolAgain.body && enrolAgain.body[0] && enrolAgain.body[0].employee_hash;
  if (hashAgain === identity.employee_hash) {
    PASS("re-enrolling returns the SAME hash (idempotent — doesn't fork identity)");
  } else {
    FAIL("re-enrolling issued a DIFFERENT hash: " + hashAgain);
  }

  // ---- 6. This user can INSERT an event attributed to THEMSELVES ----
  const ownInsert = await req("POST", "/rest/v1/flagged_events", {
    key: ANON_KEY, token,
    body: {
      company_id: identity.company_id,
      employee_hash: identity.employee_hash,
      ai_tool: "chatgpt.com",
      source: "text",
      pattern_types: ["email"],
      compliance_frameworks: ["GDPR"],
      department: "Sales",
      risk_level: "Low",
      action: "redacted",
    },
  });
  if (ownInsert.status >= 200 && ownInsert.status < 300) {
    PASS("can insert an event attributed to their OWN employee_hash");
  } else {
    FAIL("could not insert own event — " + ownInsert.status + " " + ownInsert.raw);
  }

  // ---- 7. This user CANNOT insert an event forging the FIRST employee's hash ----
  const forgedInsert = await req("POST", "/rest/v1/flagged_events", {
    key: ANON_KEY, token,
    body: {
      company_id: identity.company_id,
      employee_hash: KNOWN_FIRST_EMPLOYEE_HASH,   // pretending to be someone else
      ai_tool: "chatgpt.com",
      source: "text",
      pattern_types: ["email"],
      compliance_frameworks: ["GDPR"],
      department: "Sales",
      risk_level: "Low",
      action: "redacted",
    },
  });
  if (forgedInsert.status >= 400) {
    PASS("CANNOT forge an event under someone else's employee_hash (RLS rejected it)");
  } else {
    FAIL("forged insert under another employee's hash SUCCEEDED — this is a real vulnerability");
  }

  // ---- 8. This user (an employee, not an admin) CANNOT read any events ----
  // Only admins may SELECT from flagged_events — by design, an employee
  // has no visibility into their own or anyone else's logged history.
  const readAttempt = await req("GET", "/rest/v1/flagged_events?select=id&limit=1", { key: ANON_KEY, token });
  const gotRows = Array.isArray(readAttempt.body) && readAttempt.body.length > 0;
  if (!gotRows) {
    PASS("cannot read flagged_events as an employee (admin-only, as designed)");
  } else {
    FAIL("employee COULD read flagged_events — RLS gap");
  }

  // ---- 9. This user cannot read the OTHER employee's profile row ----
  // (the table that would let someone map a hash back to a colleague)
  const profileRead = await req(
    "GET",
    "/rest/v1/employee_profiles?select=id,employee_hash&employee_hash=eq." + KNOWN_FIRST_EMPLOYEE_HASH,
    { key: ANON_KEY, token }
  );
  const gotOtherProfile = Array.isArray(profileRead.body) && profileRead.body.length > 0;
  if (!gotOtherProfile) {
    PASS("cannot read another employee's profile row (self-only, as designed)");
  } else {
    FAIL("could read another employee's profile — de-anonymisation risk");
  }

  summarize();
}

function summarize() {
  console.log("\n" + "=".repeat(62));
  if (failures === 0) {
    console.log("  All checks passed. A second, independent user enrols correctly,");
    console.log("  gets their own identity, and RLS isolates them from every other");
    console.log("  employee's data in both directions.\n");
  } else {
    console.log("  " + failures + " check(s) FAILED — see above.\n");
  }
  process.exit(failures === 0 ? 0 : 1);
}

(process.argv.includes("--clean") ? clean() : run()).catch((e) => {
  console.error("\n  test crashed:", e.message, "\n");
  process.exit(1);
});
