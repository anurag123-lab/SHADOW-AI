/* eslint-disable */
/**
 * Shadow AI Guard — Background Service Worker
 * ===========================================
 * The extension's only network-facing component. Content scripts never
 * talk to Supabase directly; they message this worker, which owns auth,
 * config sync, and the outbound event queue.
 *
 * Feature 8 fail-safe rule, implemented in syncConfig():
 *   if a policy fetch fails, the LAST KNOWN policy is retained. It never
 *   falls back to defaults and never fails open. A network outage must not
 *   silently change what the extension enforces.
 */

importScripts(
  "../core/config.js",
  "../core/patterns.js",
  "../core/detector.js",
  "../core/event-payload.js",
  "../core/supabase-client.js"
);

var Config = self.ShadowAIConfig;
var SB = self.ShadowAISupabase;
var EP = self.ShadowAIEventPayload;
var KEYS = Config.STORAGE_KEYS;

var realtimeChannel = null;

/* ==================================================================== *
 * Storage helpers
 * ==================================================================== */
function get(key) {
  return new Promise(function (resolve) {
    chrome.storage.local.get([key], function (r) { resolve(r[key]); });
  });
}
function set(key, value) {
  return new Promise(function (resolve) {
    var o = {}; o[key] = value; chrome.storage.local.set(o, resolve);
  });
}

function log() {
  console.log.apply(console, ["[ShadowAI:bg]"].concat(Array.prototype.slice.call(arguments)));
}

/* ==================================================================== *
 * Identity
 * ==================================================================== */
async function getIdentity() {
  return (await get(KEYS.identity)) || null;
}

/**
 * Enrolment. The RPC is idempotent: an already-enrolled employee gets
 * their EXISTING hash back. Re-issuing a hash would fork one person's
 * history into two anonymous people and corrupt the override tracking.
 */
async function enroll(joinCode, department) {
  var rows = await SB.rpc("join_company_as_employee", {
    p_join_code: String(joinCode || "").trim().toUpperCase(),
    p_department: department || "Unspecified",
  });
  var row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.employee_hash) throw new Error("enrolment failed");

  var identity = {
    companyId: row.company_id,
    employeeHash: row.employee_hash,
    department: row.department,
    companyName: row.company_name,
    sanctionedUrl: row.sanctioned_url,
    sanctionedName: row.sanctioned_name,
    enrolledAt: new Date().toISOString(),
  };
  await set(KEYS.identity, identity);
  await syncConfig();
  startRealtime();
  return identity;
}

async function setDepartment(department) {
  await SB.rpc("set_my_department", { p_department: department });
  var identity = (await getIdentity()) || {};
  identity.department = department;
  await set(KEYS.identity, identity);
  return identity;
}

/* ==================================================================== *
 * Config sync — Features 8, 9, 3
 * ==================================================================== */
async function syncConfig() {
  var identity = await getIdentity();
  if (!identity || !identity.companyId) return { ok: false, reason: "not enrolled" };

  var filter = "company_id=eq." + identity.companyId;
  var result = { ok: true, failures: [] };

  // --- Policies (Feature 8) ---
  try {
    var rows = await SB.select("policies", "select=pattern_type,tier&" + filter);
    var overrides = {};
    (rows || []).forEach(function (r) { overrides[r.pattern_type] = r.tier; });
    await set(KEYS.policy, { overrides: overrides, fetchedAt: Date.now() });
    log("policy synced:", Object.keys(overrides).length, "rules");
  } catch (e) {
    // FAIL-SAFE: keep the last known policy. Do NOT clear, do NOT default.
    result.failures.push("policy");
    var cached = await get(KEYS.policy);
    console.warn(
      "[ShadowAI:bg] policy sync FAILED (" + e.message + "). Retaining last-known policy from " +
        (cached ? new Date(cached.fetchedAt).toISOString() : "never") +
        ". Enforcement is unchanged."
    );
  }

  // --- Honeytokens (Feature 3) ---
  try {
    var ht = await SB.select("honeytokens", "select=token&" + filter);
    await set(KEYS.honeytokens, {
      tokens: (ht || []).map(function (r) { return r.token; }),
      fetchedAt: Date.now(),
    });
  } catch (e) {
    result.failures.push("honeytokens");
    console.warn("[ShadowAI:bg] honeytoken sync failed, retaining cache:", e.message);
  }

  // --- Custom keywords (Feature 9) ---
  try {
    var kw = await SB.select("custom_keywords", "select=keyword&" + filter);
    await set(KEYS.customKeywords, {
      keywords: (kw || []).map(function (r) { return r.keyword; }),
      fetchedAt: Date.now(),
    });
  } catch (e) {
    result.failures.push("keywords");
    console.warn("[ShadowAI:bg] keyword sync failed, retaining cache:", e.message);
  }

  // --- Company / sanctioned tool (Feature 11) ---
  try {
    var co = await SB.select(
      "companies",
      "select=name,sanctioned_ai_tool_url,sanctioned_ai_tool_name&id=eq." + identity.companyId
    );
    if (co && co[0]) {
      identity.companyName = co[0].name;
      identity.sanctionedUrl = co[0].sanctioned_ai_tool_url;
      identity.sanctionedName = co[0].sanctioned_ai_tool_name;
      await set(KEYS.identity, identity);
    }
  } catch (e) {
    result.failures.push("company");
  }

  result.ok = result.failures.length === 0;
  return result;
}

