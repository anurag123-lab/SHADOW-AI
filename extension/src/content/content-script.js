/* eslint-disable */
/**
 * Shadow AI Guard — Content Script (Feature 1)
 * ============================================
 * Watches the AI tool's composer, scans locally, and interrupts the send.
 *
 * A note on WHEN we interrupt. The spec says "scan text as the employee
 * types it, before it is sent". Scanning on every debounced keystroke but
 * only INTERRUPTING at send time is the correct reading: a modal that
 * appears mid-sentence, before someone has finished writing the thing we
 * are judging, trains people to dismiss it reflexively. So:
 *
 *   - debounced 500ms scan on input  -> keeps a warm result + status pill
 *   - send attempt (Enter / button)  -> interrupt, decide, then act
 *
 * The scan is synchronous and local. Nothing here is awaited on a server.
 */
(function () {
  "use strict";

  var Detector = window.ShadowAIDetector;
  var UI = window.ShadowAIInterstitial;

  if (!Detector || !UI) {
    console.error("[ShadowAI] core scripts failed to load");
    return;
  }

  var DEBOUNCE_MS = 500;
  var HOST = location.hostname.replace(/^www\./, "");

  var config = null;          // scan config from the service worker
  var lastScan = null;        // most recent debounced result
  var debounceTimer = null;
  var bypassNext = false;     // set when WE are the ones dispatching the send
  var busy = false;

  /* ================================================================ *
   * Composer discovery
   * ================================================================ */
  var COMPOSER_SELECTORS = [
    '#prompt-textarea',                          // chatgpt.com
    'div[contenteditable="true"][translate="no"]', // claude.ai
    'div.ql-editor[contenteditable="true"]',      // gemini
    'textarea[data-testid="composer-input"]',
    'main div[contenteditable="true"]',
    'form textarea',
    'textarea',
  ];

  var SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[type="submit"]',
  ];

  function findComposer() {
    for (var i = 0; i < COMPOSER_SELECTORS.length; i++) {
      var node = document.querySelector(COMPOSER_SELECTORS[i]);
      if (node && isVisible(node)) return node;
    }
    return null;
  }

  function isVisible(node) {
    var rect = node.getBoundingClientRect();
    return rect.width > 40 && rect.height > 10;
  }

  function findSendButton(composer) {
    var scope = (composer && composer.closest("form")) || document;
    for (var i = 0; i < SEND_BUTTON_SELECTORS.length; i++) {
      var btn = scope.querySelector(SEND_BUTTON_SELECTORS[i]) || document.querySelector(SEND_BUTTON_SELECTORS[i]);
      if (btn && !btn.disabled) return btn;
    }
    return null;
  }

  function readComposer(node) {
    if (!node) return "";
    if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") return node.value || "";
    return node.innerText || node.textContent || "";
  }

  /**
   * Writing back into a React-controlled composer is the fiddly part.
   * For textareas we go through the native value setter so React's
   * onChange sees it; for contenteditable we use execCommand("insertText"),
   * which produces the same input events a human would.
   */
  /** Whitespace-insensitive comparison — editors normalise newlines. */
  function sameText(a, b) {
    return String(a).replace(/\s+/g, " ").trim() === String(b).replace(/\s+/g, " ").trim();
  }

  function selectAll(node) {
    node.focus();
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Writes text back into the composer and VERIFIES it took.
   *
   * This must return the truth. ChatGPT uses a plain textarea, but Claude
   * and Gemini use framework-controlled contenteditable editors that keep
   * their own copy of the value — an editor can accept a DOM mutation
   * visually and still submit its own internal state. If we reported
   * success there, we would show the employee a redacted preview and then
   * send the original. That is the exact failure this product exists to
   * prevent, so every strategy below is followed by a read-back check and
   * the caller refuses to send when all of them fail.
   *
   * @returns {boolean} true only if the composer actually holds `text`
   */
  function writeComposer(node, text) {
    if (!node) return false;

    // ---- Plain textarea / input: native setter so React's onChange sees it
    if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") {
      var proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(node, text);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return sameText(node.value, text);
    }

    // ---- contenteditable: three strategies, each verified.

    // 1. execCommand("insertText") — produces the same beforeinput/input
    //    sequence a human keystroke does, which is what React, ProseMirror
    //    and Lexical actually listen to.
    try {
      selectAll(node);
      document.execCommand("insertText", false, text);
      if (sameText(readComposer(node), text)) return true;
    } catch (e) { /* fall through */ }

    // 2. Synthetic paste. Rich editors implement onPaste explicitly and
    //    route it through their own state layer, so this succeeds on some
    //    editors that ignore execCommand.
    try {
      selectAll(node);
      var dt = new DataTransfer();
      dt.setData("text/plain", text);
      node.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
      if (sameText(readComposer(node), text)) return true;
    } catch (e) { /* fall through */ }

    // 3. Direct DOM write plus a synthetic input event. Last resort: this
    //    updates what is displayed, which a framework may still override.
    try {
      node.textContent = text;
      node.dispatchEvent(new InputEvent("input", {
        bubbles: true, data: text, inputType: "insertText",
      }));
      if (sameText(readComposer(node), text)) return true;
    } catch (e) { /* fall through */ }

    return false;
  }

  /* ================================================================ *
   * Config
   * ================================================================ */
  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(response || { ok: false });
      });
    });
  }

  async function loadConfig() {
    var res = await send({ type: "GET_SCAN_CONFIG" });
    if (!res.ok) return null;
    config = res.data;

    Detector.setPolicyOverrides(config.policyOverrides || {});
    Detector.setHoneytokens(config.honeytokens || []);
    Detector.setCustomKeywords(config.customKeywords || []);

    console.log(
      "[ShadowAI] active on " + HOST + " —",
      Object.keys(config.policyOverrides || {}).length + " policies,",
      (config.honeytokens || []).length + " honeytokens,",
      (config.customKeywords || []).length + " custom keywords"
    );
    return config;
  }

  function isActive() {
    return config && config.enrolled && config.enabled;
  }

  /* ================================================================ *
   * Scanning
   * ================================================================ */
  function scanNow(text) {
    if (!isActive()) return null;
    var started = performance.now();
    var result = Detector.scan(text);
    var ms = performance.now() - started;
    if (ms > 100) console.debug("[ShadowAI] scan took " + ms.toFixed(1) + "ms");
    lastScan = { text: text, result: result, at: Date.now() };
    updatePill(result);
    return result;
  }

  function onInput(e) {
    if (!isActive()) return;
    clearTimeout(debounceTimer);
    var node = e.target;
    debounceTimer = setTimeout(function () {
      scanNow(readComposer(node));
    }, DEBOUNCE_MS);
  }

  /* ================================================================ *
   * Status pill — ambient feedback, not an interruption
   * ================================================================ */
  var pill = null;
  function updatePill(result) {
    if (!result || result.riskLevel === "None") {
      if (pill) { pill.remove(); pill = null; }
      return;
    }
    if (!pill) {
      pill = document.createElement("div");
      pill.style.cssText =
        "position:fixed;bottom:16px;right:16px;z-index:2147483646;padding:6px 11px;" +
        "border-radius:999px;font:500 12px ui-sans-serif,system-ui,sans-serif;" +
        "box-shadow:0 4px 14px rgba(16,24,40,.18);pointer-events:none;transition:opacity .2s;";
      document.documentElement.appendChild(pill);
    }
    var mandatory = result.overallTier === "MandatoryRedaction";
    pill.style.background = mandatory ? "#fee4e2" : "#fef0c7";
    pill.style.color = mandatory ? "#b42318" : "#b54708";
    pill.textContent =
      (mandatory ? "⛔ " : "⚠ ") +
      result.matches.length +
      (result.matches.length === 1 ? " item" : " items") +
      " will be checked before sending";
  }

  /* ================================================================ *
   * Send interception
   * ================================================================ */
  async function handleSendAttempt(composer, resumeFn) {
    if (busy) return false;

    var text = readComposer(composer);
    if (!text || text.trim().length === 0) return false;

    // Reuse the debounced result only if the text hasn't changed since.
    var result =
      lastScan && lastScan.text === text ? lastScan.result : scanNow(text);

    if (!result || result.riskLevel === "None") return false;   // let it through

    busy = true;
    try {
      var outcome = await UI.show({
        mode: "text",
        scan: result,
        sanctioned: config.identity
          ? { url: config.identity.sanctionedUrl, name: config.identity.sanctionedName }
          : null,
      });

      logEvent(result, {
        aiTool: HOST,
        source: "text",
        action: outcome.action,
        falsePositiveReason: outcome.falsePositiveReason,
      });

      if (outcome.action === "redacted") {
        var wrote = writeComposer(composer, result.redactedText);
        if (!wrote) {
          // FAIL CLOSED. Sending now would transmit the original text
          // while the employee believes it was redacted — worse than not
          // helping at all. Hand them the redacted version instead.
          console.warn("[ShadowAI] composer rejected the redacted text; refusing to send");
          try {
            await navigator.clipboard.writeText(result.redactedText);
            UI.toast("Couldn't rewrite the box automatically — redacted version copied, paste it over your message");
          } catch (e) {
            UI.toast("Couldn't rewrite the box automatically — please remove the flagged details yourself");
          }
          return true;
        }
        await wait(60);
        dispatchSend(composer);
      } else if (outcome.action === "sent_anyway" || outcome.action === "marked_false_positive") {
        dispatchSend(composer);
      } else if (outcome.action === "redirected_to_sanctioned") {
        await copyAndRedirect(result, outcome.sanctioned);
      }
      // dismissed_no_action: leave the composer untouched.
      return true;
    } finally {
      busy = false;
      if (pill) { pill.remove(); pill = null; }
      lastScan = null;
    }
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** Re-issues the send the user originally attempted, flagged to pass through. */
  function dispatchSend(composer) {
    bypassNext = true;
    var btn = findSendButton(composer);
    if (btn) {
      btn.click();
    } else {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
    setTimeout(function () { bypassNext = false; }, 1200);
  }

  /* ================================================================ *
   * Feature 11 — sanctioned tool redirect
   * ================================================================ */
  async function copyAndRedirect(result, sanctioned) {
    var toCopy = result.redactedText;
    try {
      await navigator.clipboard.writeText(toCopy);
      UI.toast("Redacted text copied — just paste it in");
    } catch (e) {
      UI.toast("Opening " + (sanctioned.name || "the approved tool") + " — copy your text over");
    }
    send({ type: "OPEN_SANCTIONED_TOOL", url: sanctioned.url });
  }

  /* ================================================================ *
   * Event logging — the scan result goes to the worker, which strips it
   * down to metadata via event-payload.js before anything is sent.
   * ================================================================ */
  function logEvent(result, context) {
    send({
      type: "LOG_EVENT",
      scan: {
        riskLevel: result.riskLevel,
        overallTier: result.overallTier,
        patternTypes: result.patternTypes,
        complianceFrameworks: result.complianceFrameworks,
        confirmedLeak: result.confirmedLeak,
      },
      context: context,
    });
  }

  /* ================================================================ *
   * Listeners
   * ================================================================ */
  function onKeyDown(e) {
    if (!isActive()) return;
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (bypassNext) return;

    var composer = e.target.closest ? e.target.closest('[contenteditable="true"], textarea, input') : null;
    if (!composer) composer = findComposer();
    if (!composer) return;

    var text = readComposer(composer);
    if (!text || text.trim().length === 0) return;

    var result = lastScan && lastScan.text === text ? lastScan.result : Detector.scan(text);
    if (!result || result.riskLevel === "None") return;   // nothing to say

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleSendAttempt(composer);
  }

  function onClick(e) {
    if (!isActive() || bypassNext) return;

    var btn = e.target.closest ? e.target.closest("button") : null;
    if (!btn) return;

    var looksLikeSend = SEND_BUTTON_SELECTORS.some(function (sel) {
      try { return btn.matches(sel); } catch (err) { return false; }
    });
    if (!looksLikeSend) return;

    var composer = findComposer();
    if (!composer) return;

    var text = readComposer(composer);
    if (!text || text.trim().length === 0) return;

    var result = lastScan && lastScan.text === text ? lastScan.result : Detector.scan(text);
    if (!result || result.riskLevel === "None") return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleSendAttempt(composer);
  }

  /* ================================================================ *
   * Boot
   * ================================================================ */
  function attach() {
    // Capture phase everywhere: we must run before the host app's own
    // handlers, or the message is already on its way to the model.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "SAG_CONFIG_CHANGED") {
      loadConfig();
    }
  });

  loadConfig().then(function () {
    attach();
    if (window.ShadowAIFileScanner && isActive()) {
      window.ShadowAIFileScanner.init({
        getConfig: function () { return config; },
        logEvent: logEvent,
        host: HOST,
      });
    }
  });
})();
