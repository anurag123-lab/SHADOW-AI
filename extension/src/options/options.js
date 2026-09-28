/* eslint-disable */
/**
 * Shadow AI Guard — Options page
 * The playground runs the real detector against the real cached config,
 * so what you see here is exactly what would happen on chatgpt.com.
 */
(function () {
  "use strict";

  var Detector = window.ShadowAIDetector;
  var Config = window.ShadowAIConfig;
  var KEYS = Config.STORAGE_KEYS;
  var $ = function (id) { return document.getElementById(id); };

  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (r) {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(r || { ok: false });
      });
    });
  }

  function get(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (r) { resolve(r[key]); });
    });
  }

  /* ================================================================ *
   * Playground
   * ================================================================ */
  function groupMatches(matches) {
    var byType = {};
    matches.forEach(function (m) {
      if (!byType[m.type]) {
        byType[m.type] = { label: m.label, risk: m.risk, tier: m.tier, confirmedLeak: m.confirmedLeak, count: 0 };
      }
      byType[m.type].count++;
    });
    var order = { High: 0, Medium: 1, Low: 2 };
    return Object.keys(byType).map(function (k) { return byType[k]; })
      .sort(function (a, b) { return order[a.risk] - order[b.risk]; });
  }

  /** Same span-based approach as interstitial.js buildPreview() — see its comment. */
  function renderPreview(text, spans) {
    var box = $("preview");
    box.textContent = "";
    var ordered = (spans || []).slice().sort(function (a, b) { return a.start - b.start; });
    var cursor = 0;
    for (var i = 0; i < ordered.length; i++) {
      var s = ordered[i];
      if (s.start > cursor) box.appendChild(document.createTextNode(text.slice(cursor, s.start)));
      var mark = document.createElement("mark");
      mark.textContent = text.slice(s.start, s.end);
      if (s.confirmedLeak) mark.setAttribute("data-confirmed", "true");
      box.appendChild(mark);
      cursor = s.end;
    }
    if (cursor < text.length) box.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function runPlayground() {
    var text = $("playground").value;
    var verdict = $("verdict");
    var findings = $("findings");
    findings.textContent = "";

    if (!text.trim()) {
      verdict.hidden = true;
      $("previewWrap").hidden = true;
      return;
    }

    var result = Detector.scan(text);
    verdict.hidden = false;

    if (result.riskLevel === "None") {
      verdict.setAttribute("data-tier", "none");
      verdict.textContent = "✓ Nothing flagged — this would send normally, with no interruption.";
      $("previewWrap").hidden = true;
      return;
    }

    verdict.setAttribute("data-tier", result.overallTier);
    verdict.textContent =
      (result.overallTier === "MandatoryRedaction"
        ? "⛔ Mandatory redaction — no override available"
        : "⚠ Warning — the employee chooses") +
      " · " + result.riskLevel + " risk" +
      (result.complianceFrameworks.length ? " · " + result.complianceFrameworks.join(", ") : "");

    groupMatches(result.matches).forEach(function (g) {
      var row = document.createElement("div");
      row.className = "finding";
      if (g.confirmedLeak) row.setAttribute("data-confirmed", "true");

      var dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("data-risk", g.risk);
      row.appendChild(dot);

      var label = document.createElement("span");
      label.className = "finding-label";
      label.textContent = g.label + (g.count > 1 ? " (x" + g.count + ")" : "");
      row.appendChild(label);

      var tag = document.createElement("span");
      tag.className = "tag";
      if (g.confirmedLeak) {
        tag.setAttribute("data-confirmed", "true");
        tag.textContent = "Confirmed leak";
      } else {
        tag.setAttribute("data-tier", g.tier);
        tag.textContent = g.tier === "MandatoryRedaction" ? "Mandatory" : "Warn";
      }
      row.appendChild(tag);
      findings.appendChild(row);
    });

    $("previewWrap").hidden = false;
    renderPreview(result.redactedText, result.redactionSpans);
  }

  var debounce = null;
  $("playground").addEventListener("input", function () {
    clearTimeout(debounce);
    debounce = setTimeout(runPlayground, 250);
  });

  Array.prototype.forEach.call(document.querySelectorAll(".sample"), function (btn) {
    btn.addEventListener("click", function () {
      $("playground").value = btn.getAttribute("data-text");
      runPlayground();
    });
  });

  /* ================================================================ *
   * Connection
   * ================================================================ */
  $("saveBtn").addEventListener("click", async function () {
    var url = $("url").value.trim();
    var key = $("key").value.trim();
    var note = $("saveNote");
    if (!url || !key) {
      note.hidden = false;
      note.setAttribute("data-kind", "error");
      note.textContent = "Both fields are required.";
      return;
    }
    var res = await send({ type: "SET_CONNECTION", url: url, anonKey: key });
    note.hidden = false;
    note.setAttribute("data-kind", res.ok ? "ok" : "error");
    note.textContent = res.ok ? "Saved. Sign in from the extension popup." : res.error;
  });

  /* ================================================================ *
   * Cached config
   * ================================================================ */
  function row(label, value) {
    var r = document.createElement("div");
    r.className = "cache-row";
    var k = document.createElement("span");
    k.className = "cache-key";
    k.textContent = label;
    var v = document.createElement("span");
    v.className = "cache-val";
    v.textContent = value;
    r.appendChild(k);
    r.appendChild(v);
    return r;
  }

  function when(ts) {
    if (!ts) return "never";
    var mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    return Math.round(mins / 60) + " h ago";
  }

  async function renderCache() {
    var view = $("cacheView");
    view.textContent = "";

    var identity = await get(KEYS.identity);
    var policy = await get(KEYS.policy);
    var honeytokens = await get(KEYS.honeytokens);
    var keywords = await get(KEYS.customKeywords);
    var queue = (await get(KEYS.queue)) || [];
    var connection = await get(KEYS.connection);

    view.appendChild(row("Workspace", identity ? identity.companyName || "(unnamed)" : "not enrolled"));
    view.appendChild(row("Your anonymous ID", identity ? identity.employeeHash : "—"));
    view.appendChild(row("Department", identity ? identity.department : "—"));
    view.appendChild(row("Policy rules", policy ? Object.keys(policy.overrides || {}).length + " (synced " + when(policy.fetchedAt) + ")" : "none"));
    view.appendChild(row("Honeytokens", honeytokens ? (honeytokens.tokens || []).length : 0));
    view.appendChild(row("Custom keywords", keywords ? (keywords.keywords || []).length : 0));
    view.appendChild(row("Events queued offline", queue.length));
    view.appendChild(row("Sanctioned tool", identity && identity.sanctionedName ? identity.sanctionedName : "not configured"));

    if (connection && connection.url) $("url").value = connection.url;

    // Feed the playground the same config the content script would use.
    Detector.setPolicyOverrides((policy && policy.overrides) || {});
    Detector.setHoneytokens((honeytokens && honeytokens.tokens) || []);
    Detector.setCustomKeywords((keywords && keywords.keywords) || []);
  }

  $("syncBtn").addEventListener("click", async function () {
    this.disabled = true;
    this.textContent = "Syncing...";
    await send({ type: "FORCE_SYNC" });
    await renderCache();
    runPlayground();
    this.disabled = false;
    this.textContent = "Sync now";
  });

  renderCache();
})();