/** The bundle a content script needs to run a scan entirely locally. */
async function getScanConfig() {
  var identity = await getIdentity();
  var policy = await get(KEYS.policy);
  var honeytokens = await get(KEYS.honeytokens);
  var keywords = await get(KEYS.customKeywords);
  var settings = (await get(KEYS.settings)) || { enabled: true };

  return {
    enrolled: !!(identity && identity.employeeHash),
    enabled: settings.enabled !== false,
    identity: identity,
    policyOverrides: (policy && policy.overrides) || {},
    policyFetchedAt: policy ? policy.fetchedAt : null,
    honeytokens: (honeytokens && honeytokens.tokens) || [],
    customKeywords: (keywords && keywords.keywords) || [],
  };
}

/* ==================================================================== *
 * Realtime config push — policies, keywords, honeytokens, approved tool
 * ==================================================================== *
 * Any change the dashboard saves reaches every browser in seconds. The
 * push is only a trigger: on any notification we re-fetch our own
 * company's config through RLS, so nothing in the payload is trusted.
 * DELETE events can't be filtered server-side, so they are subscribed
 * unfiltered — a stray one just causes a harmless extra re-fetch.
 * The 10-minute alarm poll remains the fallback if the socket is down.
 */
var resyncTimer = null;
function scheduleResync(reason) {
  clearTimeout(resyncTimer);
  // Debounced: a bulk edit arrives as a burst of events, one re-fetch covers it.
  resyncTimer = setTimeout(function () {
    log("realtime: " + reason + " changed, re-syncing");
    syncConfig().then(function () { broadcastConfigChanged(); });
  }, 400);
}

async function startRealtime() {
  var identity = await getIdentity();
  if (!identity || !identity.companyId) return;
  if (realtimeChannel) realtimeChannel.close();

  var byCompany = "company_id=eq." + identity.companyId;
  var onChange = function (data) { scheduleResync((data && data.table) || "config"); };
  var onStatus = function (status, detail) { log("realtime:", status, detail || ""); };

  // Two channels: if the server rejects one subscription it drops the whole
  // channel, so the company row (approved AI tool) is kept separate and can
  // never take policy / keyword / honeytoken updates down with it.
  var detection = SB.createRealtimeChannel({
    topic: "config",
    changes: [
      { event: "*", table: "policies", filter: byCompany },
      { event: "INSERT", table: "honeytokens", filter: byCompany },
      { event: "UPDATE", table: "honeytokens", filter: byCompany },
      { event: "DELETE", table: "honeytokens" },
      { event: "INSERT", table: "custom_keywords", filter: byCompany },
      { event: "UPDATE", table: "custom_keywords", filter: byCompany },
      { event: "DELETE", table: "custom_keywords" },
    ],
    onChange: onChange,
    onStatus: onStatus,
  });
  var company = SB.createRealtimeChannel({
    topic: "company",
    changes: [{ event: "UPDATE", table: "companies", filter: "id=eq." + identity.companyId }],
    onChange: onChange,
    onStatus: onStatus,
  });
  realtimeChannel = { close: function () { detection.close(); company.close(); } };
}

function broadcastConfigChanged() {
  chrome.tabs.query({}, function (tabs) {
    tabs.forEach(function (tab) {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: "SAG_CONFIG_CHANGED" }, function () {
        void chrome.runtime.lastError;   // tabs without our content script
      });
    });
  });
}

