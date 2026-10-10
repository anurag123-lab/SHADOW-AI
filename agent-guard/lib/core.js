/**
 * Shadow AI Guard — agent guard shared core
 * =========================================
 * Session (sign-in as an enrolled employee), company policy sync, and the
 * background event queue. Talks to the SAME Supabase project as the browser
 * extension, through the same row-level security: an employee can only add
 * events under their own anonymous ID and can only read their company's
 * policies, keywords and honeytokens.
 *
 * Local state lives in ~/.shadow-ai/ (override with SHADOW_HOME):
 *   session.json        refresh/access token + workspace identity (no password)
 *   policy-cache.json   last company policy pulled from the dashboard
 *   queue.jsonl         events waiting to be sent (metadata only)
 *   events.log.jsonl    local copy of every decision (metadata only)
 *   OFF                 if present, the guard allows everything
 *   exempt.json         folders where the guard allows everything (e.g. the guard's own repo)
 *   last-seen.json      when each AI tool last called the guard (proves the hooks run)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CORE = path.join(ROOT, "extension", "src", "core");
const Config = require(path.join(CORE, "config.js"));

const HOME = process.env.SHADOW_HOME || path.join(os.homedir(), ".shadow-ai");
const FILES = {
  session: path.join(HOME, "session.json"),
  policy: path.join(HOME, "policy-cache.json"),
  queue: path.join(HOME, "queue.jsonl"),
  log: path.join(HOME, "events.log.jsonl"),
  off: path.join(HOME, "OFF"),
  exempt: path.join(HOME, "exempt.json"),
  seen: path.join(HOME, "last-seen.json"),
};
const POLICY_TTL_MS = 60 * 1000;   // pull fresh policy at most once a minute
const NET_TIMEOUT_MS = 4000;
const AI_TOOL = "Claude Code (desktop)";

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; } }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function isOff() {
  return process.env.SHADOW_GUARD_OFF === "1" || fs.existsSync(FILES.off);
}

// ------------------------------------------------------------- exempt folders + heartbeat
const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");
function exemptFolders() { return (readJson(FILES.exempt) || {}).folders || []; }
function isInside(p, dir) {
  const a = norm(p), b = norm(dir);
  return a === b || a.startsWith(b + path.sep.toLowerCase()) || a.startsWith(b + "/");
}
/** True when any of the given paths lies in an exempt folder. */
function isExempt(paths) {
  const ex = exemptFolders();
  return ex.length > 0 && paths.some((p) => p && typeof p === "string" && path.isAbsolute(p) && ex.some((d) => isInside(p, d)));
}
function setExempt(dir, on) {
  const list = exemptFolders().filter((d) => norm(d) !== norm(dir));
  if (on) list.push(path.resolve(dir));
  writeJson(FILES.exempt, { folders: list });
  return list;
}
/**
 * True if this exact hook call already ran in the last few seconds — e.g. the
 * same hook installed both in a project and laptop-wide. The verdict is still
 * given; only the dashboard event is not sent twice.
 */
function seenRecently(key, windowMs = Number(process.env.SHADOW_DEDUP_MS || 5000)) {
  if (!(windowMs > 0)) return false;
  try {
    const h = require("crypto").createHash("sha256").update(key).digest("hex").slice(0, 16);
    const f = path.join(HOME, "recent.json");
    const now = Date.now();
    const recent = Object.fromEntries(Object.entries(readJson(f) || {}).filter(([, t]) => now - t < windowMs));
    const dup = !!recent[h];
    recent[h] = now;
    writeJson(f, recent);
    return dup;
  } catch (e) { return false; }
}
function touchSeen(aiTool, event) {
  try {
    const s = readJson(FILES.seen) || {};
    s[aiTool] = { ts: new Date().toISOString(), event: String(event || "").slice(0, 40) };
    writeJson(FILES.seen, s);
  } catch (e) {}
}

