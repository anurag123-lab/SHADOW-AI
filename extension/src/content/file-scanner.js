/* eslint-disable */
/**
 * Shadow AI Guard — File Upload Interception (Feature 2, 6)
 * =========================================================
 * Catches a file BEFORE the host site uploads it, extracts text, runs the
 * same detector, and either resumes or blocks.
 *
 * The hard part is resuming. Once we swallow the original event to buy
 * time for async extraction, we have to hand the file back convincingly:
 *
 *   - file input: re-dispatch `change` on the same input, with the File
 *     recorded in a WeakSet so our own listener ignores it the second
 *     time. Without that guard this loops forever.
 *   - drag & drop: rebuild a DataTransfer and re-dispatch a DragEvent.
 *     This is BEST EFFORT and documented as such — some sites read the
 *     drop from a React synthetic event we cannot reproduce exactly.
 *     When it fails the user sees a toast telling them to re-attach,
 *     which is honest, rather than a file that silently vanished.
 */
(function (root) {
  "use strict";

  var Detector = root.ShadowAIDetector;
  var Extractor = root.ShadowAIFileExtractor;
  var UI = root.ShadowAIInterstitial;

  var cleared = new WeakSet();     // Files already approved — do not re-intercept
  var hooks = null;
  var busy = false;

  function log() {
    console.log.apply(console, ["[ShadowAI:files]"].concat(Array.prototype.slice.call(arguments)));
  }

  /* ================================================================ *
   * Interception
   * ================================================================ */
  function onFileInputChange(e) {
    var input = e.target;
    if (!input || input.type !== "file") return;

    var files = Array.prototype.slice.call(input.files || []);
    if (files.length === 0) return;
    if (files.every(function (f) { return cleared.has(f); })) return;   // our own re-dispatch
    if (busy) return;

    e.stopPropagation();
    e.stopImmediatePropagation();

    processFiles(files, function resume() {
      files.forEach(function (f) { cleared.add(f); });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, function cancel() {
      try { input.value = ""; } catch (err) {}
    });
  }

  function onDrop(e) {
    if (busy) return;
    var dt = e.dataTransfer;
    if (!dt) return;

    var files = Array.prototype.slice.call(dt.files || []);
    if (files.length === 0) return;
    if (files.every(function (f) { return cleared.has(f); })) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var target = e.target;

    processFiles(files, function resume() {
      files.forEach(function (f) { cleared.add(f); });
      var replay = new DataTransfer();
      files.forEach(function (f) { replay.items.add(f); });
      var ok = target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: replay })
      );
      if (!ok) {
        UI.toast("Checked and cleared — please drop the file again");
      }
    }, function cancel() {
      /* nothing to undo: the drop never reached the page */
    });
  }

  /* ================================================================ *
   * Scan pipeline
   * ================================================================ */
  async function processFiles(files, resume, cancel) {
    busy = true;
    try {
      for (var i = 0; i < files.length; i++) {
        var verdict = await processOne(files[i]);
        if (verdict === "cancel") { cancel(); return; }
      }
      resume();
    } finally {
      busy = false;
    }
  }

  async function processOne(file) {
    var ext = Extractor.extensionOf(file.name);

    // We have already swallowed the upload event, so the page looks frozen
    // until extraction finishes. Say what is happening.
    var done = UI.progress("Checking " + file.name + "…");
    var extraction;
    try {
      extraction = await Extractor.extract(file);
    } finally {
      done();
    }

    // ---- Unsupported: FAIL OPEN, loudly ----
    if (!extraction.supported) {
      log('"' + file.name + '" not scanned:', extraction.reason);
      UI.toast("ℹ " + file.name + " couldn't be checked (" + shortReason(extraction.reason) + ")");
      hooks.logEvent(
        { riskLevel: "Low", overallTier: null, patternTypes: [], complianceFrameworks: [], confirmedLeak: false },
        { aiTool: hooks.host, source: "file", fileName: file.name, fileType: ext, action: "uploaded_anyway" }
      );
      return "resume";
    }

    var result = Detector.scan(extraction.text);
    log('"' + file.name + '" scanned:', result.riskLevel, result.patternTypes.join(",") || "clean");

    if (result.riskLevel === "None") return "resume";

    // System-initiated log at detection time, before the user acts.
    if (result.overallTier === "MandatoryRedaction") {
      hooks.logEvent(result, {
        aiTool: hooks.host, source: "file", fileName: file.name, fileType: ext, action: "blocked",
      });
    }

    var outcome = await UI.show({
      mode: "file",
      scan: result,
      file: { name: file.name, type: ext, size: file.size },
    });

    hooks.logEvent(result, {
      aiTool: hooks.host,
      source: "file",
      fileName: file.name,
      fileType: ext,
      action: outcome.action,
      falsePositiveReason: outcome.falsePositiveReason,
    });

    return outcome.action === "uploaded_anyway" ? "resume" : "cancel";
  }

  function shortReason(reason) {
    return String(reason).split("—")[0].trim().slice(0, 60);
  }

  /* ================================================================ *
   * Boot
   * ================================================================ */
  function init(providedHooks) {
    hooks = providedHooks;

    // Capture phase, so we run before the host site's own handlers.
    document.addEventListener("change", onFileInputChange, true);
    document.addEventListener("drop", onDrop, true);

    // A dragover that isn't prevented cancels the drop entirely; the host
    // site normally does this, but not always on every drop target.
    document.addEventListener("dragover", function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1) {
        e.preventDefault();
      }
    }, true);

    log("file interception active");
  }

  root.ShadowAIFileScanner = { init: init };
})(typeof globalThis !== "undefined" ? globalThis : window);