/* ==================================================================== *
 * Event delivery (Features 13, 14, 15, 20)
 * ==================================================================== */
async function queueEvent(payload) {
  var queue = (await get(KEYS.queue)) || [];
  queue.push({ payload: payload, queuedAt: Date.now() });
  if (queue.length > Config.MAX_QUEUE_SIZE) queue = queue.slice(-Config.MAX_QUEUE_SIZE);
  await set(KEYS.queue, queue);
}

async function flushQueue() {
  var queue = (await get(KEYS.queue)) || [];
  if (queue.length === 0) return 0;

  var remaining = [];
  var sent = 0;
  for (var i = 0; i < queue.length; i++) {
    try {
      await SB.insert("flagged_events", queue[i].payload);
      sent++;
    } catch (e) {
      remaining.push(queue[i]);
    }
  }
  await set(KEYS.queue, remaining);
  if (sent) log("flushed", sent, "queued events");
  return sent;
}

/**
 * Builds the payload through event-payload.js (the allow-list) and sends
 * it. A failure queues rather than drops — but the queue holds only
 * already-sanitised payloads, never raw scan results.
 */
async function logEvent(scanSummary, context) {
  var identity = await getIdentity();
  if (!identity || !identity.employeeHash) return { ok: false, reason: "not enrolled" };

  var payload = EP.buildEventPayload(scanSummary, {
    companyId: identity.companyId,
    employeeHash: identity.employeeHash,
    department: identity.department,
    aiTool: context.aiTool,
    source: context.source,
    fileName: context.fileName,
    fileType: context.fileType,
    action: context.action,
    falsePositiveReason: context.falsePositiveReason,
  });

  var problems = EP.assertNoContentLeak(payload);
  if (problems.length) {
    console.error("[ShadowAI:bg] payload rejected locally:", problems);
    return { ok: false, reason: "payload failed local privacy check" };
  }

  try {
    await SB.insert("flagged_events", payload);
    flushQueue();
    return { ok: true };
  } catch (e) {
    await queueEvent(payload);
    return { ok: false, queued: true, reason: e.message };
  }
}