// ------------------------------------------------------------- Supabase REST
async function api(pathAndQuery, { method = "GET", token, body, prefer } = {}) {
  const headers = { apikey: Config.SUPABASE_ANON_KEY, Authorization: "Bearer " + (token || Config.SUPABASE_ANON_KEY) };
  if (body) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(Config.SUPABASE_URL + pathAndQuery, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) {
    const msg = (data && (data.msg || data.message || data.error_description || data.error)) || res.statusText;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

// ------------------------------------------------------------- session
function saveTokens(identity, tok) {
  writeJson(FILES.session, {
    ...identity,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (tok.expires_in || 3600),
  });
}

async function login(email, password, joinCode, department) {
  const tok = await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  const rows = await api("/rest/v1/rpc/join_company_as_employee", {
    method: "POST", token: tok.access_token,
    body: { p_join_code: String(joinCode).trim().toUpperCase(), p_department: department || "Unspecified" },
  });
  const id = rows && rows[0];
  if (!id) throw new Error("could not join that workspace");
  const identity = {
    email, company_id: id.company_id, employee_hash: id.employee_hash,
    department: id.department, company_name: id.company_name,
  };
  saveTokens(identity, tok);
  return identity;
}

function logout() {
  for (const f of [FILES.session, FILES.policy]) { try { fs.unlinkSync(f); } catch (e) {} }
}

/** A valid session, refreshing the access token if it is about to expire. */
async function getSession() {
  const s = readJson(FILES.session);
  if (!s || !s.refresh_token) return null;
  if (s.expires_at && s.expires_at - 60 > Date.now() / 1000) return s;
  try {
    const tok = await api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: s.refresh_token } });
    const { access_token, refresh_token, expires_at, ...identity } = s;
    saveTokens(identity, tok);
    return readJson(FILES.session);
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------- policy
/**
 * The company's policy from the dashboard (cached for a minute), merged
 * with an optional per-project overlay file <cwd>/.shadow-ai-policy.json.
 */
async function getPolicy(cwd) {
  let remote = readJson(FILES.policy);
  const stale = !remote || Date.now() - (remote.fetchedAt || 0) > POLICY_TTL_MS;
  if (stale) {
    const s = await getSession().catch(() => null);
    if (s) {
      try {
        const [pol, ht, kw] = await Promise.all([
          api("/rest/v1/policies?select=pattern_type,tier", { token: s.access_token }),
          api("/rest/v1/honeytokens?select=token", { token: s.access_token }),
          api("/rest/v1/custom_keywords?select=keyword", { token: s.access_token }),
        ]);
        const overrides = {};
        (pol || []).forEach((p) => { overrides[p.pattern_type] = p.tier; });
        remote = {
          fetchedAt: Date.now(),
          policyOverrides: overrides,
          honeytokens: (ht || []).map((h) => h.token),
          customKeywords: (kw || []).map((k) => k.keyword),
        };
        writeJson(FILES.policy, remote);
      } catch (e) { /* offline: keep the last cached policy */ }
    }
  }
  const local = readJson(path.join(cwd || process.cwd(), ".shadow-ai-policy.json")) || {};
  remote = remote || {};
  return {
    policyOverrides: { ...(remote.policyOverrides || {}), ...(local.policyOverrides || {}) },
    honeytokens: [...(remote.honeytokens || []), ...(local.honeytokens || [])],
    customKeywords: [...(remote.customKeywords || []), ...(local.customKeywords || [])],
    sensitivePaths: local.sensitivePaths,
  };
}

// ------------------------------------------------------------- events
function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

/** Queue one dashboard event. `payload` must come from buildEventPayload. */
function enqueue(payload) {
  appendLine(FILES.queue, payload);
}

/**
 * Send everything queued. Several hook runs can report at almost the same
 * moment, so the queue is first MOVED aside atomically (rename): events
 * added meanwhile land in a fresh queue file and can never be wiped by
 * this sender. Events that fail to send are put back.
 */
async function flush() {
  if (!fs.existsSync(FILES.queue)) return { sent: 0, left: 0 };
  const s = await getSession();
  if (!s) return { sent: 0, left: -1 };
  const batch = FILES.queue + "." + process.pid + "." + Date.now() + ".sending";
  try { fs.renameSync(FILES.queue, batch); } catch (e) { return { sent: 0, left: 0 }; }   // another sender took it
  const lines = fs.readFileSync(batch, "utf8").split("\n").filter(Boolean);
  const events = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  if (!events.length) { fs.unlinkSync(batch); return { sent: 0, left: 0 }; }
  try {
    await api("/rest/v1/flagged_events", { method: "POST", token: s.access_token, body: events, prefer: "return=minimal" });
    fs.unlinkSync(batch);
    return { sent: events.length, left: 0 };
  } catch (e) {
    fs.appendFileSync(FILES.queue, lines.join("\n") + "\n");   // put back for next time
    fs.unlinkSync(batch);
    return { sent: 0, left: events.length, error: e.message };
  }
}

module.exports = {
  CORE, HOME, FILES, AI_TOOL, isOff, login, logout, getSession, getPolicy,
  enqueue, flush, appendLine, readJson, exemptFolders, isExempt, setExempt, touchSeen, seenRecently,
};
