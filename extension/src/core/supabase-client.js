/* eslint-disable */
/**
 * Shadow AI Guard — Minimal Supabase Client
 * =========================================
 * A hand-rolled client covering exactly the four things the extension
 * needs: auth, REST reads, REST inserts, and a Realtime subscription.
 *
 * Why not @supabase/supabase-js? MV3 forbids remote script loading, so the
 * SDK would have to be bundled — which means a build step. The extension
 * uses ~6 endpoints; this file is smaller than the bundler config would be,
 * and it keeps "load unpacked and it runs" true.
 *
 * Auth model:
 *   - Google OAuth via chrome.identity.launchWebAuthFlow (primary)
 *   - Email/password via the token endpoint (fallback, no Google Cloud setup)
 *   - Tokens cached in chrome.storage.local, refreshed on 401
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ShadowAISupabase = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  var Config = (typeof globalThis !== "undefined" && globalThis.ShadowAIConfig) || null;
  var KEYS = Config ? Config.STORAGE_KEYS : {};

  var connection = null;   // { url, anonKey }
  var session = null;      // { access_token, refresh_token, expires_at }

  /* ---------------------------------------------------------------- *
   * Storage helpers
   * ---------------------------------------------------------------- */
  function storageGet(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (r) { resolve(r[key]); });
    });
  }
  function storageSet(key, value) {
    return new Promise(function (resolve) {
      var obj = {};
      obj[key] = value;
      chrome.storage.local.set(obj, resolve);
    });
  }
  function storageRemove(key) {
    return new Promise(function (resolve) { chrome.storage.local.remove([key], resolve); });
  }

  /* ---------------------------------------------------------------- *
   * Connection
   * ---------------------------------------------------------------- */
  async function getConnection() {
    if (connection) return connection;
    var override = await storageGet(KEYS.connection);
    var url = (override && override.url) || Config.SUPABASE_URL;
    var anonKey = (override && override.anonKey) || Config.SUPABASE_ANON_KEY;
    connection = { url: String(url).replace(/\/+$/, ""), anonKey: anonKey };
    return connection;
  }

  async function setConnection(url, anonKey) {
    connection = { url: String(url).replace(/\/+$/, ""), anonKey: anonKey };
    await storageSet(KEYS.connection, connection);
    return connection;
  }

  async function isConfigured() {
    var c = await getConnection();
    return Config.isConfigured(c.url, c.anonKey);
  }

  /* ---------------------------------------------------------------- *
   * Session
   * ---------------------------------------------------------------- */
  async function loadSession() {
    if (session) return session;
    session = (await storageGet(KEYS.session)) || null;
    return session;
  }

  async function saveSession(raw) {
    if (!raw || !raw.access_token) return null;
    session = {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      // expires_in is seconds from now; store an absolute ms deadline
      expires_at: raw.expires_at
        ? Number(raw.expires_at) * 1000
        : Date.now() + (Number(raw.expires_in || 3600) * 1000),
      user: raw.user ? { id: raw.user.id, email: raw.user.email } : (raw.userInfo || null),
    };
    await storageSet(KEYS.session, session);
    return session;
  }

  async function clearSession() {
    session = null;
    await storageRemove(KEYS.session);
  }

  function isExpired(s) {
    return !s || !s.expires_at || Date.now() > s.expires_at - 60000; // 60s grace
  }

  /* ---------------------------------------------------------------- *
   * Auth
   * ---------------------------------------------------------------- */
  async function authFetch(path, body) {
    var c = await getConnection();
    var res = await fetch(c.url + "/auth/v1/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: c.anonKey },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      throw new Error(data.error_description || data.msg || data.error || ("auth failed (" + res.status + ")"));
    }
    return data;
  }

  async function signUpWithPassword(email, password) {
    var data = await authFetch("signup", { email: email, password: password });
    // With email confirmation disabled, signup returns a session directly.
    if (data.access_token) return saveSession(data);
    if (data.session && data.session.access_token) return saveSession(data.session);
    return null; // confirmation required
  }

  async function signInWithPassword(email, password) {
    var data = await authFetch("token?grant_type=password", { email: email, password: password });
    return saveSession(data);
  }

  /**
   * Google OAuth for an extension. chrome.identity gives us a
   * chromiumapp.org redirect that Chrome intercepts, so no hosted page is
   * needed — but that URI must be registered in Supabase's allowed
   * redirect list (docs/SETUP.md step 3b.6).
   */
  async function signInWithGoogle() {
    var c = await getConnection();
    var redirectUri = chrome.identity.getRedirectURL();
    var authUrl =
      c.url + "/auth/v1/authorize?provider=google&redirect_to=" + encodeURIComponent(redirectUri);

    var responseUrl = await new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, function (url) {
        if (chrome.runtime.lastError || !url) {
          reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "sign-in cancelled"));
        } else {
          resolve(url);
        }
      });
    });

    var parsed = new URL(responseUrl);
    // Supabase returns tokens in the fragment; errors sometimes in the query.
    var params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    if (!params.get("access_token")) {
      var qs = new URLSearchParams(parsed.search);
      if (qs.get("error_description")) throw new Error(qs.get("error_description"));
      throw new Error("no access token returned");
    }

    return saveSession({
      access_token: params.get("access_token"),
      refresh_token: params.get("refresh_token"),
      expires_in: params.get("expires_in"),
    });
  }

  async function refreshSession() {
    var s = await loadSession();
    if (!s || !s.refresh_token) return null;
    try {
      var data = await authFetch("token?grant_type=refresh_token", { refresh_token: s.refresh_token });
      return saveSession(data);
    } catch (e) {
      await clearSession();
      return null;
    }
  }

  async function getValidSession() {
    var s = await loadSession();
    if (!s) return null;
    if (isExpired(s)) return refreshSession();
    return s;
  }

  async function signOut() {
    var s = await loadSession();
    var c = await getConnection();
    if (s) {
      fetch(c.url + "/auth/v1/logout", {
        method: "POST",
        headers: { apikey: c.anonKey, Authorization: "Bearer " + s.access_token },
      }).catch(function () {});
    }
    await clearSession();
  }

  async function getUser() {
    var s = await getValidSession();
    if (!s) return null;
    if (s.user && s.user.id) return s.user;
    var c = await getConnection();
    var res = await fetch(c.url + "/auth/v1/user", {
      headers: { apikey: c.anonKey, Authorization: "Bearer " + s.access_token },
    });
    if (!res.ok) return null;
    var user = await res.json();
    s.user = { id: user.id, email: user.email };
    await storageSet(KEYS.session, s);
    return s.user;
  }

  /* ---------------------------------------------------------------- *
   * REST
   * ---------------------------------------------------------------- */
  async function restFetch(path, options, retryOn401) {
    var c = await getConnection();
    var s = await getValidSession();
    var headers = Object.assign(
      {
        apikey: c.anonKey,
        "Content-Type": "application/json",
      },
      options.headers || {}
    );
    if (s) headers.Authorization = "Bearer " + s.access_token;

    var res = await fetch(c.url + "/rest/v1/" + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401 && retryOn401 !== false) {
      var refreshed = await refreshSession();
      if (refreshed) return restFetch(path, options, false);
    }

    var text = await res.text();
    var data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      var err = new Error((data && (data.message || data.hint)) || ("request failed (" + res.status + ")"));
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  }

  function select(table, query) {
    var qs = query ? "?" + query : "?select=*";
    return restFetch(table + qs, { method: "GET" });
  }

  function insert(table, rows) {
    return restFetch(table, {
      method: "POST",
      body: Array.isArray(rows) ? rows : [rows],
      headers: { Prefer: "return=minimal" },
    });
  }

  function update(table, filter, patch) {
    return restFetch(table + "?" + filter, {
      method: "PATCH",
      body: patch,
      headers: { Prefer: "return=representation" },
    });
  }

  function remove(table, filter) {
    return restFetch(table + "?" + filter, { method: "DELETE" });
  }

  function rpc(fn, args) {
    return restFetch("rpc/" + fn, { method: "POST", body: args || {} });
  }

  /* ---------------------------------------------------------------- *
   * Realtime (Feature 8 live policy push)
   * Phoenix channel protocol, spoken directly over a WebSocket.
   * ---------------------------------------------------------------- */
  function createRealtimeChannel(options) {
    var table = options.table;
    var filter = options.filter;          // e.g. "company_id=eq.<uuid>"
    // Several subscriptions on one socket: [{ event, table, filter? }, ...]
    var changes = (options.changes || [{ event: "*", table: table, filter: filter }])
      .map(function (c) {
        var spec = { event: c.event || "*", schema: "public", table: c.table };
        if (c.filter) spec.filter = c.filter;
        return spec;
      });
    var onChange = options.onChange || function () {};
    var onStatus = options.onStatus || function () {};

    var ws = null;
    var heartbeat = null;
    var ref = 0;
    var closed = false;
    var retryMs = 1000;
    var joinRef = null;

    async function connect() {
      if (closed) return;
      var c = await getConnection();
      var s = await getValidSession();
      var wsUrl =
        c.url.replace(/^http/, "ws") +
        "/realtime/v1/websocket?apikey=" + encodeURIComponent(c.anonKey) + "&vsn=2.0.0";

      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        onStatus("error", e.message);
        return scheduleReconnect();
      }

      ws.onopen = function () {
        retryMs = 1000;
        onStatus("connected");
        joinRef = String(ref + 1);
        send("realtime:" + (options.topic || table || "config"), "phx_join", {
          // Full channel config, matching what supabase-js sends; current
          // Realtime servers validate the whole block.
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: "", enabled: false },
            postgres_changes: changes,
            private: false,
          },
          access_token: s ? s.access_token : null,
        });
        heartbeat = setInterval(function () {
          send("phoenix", "heartbeat", {});
        }, 25000);
      };

      ws.onmessage = function (evt) {
        var msg;
        if (typeof evt.data !== "string") return;          // binary frames are broadcast-only
        try { msg = JSON.parse(evt.data); } catch (e) { return; }
        // Protocol v2 frames: [join_ref, ref, topic, event, payload]
        if (Array.isArray(msg)) msg = { topic: msg[2], event: msg[3], payload: msg[4] };
        if (msg.event === "system" && msg.payload && msg.payload.status === "error") {
          onStatus("error", msg.payload.message);
        }
        if (msg.event === "postgres_changes" && msg.payload && msg.payload.data) {
          onChange(msg.payload.data);
        }
      };

      ws.onerror = function () { onStatus("error"); };

      ws.onclose = function () {
        clearInterval(heartbeat);
        onStatus("disconnected");
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (closed) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 60000);   // capped exponential backoff
    }

    function send(topic, event, payload) {
      if (!ws || ws.readyState !== 1) return;
      // Protocol v2 (what supabase-js speaks): [join_ref, ref, topic, event, payload]
      var isChannelMsg = topic !== "phoenix";
      ws.send(JSON.stringify([isChannelMsg ? joinRef : null, String(++ref), topic, event, payload]));
    }

    function close() {
      closed = true;
      clearInterval(heartbeat);
      if (ws) try { ws.close(); } catch (e) {}
    }

    connect();
    return { close: close };
  }

  return {
    getConnection: getConnection,
    setConnection: setConnection,
    isConfigured: isConfigured,
    signUpWithPassword: signUpWithPassword,
    signInWithPassword: signInWithPassword,
    signInWithGoogle: signInWithGoogle,
    signOut: signOut,
    getUser: getUser,
    getValidSession: getValidSession,
    refreshSession: refreshSession,
    select: select,
    insert: insert,
    update: update,
    remove: remove,
    rpc: rpc,
    createRealtimeChannel: createRealtimeChannel,
  };
});
