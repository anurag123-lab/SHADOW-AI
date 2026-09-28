/* eslint-disable */
/**
 * Shadow AI Guard — Extension Configuration
 * =========================================
 * The anon key is MEANT to be public. Supabase issues it for client-side
 * use; access control is Row Level Security (see 003_row_level_security.sql),
 * not key secrecy. The service_role key is the one that must never appear
 * in this directory — it bypasses RLS entirely and lives only in notifier/.env.
 *
 * Values can be overridden at runtime from the options page (stored in
 * chrome.storage.local), so you can demo on a machine without editing files.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ShadowAIConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  /* ============ PASTE YOUR PROJECT VALUES HERE ============ */
  var SUPABASE_URL = "https://rmqtazdvmbyzbnaokkmw.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtcXRhemR2bWJ5emJuYW9ra213Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNzk4MjgsImV4cCI6MjEwNTc1NTgyOH0.Ai5EemmVwa5UgyH-fGP4ce3xUEHKzl5cicYJpHZxY_s";
  /* ======================================================== */

  var STORAGE_KEYS = {
    connection: "sag_connection",       // { url, anonKey } runtime override
    session: "sag_session",             // { access_token, refresh_token, expires_at }
    identity: "sag_identity",           // { companyId, employeeHash, department, companyName, ... }
    policy: "sag_policy",               // { overrides, fetchedAt }
    honeytokens: "sag_honeytokens",     // { tokens, fetchedAt }
    customKeywords: "sag_keywords",     // { keywords, fetchedAt }
    queue: "sag_event_queue",           // offline event buffer
    settings: "sag_settings",           // { enabled, debug }
  };

  /** Sites where full content-level detection runs (Features 1, 2). */
  var MONITORED_HOSTS = [
    "chatgpt.com", "chat.openai.com",
    "claude.ai",
    "gemini.google.com", "bard.google.com",
    "copilot.microsoft.com",
  ];

  /** Feature 15: visit-signal only. No content inspection on these. */
  var DISCOVERY_HOSTS = [
    "perplexity.ai", "poe.com", "huggingface.co", "character.ai",
    "you.com", "chat.deepseek.com", "grok.com", "x.ai",
    "mistral.ai", "chat.mistral.ai", "pi.ai", "meta.ai",
    "phind.com", "chatbot.theb.ai", "writesonic.com", "jasper.ai",
  ];

  var SYNC_INTERVAL_MINUTES = 10;   // Feature 8 fallback poll
  var DEBOUNCE_MS = 500;            // Feature 1 requirement
  var MAX_QUEUE_SIZE = 200;         // offline buffer cap

  return {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    STORAGE_KEYS: STORAGE_KEYS,
    MONITORED_HOSTS: MONITORED_HOSTS,
    DISCOVERY_HOSTS: DISCOVERY_HOSTS,
    SYNC_INTERVAL_MINUTES: SYNC_INTERVAL_MINUTES,
    DEBOUNCE_MS: DEBOUNCE_MS,
    MAX_QUEUE_SIZE: MAX_QUEUE_SIZE,
    isConfigured: function (url, key) {
      return (
        typeof url === "string" && url.indexOf("YOUR-PROJECT-REF") === -1 &&
        typeof key === "string" && key.indexOf("YOUR-ANON-KEY") === -1 &&
        url.length > 10 && key.length > 20
      );
    },
  };
});