async function logDiscovery(aiTool) {
  var identity = await getIdentity();
  if (!identity || !identity.employeeHash) return { ok: false };

  // One signal per tool per browser session — a visit log, not a tracker.
  var seenKey = "sag_discovery_seen";
  var seen = (await get(seenKey)) || {};
  var today = new Date().toISOString().slice(0, 10);
  if (seen[aiTool] === today) return { ok: true, deduped: true };

  var payload = EP.buildDiscoveryPayload({
    companyId: identity.companyId,
    employeeHash: identity.employeeHash,
    aiTool: aiTool,
  });

  try {
    await SB.insert("discovered_tools", payload);
    seen[aiTool] = today;
    await set(seenKey, seen);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ==================================================================== *
 * Message router
 * ==================================================================== */
/**
 * Why the extension thinks it is (or isn't) configured.
 *
 * The compiled config can be correct while the worker still reports
 * "not configured" — a stale storage override, a half-synced file, a
 * failed import. Guessing between those wastes time, so the worker says
 * what it actually sees. Keys are reported by length only.
 */
async function configDiagnostics() {
  var override = await get(KEYS.connection);
  var compiledOk = Config.isConfigured(Config.SUPABASE_URL, Config.SUPABASE_ANON_KEY);
  var effective = await SB.getConnection();

  return {
    compiledUrl: Config.SUPABASE_URL,
    compiledKeyLength: (Config.SUPABASE_ANON_KEY || "").length,
    compiledLooksValid: compiledOk,
    hasStorageOverride: !!override,
    overrideUrl: override ? override.url : null,
    overrideKeyLength: override && override.anonKey ? override.anonKey.length : 0,
    effectiveUrl: effective.url,
    effectiveKeyLength: (effective.anonKey || "").length,
    effectiveLooksValid: Config.isConfigured(effective.url, effective.anonKey),
  };
}

var HANDLERS = {
  GET_DIAGNOSTICS: configDiagnostics,

  GET_STATE: async function () {
    var configured = await SB.isConfigured();
    var session = await SB.getValidSession();
    var user = session ? await SB.getUser() : null;
    var scanConfig = await getScanConfig();
    var queue = (await get(KEYS.queue)) || [];
    return {
      configured: configured,
      signedIn: !!session,
      user: user,
      queuedEvents: queue.length,
      identity: scanConfig.identity,
      enrolled: scanConfig.enrolled,
      enabled: scanConfig.enabled,
      policyCount: Object.keys(scanConfig.policyOverrides).length,
      honeytokenCount: scanConfig.honeytokens.length,
      keywordCount: scanConfig.customKeywords.length,
      policyFetchedAt: scanConfig.policyFetchedAt,
    };
  },

  SET_CONNECTION: function (msg) { return SB.setConnection(msg.url, msg.anonKey); },
  SIGN_IN_GOOGLE: function () { return SB.signInWithGoogle(); },
  SIGN_IN_PASSWORD: function (msg) { return SB.signInWithPassword(msg.email, msg.password); },
  SIGN_UP_PASSWORD: function (msg) { return SB.signUpWithPassword(msg.email, msg.password); },
  SIGN_OUT: async function () {
    if (realtimeChannel) { realtimeChannel.close(); realtimeChannel = null; }
    await chrome.storage.local.remove([KEYS.identity, KEYS.policy, KEYS.honeytokens, KEYS.customKeywords]);
    return SB.signOut();
  },

  ENROLL: function (msg) { return enroll(msg.joinCode, msg.department); },
  SET_DEPARTMENT: function (msg) { return setDepartment(msg.department); },

  GET_SCAN_CONFIG: function () { return getScanConfig(); },
  FORCE_SYNC: async function () {
    var r = await syncConfig();
    broadcastConfigChanged();
    return r;
  },

  LOG_EVENT: function (msg) { return logEvent(msg.scan, msg.context); },
  LOG_DISCOVERY: function (msg) { return logDiscovery(msg.aiTool); },

  SET_ENABLED: async function (msg) {
    var settings = (await get(KEYS.settings)) || {};
    settings.enabled = !!msg.enabled;
    await set(KEYS.settings, settings);
    broadcastConfigChanged();
    return settings;
  },

  OPEN_SANCTIONED_TOOL: async function (msg) {
    var identity = await getIdentity();
    var url = (identity && identity.sanctionedUrl) || msg.url;
    if (!url) return { ok: false, reason: "no sanctioned tool configured" };
    chrome.tabs.create({ url: url });
    return { ok: true };
  },

  FLUSH_QUEUE: function () { return flushQueue(); },
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var handler = HANDLERS[msg && msg.type];
  if (!handler) return false;

  Promise.resolve()
    .then(function () { return handler(msg, sender); })
    .then(function (data) { sendResponse({ ok: true, data: data }); })
    .catch(function (err) {
      console.warn("[ShadowAI:bg]", msg.type, "failed:", err.message);
      sendResponse({ ok: false, error: err.message });
    });

  return true;   // keep the message channel open for the async response
});

/* ==================================================================== *
 * Lifecycle
 * ==================================================================== */
chrome.runtime.onInstalled.addListener(function () {
  log("installed");
  chrome.alarms.create("sag-sync", { periodInMinutes: Config.SYNC_INTERVAL_MINUTES });
  syncConfig();
  startRealtime();
});

chrome.runtime.onStartup.addListener(function () {
  chrome.alarms.create("sag-sync", { periodInMinutes: Config.SYNC_INTERVAL_MINUTES });
  syncConfig();
  startRealtime();
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== "sag-sync") return;
  // Polling remains the fallback even when Realtime is connected: an MV3
  // worker can be torn down at any time, taking the socket with it.
  syncConfig().then(function () { flushQueue(); });
});

// Cold start after a worker teardown.
// Log the config state immediately: if the popup ever asks for a URL and
// key that are already compiled in, this line says why.
configDiagnostics()
  .then(function (d) {
    log("config:", d.effectiveLooksValid ? "OK" : "NOT CONFIGURED", d);
    if (!d.effectiveLooksValid && d.compiledLooksValid && d.hasStorageOverride) {
      console.warn(
        "[ShadowAI:bg] A stored connection override is shadowing the compiled config. " +
        "Clearing it so the built-in values are used."
      );
      chrome.storage.local.remove([KEYS.connection]);
    }
  })
  .catch(function (e) {
    console.error("[ShadowAI:bg] could not read config:", e.message);
  });

syncConfig();
startRealtime();
