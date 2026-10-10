/* eslint-disable */
/**
 * Shadow AI Guard — Runtime guard for content scripts
 * ===================================================
 * When the extension is reloaded or updated while an AI tab is open,
 * Chrome cuts the old content scripts off from the extension: every
 * chrome.runtime call then throws "Extension context invalidated", and
 * Chrome does not re-inject the new version into tabs already open.
 *
 * Two things fix that:
 *   1. The service worker re-injects the scripts into open AI tabs on
 *      install/update (see reinjectIntoOpenTabs in service-worker.js).
 *   2. Every injected copy claims the page with its own instance id.
 *      Only the copy that holds the claim acts; an orphaned older copy
 *      sees it has been replaced and stays silent instead of showing a
 *      second dialog or throwing errors.
 *
 * If re-injection didn't happen, the orphaned copy still holds the claim
 * and keeps protecting the tab locally (detection needs no extension
 * calls); it just can't report events until the page is refreshed.
 *
 * Every extension call goes through here so none of them can throw.
 */
(function (root) {
  "use strict";

  var ATTR = "data-sag-instance";
  var instanceId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  /** Is this copy still connected to the extension? */
  function alive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** Mark this copy as the one that protects the page. */
  function claim() {
    try { document.documentElement.setAttribute(ATTR, instanceId); } catch (e) {}
  }

  /** True while no newer copy has taken over the page. */
  function isCurrent() {
    try {
      return document.documentElement.getAttribute(ATTR) === instanceId;
    } catch (e) {
      return false;
    }
  }

  /** chrome.runtime.getURL that returns null instead of throwing. */
  function getURL(path) {
    if (!alive()) return null;
    try { return chrome.runtime.getURL(path); } catch (e) { return null; }
  }

  /** chrome.runtime.sendMessage that always resolves, never throws. */
  function sendMessage(message) {
    return new Promise(function (resolve) {
      if (!alive()) return resolve({ ok: false, error: "context_invalidated" });
      try {
        chrome.runtime.sendMessage(message, function (response) {
          var err = null;
          try { err = chrome.runtime.lastError; } catch (e) { err = { message: "context_invalidated" }; }
          if (err) return resolve({ ok: false, error: err.message });
          resolve(response || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: "context_invalidated" });
      }
    });
  }

  var api = {
    instanceId: instanceId,
    alive: alive,
    claim: claim,
    isCurrent: isCurrent,
    getURL: getURL,
    sendMessage: sendMessage,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ShadowAIRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
