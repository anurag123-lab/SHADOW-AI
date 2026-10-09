/**
 * Live end-to-end check of Feature 8: a policy change saved in the
 * dashboard reaches the extension's detection within seconds.
 *
 * Not a mock. It runs the extension's OWN realtime client
 * (extension/src/core/supabase-client.js) against your real Supabase
 * project, signed in as an ordinary employee through RLS, then:
 *   1. flips one policy tier exactly the way the dashboard does (upsert),
 *   2. times how long until the push arrives,
 *   3. re-fetches policies as the employee and re-scans sample text with
 *      the extension's Detector to prove the tier actually changed,
 *   4. restores the original tier (and proves that pushes too).
 *
 * Uses a throwaway employee account in the first company; removed at the end.
 *
 * Run: node scripts/test-policy-push.js [patternType]   (default: email)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL_BASE = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

// --- Load the extension's real modules, with chrome.storage shimmed ---
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys, cb) => { const o = {}; [].concat(keys).forEach((k) => { if (k in store) o[k] = store[k]; }); cb(o); },
      set: (obj, cb) => { Object.assign(store, obj); cb && cb(); },
      remove: (keys, cb) => { [].concat(keys).forEach((k) => delete store[k]); cb && cb(); },
    },
  },
};
globalThis.ShadowAIConfig = require(path.join(ROOT, "extension/src/core/config.js"));
const SB = require(path.join(ROOT, "extension/src/core/supabase-client.js"));
const Detector = require(path.join(ROOT, "extension/src/core/detector.js"));
const ANON_KEY = globalThis.ShadowAIConfig.SUPABASE_ANON_KEY;

const PATTERN = process.argv[2] || "email";
const SAMPLE = "Please follow up with priya.sharma@acme-corp.com about the renewal.";
const TEST_EMAIL = "shadowai-policypush-test@example.com";
const TEST_PASSWORD = "PolicyPush!Test42";
const MAX_WAIT_MS = 10000;

const PASS = (m) => console.log("  \x1b[32mPASS\x1b[0m  " + m);
const FAIL = (m) => { console.log("  \x1b[31mFAIL\x1b[0m  " + m); failures++; };
const INFO = (m) => console.log("        " + m);
let failures = 0;

async function api(method, p, { token = SERVICE_KEY, key = SERVICE_KEY, body, prefer } = {}) {
  const headers = { apikey: key, Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(URL_BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) throw new Error(method + " " + p + " -> " + res.status + " " + text);
  return json;
}

async function findUser() {
  const r = await api("GET", "/auth/v1/admin/users?per_page=200");
  return (r.users || []).find((u) => u.email === TEST_EMAIL);
}

function tierFor(overrides) {
  Detector.setPolicyOverrides(overrides);
  const scan = Detector.scan(SAMPLE);
  const m = scan.matches.find((x) => x.type === PATTERN);
  return m ? m.tier : "(not detected)";
}

async function run() {
  console.log("\n  Live policy push: dashboard -> extension detection (" + PATTERN + ")\n");

  const co = (await api("GET", "/rest/v1/companies?select=id,name,join_code&order=created_at.asc&limit=1"))[0];
  if (!co) throw new Error("no company found");
  INFO("company: " + co.name);

  // Throwaway employee, enrolled with the company's join code
  if (!(await findUser())) {
    await api("POST", "/auth/v1/admin/users", { body: { email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true } });
  }
  const grant = await api("POST", "/auth/v1/token?grant_type=password", {
    key: ANON_KEY, token: ANON_KEY, body: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  store.sag_session = {
    access_token: grant.access_token,
    refresh_token: grant.refresh_token,
    expires_at: Date.now() + grant.expires_in * 1000,
    user: grant.user,
  };
  await SB.rpc("join_company_as_employee", { p_join_code: co.join_code, p_department: "Engineering" });
  PASS("signed in and enrolled as a normal employee (RLS applies)");

  // Starting state, as the employee sees it
  const before = await SB.select("policies", "select=pattern_type,tier&company_id=eq." + co.id);
  const overrides = {}; before.forEach((r) => (overrides[r.pattern_type] = r.tier));
  const original = overrides[PATTERN] || "Warn";
  const flipped = original === "Warn" ? "MandatoryRedaction" : "Warn";
  INFO("current tier for " + PATTERN + ": " + original + "  (detector says: " + tierFor(overrides) + ")");

  // Subscribe exactly like the service worker
  let waiter = null;
  const subscribed = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("realtime never subscribed")), 15000);
    channel = SB.createRealtimeChannel({
      topic: "config",
      changes: [{ event: "*", table: "policies", filter: "company_id=eq." + co.id }],
      onChange: (data) => { if (waiter) waiter(data); },
      onStatus: (s, d) => { if (s === "subscribed") { clearTimeout(t); resolve(); } else if (s === "error") INFO("realtime " + s + " " + (d || "")); },
    });
  });
  await subscribed;
  PASS("realtime subscribed (channel reports healthy: " + channel.isHealthy() + ")");

  async function flipAndMeasure(tier) {
    const arrived = new Promise((resolve) => { waiter = resolve; });
    const t0 = Date.now();
    // Same write the dashboard's policy dropdown makes
    await api("POST", "/rest/v1/policies?on_conflict=company_id,pattern_type", {
      prefer: "resolution=merge-duplicates",
      body: { company_id: co.id, pattern_type: PATTERN, tier, updated_at: new Date().toISOString() },
    });
    const data = await Promise.race([arrived, new Promise((r) => setTimeout(() => r(null), MAX_WAIT_MS))]);
    const pushMs = Date.now() - t0;
    if (!data) { FAIL("no push within " + MAX_WAIT_MS / 1000 + "s for -> " + tier); return; }

    // What the worker does on a push: re-fetch through RLS, re-apply
    const rows = await SB.select("policies", "select=pattern_type,tier&company_id=eq." + co.id);
    const o = {}; rows.forEach((r) => (o[r.pattern_type] = r.tier));
    const totalMs = Date.now() - t0;
    const got = tierFor(o);
    if (got === tier) PASS("-> " + tier + ": push in " + pushMs + " ms, detection updated in " + totalMs + " ms");
    else FAIL("-> " + tier + ": push arrived but detector reports " + got);
  }

  try {
    await flipAndMeasure(flipped);
    await flipAndMeasure(original);
  } finally {
    // Always leave the company's real policy as we found it
    await api("POST", "/rest/v1/policies?on_conflict=company_id,pattern_type", {
      prefer: "resolution=merge-duplicates",
      body: { company_id: co.id, pattern_type: PATTERN, tier: original, updated_at: new Date().toISOString() },
    });
  }
}

let channel = null;
run()
  .catch((e) => FAIL(e.message))
  .finally(async () => {
    if (channel) channel.close();
    try {
      const u = await findUser();
      if (u) await api("DELETE", "/auth/v1/admin/users/" + u.id);
      INFO("test account removed");
    } catch (e) { INFO("cleanup: " + e.message); }
    console.log(failures ? "\n  " + failures + " check(s) failed\n" : "\n  all checks passed\n");
    process.exit(failures ? 1 : 0);
  });
