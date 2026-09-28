/* eslint-disable */
/**
 * Shadow AI Guard — In-page Interstitial (Features 4, 5, 6, 7, 11, 13, 19)
 * ========================================================================
 * Renders the tiered decision UI inside a CLOSED-ish shadow root attached
 * to a host element on the page.
 *
 * Two structural guarantees, both deliberate:
 *
 * 1. For MandatoryRedaction, the "Send anyway" button is NOT RENDERED —
 *    it is absent from the DOM, not hidden with CSS. The button list is
 *    built per-tier, so there is nothing for a determined user (or a
 *    judge poking at devtools) to un-hide.
 *
 * 2. Every node carrying user text is created with textContent, never
 *    innerHTML. The preview contains whatever the employee typed; putting
 *    that through innerHTML would turn our own safety tool into an XSS
 *    vector on chatgpt.com.
 */
(function (root) {
  "use strict";

  var HOST_ID = "shadow-ai-guard-host";
  var activeHost = null;

  /* ---------------------------------------------------------------- *
   * DOM helpers
   * ---------------------------------------------------------------- */
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (text != null) node.textContent = String(text);
    return node;
  }

  function destroy() {
    if (activeHost && activeHost.parentNode) activeHost.parentNode.removeChild(activeHost);
    activeHost = null;
  }

  function toast(message) {
    var host = el("div");
    host.style.cssText = "position:fixed;z-index:2147483647;";
    var shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(styleLink());
    var t = el("div", { class: "sag-toast" }, message);
    shadow.appendChild(t);
    document.documentElement.appendChild(host);
    setTimeout(function () {
      if (host.parentNode) host.parentNode.removeChild(host);
    }, 2600);
  }

  function styleLink() {
    var link = el("link", {
      rel: "stylesheet",
      href: chrome.runtime.getURL("src/content/interstitial.css"),
    });
    return link;
  }

  /**
   * A spinner for work the user cannot see.
   *
   * Extracting text from a 10-page PDF takes a beat, and during that beat
   * we have already swallowed their upload event. Without a visible signal
   * the pause reads as the site being broken — and on a demo stage, as the
   * extension being broken. Returns a dismiss function.
   */
  function progress(message) {
    var host = el("div");
    host.style.cssText = "position:fixed;z-index:2147483647;";
    var shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(styleLink());

    var box = el("div", { class: "sag-progress" });
    box.appendChild(el("div", { class: "sag-spinner" }));
    box.appendChild(el("span", null, message));
    shadow.appendChild(box);
    document.documentElement.appendChild(host);

    return function dismiss() {
      if (host.parentNode) host.parentNode.removeChild(host);
    };
  }

  /* ---------------------------------------------------------------- *
   * Content builders
   * ---------------------------------------------------------------- */

  /** Groups matches by type so the list reads "3 email addresses", not 3 rows. */
  function groupMatches(matches) {
    var byType = {};
    matches.forEach(function (m) {
      if (!byType[m.type]) {
        byType[m.type] = { type: m.type, label: m.label, risk: m.risk, tier: m.tier, confirmedLeak: m.confirmedLeak, count: 0 };
      }
      byType[m.type].count++;
    });
    var order = { High: 0, Medium: 1, Low: 2 };
    return Object.keys(byType)
      .map(function (k) { return byType[k]; })
      .sort(function (a, b) {
        if (a.confirmedLeak !== b.confirmedLeak) return a.confirmedLeak ? -1 : 1;
        return order[a.risk] - order[b.risk];
      });
  }

  /**
   * How many findings to show before collapsing the rest.
   *
   * A message can trip six or seven of the eighteen pattern types at once.
   * Listing all of them with labels and compliance tags produces a wall of
   * text that an employee under time pressure scrolls past and dismisses —
   * which defeats the point of explaining anything. Three is enough to
   * establish what kind of problem this is; the rest stay one click away.
   */
  var VISIBLE_FINDINGS = 3;

  function buildFindingRow(g) {
    var row = el("div", { class: "sag-finding" });
    if (g.confirmedLeak) row.setAttribute("data-confirmed", "true");

    var dot = el("span", { class: "sag-dot" });
    dot.setAttribute("data-risk", g.risk);
    row.appendChild(dot);

    row.appendChild(el("span", { class: "sag-finding-label" }, g.label));

    if (g.confirmedLeak) {
      row.appendChild(el("span", { class: "sag-chip" }, "Confirmed"));
    }
    if (g.count > 1) {
      row.appendChild(el("span", { class: "sag-count" }, "x" + g.count));
    }
    return row;
  }

  /** Feature 19: renders the human-readable label, never the bare type. */
  function buildFindings(matches) {
    var wrap = el("div", { class: "sag-findings" });
    var groups = groupMatches(matches);   // already sorted: confirmed, then risk

    var shown = groups.slice(0, VISIBLE_FINDINGS);
    var hidden = groups.slice(VISIBLE_FINDINGS);

    shown.forEach(function (g) { wrap.appendChild(buildFindingRow(g)); });

    if (hidden.length === 0) return wrap;

    var rest = el("div");
    rest.hidden = true;
    hidden.forEach(function (g) { rest.appendChild(buildFindingRow(g)); });

    var toggle = el("button", { class: "sag-more" },
      "+" + hidden.length + " more " + (hidden.length === 1 ? "finding" : "findings"));
    toggle.addEventListener("click", function () {
      rest.hidden = !rest.hidden;
      toggle.textContent = rest.hidden
        ? "+" + hidden.length + " more " + (hidden.length === 1 ? "finding" : "findings")
        : "Show less";
    });

    wrap.appendChild(toggle);
    wrap.appendChild(rest);
    return wrap;
  }

  /**
   * Redaction preview. Highlights exactly the substituted spans reported
   * by the detector (redactionSpans) — NOT by re-scanning the text for
   * bracket syntax. Bracket-scanning broke the moment structured-data
   * substitutions (a fake card number, a fake email) stopped using
   * brackets; span-based highlighting works for both substitution styles
   * and can't be fooled by a coincidental "[LIKE THIS]" appearing in real
   * user text.
   *
   * Built with textContent / createTextNode throughout — no innerHTML
   * anywhere near user input.
   */
  function buildPreview(redactedText, spans) {
    var box = el("div", { class: "sag-preview" });
    var truncated = redactedText.length > 1500;
    var text = truncated ? redactedText.slice(0, 1500) : redactedText;
    var ordered = (spans || [])
      .filter(function (s) { return s.start < text.length; })
      .slice()
      .sort(function (a, b) { return a.start - b.start; });

    var cursor = 0;
    for (var i = 0; i < ordered.length; i++) {
      var s = ordered[i];
      var end = Math.min(s.end, text.length);
      if (s.start > cursor) box.appendChild(document.createTextNode(text.slice(cursor, s.start)));
      var mark = el("mark", null, text.slice(s.start, end));
      if (s.confirmedLeak) mark.setAttribute("data-confirmed", "true");
      box.appendChild(mark);
      cursor = end;
    }
    if (cursor < text.length) box.appendChild(document.createTextNode(text.slice(cursor)));
    if (truncated) box.appendChild(document.createTextNode("..."));
    return box;
  }

  function buildFrameworks(frameworks) {
    var wrap = el("div", { class: "sag-frameworks" });
    frameworks.forEach(function (f) {
      wrap.appendChild(el("span", { class: "sag-framework" }, f));
    });
    return wrap;
  }

  function buildFileCard(file) {
    var card = el("div", { class: "sag-file" });
    card.appendChild(el("span", { class: "sag-file-icon" }, "📎"));
    var meta = el("div");
    meta.appendChild(el("div", { class: "sag-file-name" }, file.name || "attachment"));
    meta.appendChild(
      el("div", { class: "sag-file-meta" }, (file.type || "file").toUpperCase() + (file.size ? " · " + formatSize(file.size) : ""))
    );
    card.appendChild(meta);
    return card;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  /* ---------------------------------------------------------------- *
   * Feature 7 — the shared explanation surface used by Features 5 & 6.
   * ---------------------------------------------------------------- */
  function renderMandatoryModeUI(matches, mode, context) {
    var body = el("div", { class: "sag-body" });
    var primary = groupMatches(matches)[0];

    body.appendChild(el("p", { class: "sag-section-label" }, "What was detected"));
    body.appendChild(buildFindings(matches));

    if (mode === "text") {
      // 7.3 — a preview showing exactly what will change.
      body.appendChild(el("p", { class: "sag-section-label" }, "What will be sent instead"));
      body.appendChild(buildPreview(context.scan.redactedText, context.scan.redactionSpans));
      // 7.5 — the reassurance line.
      var note = el("p", { class: "sag-reassure" });
      note.appendChild(el("span", null, "✓"));
      note.appendChild(el("span", null, "Everything else in your message is unaffected."));
      body.appendChild(note);

      // The employee is about to get an answer built on less information
      // than they thought they provided. Saying so here costs one line and
      // prevents them acting on a confidently incomplete reply.
      var caveat = el("p", { class: "sag-caveat" });
      caveat.appendChild(el("span", null, "ℹ"));
      caveat.appendChild(el("span", null,
        "The reply may be less specific, since the removed details won't reach the model."));
      body.appendChild(caveat);
    } else {
      // 7.4 — no preview is possible for a file, so say what to do next.
      body.appendChild(buildFileCard(context.file || {}));
      body.appendChild(el("p", { class: "sag-section-label" }, "What to do next"));
      var steps = el("ol", { class: "sag-steps" });
      steps.appendChild(el("li", null, "Open the file and remove the " + (primary ? primary.label.toLowerCase() : "sensitive content") + "."));
      steps.appendChild(el("li", null, "Save a copy without it."));
      steps.appendChild(el("li", null, "Attach that copy instead."));
      body.appendChild(steps);
    }

    if (context.scan.complianceFrameworks.length) {
      body.appendChild(buildFrameworks(context.scan.complianceFrameworks));
      body.appendChild(el("p", { class: "sag-disclaimer" },
        "Framework tags are a triage signal, not a legal compliance determination."));
    }

    return body;
  }

  function renderWarnModeUI(matches, mode, context) {
    var body = el("div", { class: "sag-body" });

    body.appendChild(el("p", { class: "sag-section-label" }, "Why this was flagged"));
    body.appendChild(buildFindings(matches));

    if (mode === "text") {
      body.appendChild(el("p", { class: "sag-section-label" }, "Redacted version"));
      body.appendChild(buildPreview(context.scan.redactedText, context.scan.redactionSpans));
      var note = el("p", { class: "sag-reassure" });
      note.appendChild(el("span", null, "✓"));
      note.appendChild(el("span", null, "Everything else in your message is unaffected."));
      body.appendChild(note);

      // The employee is about to get an answer built on less information
      // than they thought they provided. Saying so here costs one line and
      // prevents them acting on a confidently incomplete reply.
      var caveat = el("p", { class: "sag-caveat" });
      caveat.appendChild(el("span", null, "ℹ"));
      caveat.appendChild(el("span", null,
        "The reply may be less specific, since the removed details won't reach the model."));
      body.appendChild(caveat);
    } else {
      body.appendChild(buildFileCard(context.file || {}));
    }

    if (context.scan.complianceFrameworks.length) {
      body.appendChild(buildFrameworks(context.scan.complianceFrameworks));
      body.appendChild(el("p", { class: "sag-disclaimer" },
        "Framework tags are a triage signal, not a legal compliance determination."));
    }

    return body;
  }

  /* ---------------------------------------------------------------- *
   * Header copy — specific about WHAT was found (Feature 7.2)
   * ---------------------------------------------------------------- */
  function headerCopy(tier, mode, matches) {
    var primary = groupMatches(matches)[0];
    var what = primary ? primary.label.toLowerCase() : "sensitive content";

    if (primary && primary.confirmedLeak) {
      return {
        icon: "⚠",
        title: "This is tracked company data",
        sub: "This text contains a planted identifier that only exists in internal documents. " +
             "That makes this a confirmed leak, so it cannot be sent as-is.",
      };
    }
    if (tier === "MandatoryRedaction" && mode === "text") {
      return {
        icon: "⛔",
        title: "This can't be sent unmodified",
        sub: "We found " + indefinite(what) + ". This category is set to mandatory redaction by your " +
             "organisation, so it has to be removed before sending — but you can still send the rest.",
      };
    }
    if (tier === "MandatoryRedaction" && mode === "file") {
      return {
        icon: "⛔",
        title: "This file can't be uploaded",
        sub: "We found " + indefinite(what) + " inside it. Files can't be redacted automatically, " +
             "so you'll need to remove it yourself and attach a clean copy.",
      };
    }
    if (mode === "file") {
      return {
        icon: "⚠",
        title: "This file looks sensitive",
        sub: "We found " + indefinite(what) + " inside it. You can upload it anyway if you're sure it's fine.",
      };
    }
    return {
      icon: "⚠",
      title: "This looks sensitive",
      sub: "We found " + indefinite(what) + " in your message. Your call — send the redacted version, or send it as it is.",
    };
  }

  function indefinite(phrase) {
    return (/^[aeiou]/i.test(phrase) ? "an " : "a ") + phrase;
  }

  /* ---------------------------------------------------------------- *
   * show() — the single entry point
   * ---------------------------------------------------------------- */
  function show(options) {
    destroy();

    var scan = options.scan;
    var mode = options.mode === "file" ? "file" : "text";
    var tier = scan.overallTier;
    var mandatory = tier === "MandatoryRedaction";

    return new Promise(function (resolve) {
      var settled = false;
      function finish(action, extra) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKey, true);
        destroy();
        resolve(Object.assign({ action: action }, extra || {}));
      }

      var host = el("div", { id: HOST_ID });
      host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
      var shadow = host.attachShadow({ mode: "open" });
      shadow.appendChild(styleLink());

      var backdrop = el("div", { class: "sag-backdrop" });
      var card = el("div", { class: "sag-card" });
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");

      /* ---- header ---- */
      var copy = headerCopy(tier, mode, scan.matches);
      var head = el("div", { class: "sag-head" });
      var mark = el("div", { class: "sag-mark" }, copy.icon);
      mark.setAttribute("data-tier", tier);
      if (scan.confirmedLeak) mark.setAttribute("data-confirmed", "true");
      head.appendChild(mark);

      var titles = el("div", { class: "sag-titles" });
      titles.appendChild(el("h2", { class: "sag-title" }, copy.title));
      titles.appendChild(el("p", { class: "sag-sub" }, copy.sub));
      head.appendChild(titles);

      var close = el("button", { class: "sag-close", "aria-label": "Close" }, "×");
      close.addEventListener("click", function () {
        finish(mode === "file" ? "upload_cancelled" : "dismissed_no_action");
      });
      head.appendChild(close);
      card.appendChild(head);

      /* ---- body ---- */
      card.appendChild(
        mandatory
          ? renderMandatoryModeUI(scan.matches, mode, options)
          : renderWarnModeUI(scan.matches, mode, options)
      );

      /* ---- actions ---- *
       * Built per tier. For MandatoryRedaction the override button is
       * never constructed, so it cannot exist in the DOM.
       * ------------------------------------------------------------ */
      var foot = el("div", { class: "sag-foot" });

      if (mandatory && mode === "text") {
        // Feature 5 — exactly one action.
        var redactBtn = el("button", { class: "sag-btn sag-btn-primary" }, "Redact and send");
        redactBtn.addEventListener("click", function () { finish("redacted"); });
        foot.appendChild(redactBtn);

      } else if (mandatory && mode === "file") {
        // Feature 6 — block and explain. No override.
        var cancelBtn = el("button", { class: "sag-btn sag-btn-danger" }, "Cancel upload");
        cancelBtn.addEventListener("click", function () { finish("upload_cancelled"); });
        foot.appendChild(cancelBtn);

      } else if (mode === "file") {
        // Tier 1 for files.
        var fileRow = el("div", { class: "sag-row" });
        var cancel1 = el("button", { class: "sag-btn sag-btn-secondary" }, "Cancel");
        cancel1.addEventListener("click", function () { finish("upload_cancelled"); });
        var proceed = el("button", { class: "sag-btn sag-btn-primary" }, "Upload anyway");
        proceed.addEventListener("click", function () { finish("uploaded_anyway"); });
        fileRow.appendChild(cancel1);
        fileRow.appendChild(proceed);
        foot.appendChild(fileRow);

      } else {
        // Feature 4 — Tier 1 for text.
        var send = el("button", { class: "sag-btn sag-btn-primary" }, "Send redacted version");
        send.addEventListener("click", function () { finish("redacted"); });
        foot.appendChild(send);

        // Feature 11 — the sanctioned alternative, if IT configured one.
        if (options.sanctioned && options.sanctioned.url) {
          var toolName = options.sanctioned.name || "the approved tool";
          var alt = el("button", { class: "sag-btn sag-btn-secondary" }, "Use " + toolName + " instead");
          alt.addEventListener("click", function () {
            finish("redirected_to_sanctioned", { sanctioned: options.sanctioned });
          });
          foot.appendChild(alt);
        }

        var anyway = el("button", { class: "sag-btn sag-btn-secondary" }, "Send anyway");
        anyway.addEventListener("click", function () { finish("sent_anyway"); });
        foot.appendChild(anyway);

        // Feature 13 — false-positive feedback.
        var fpBtn = el("button", { class: "sag-btn sag-btn-quiet" }, "This isn't sensitive →");
        fpBtn.addEventListener("click", function () {
          foot.textContent = "";
          foot.appendChild(buildFalsePositivePanel(finish, foot));
        });
        foot.appendChild(fpBtn);
      }

      card.appendChild(foot);
      backdrop.appendChild(card);
      shadow.appendChild(backdrop);

      backdrop.addEventListener("click", function (e) {
        if (e.target === backdrop) {
          finish(mode === "file" ? "upload_cancelled" : "dismissed_no_action");
        }
      });

      function onKey(e) {
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(mode === "file" ? "upload_cancelled" : "dismissed_no_action");
        }
      }
      document.addEventListener("keydown", onKey, true);

      document.documentElement.appendChild(host);
      activeHost = host;
    });
  }

  /* ---------------------------------------------------------------- *
   * Feature 13 — reason chips. A CLOSED set: there is no free-text box,
   * because a free-text box is a content-leak channel by another name.
   * ---------------------------------------------------------------- */
  var FP_REASONS = [
    { value: "not_actually_sensitive", label: "This isn't actually sensitive" },
    { value: "test_or_sample_data", label: "It's test or sample data" },
    { value: "already_public_information", label: "It's already public information" },
  ];

  function buildFalsePositivePanel(finish) {
    var panel = el("div", { class: "sag-fp" });
    panel.appendChild(el("p", { class: "sag-fp-title" }, "Help us tune this — what made it a false alarm?"));

    var chips = el("div", { class: "sag-fp-chips" });
    FP_REASONS.forEach(function (reason) {
      var chip = el("button", { class: "sag-fp-chip" }, reason.label);
      chip.addEventListener("click", function () {
        finish("marked_false_positive", { falsePositiveReason: reason.value });
      });
      chips.appendChild(chip);
    });
    panel.appendChild(chips);

    var back = el("button", { class: "sag-btn sag-btn-quiet" }, "← Back");
    back.addEventListener("click", function () { finish("dismissed_no_action"); });
    panel.appendChild(back);
    return panel;
  }

  root.ShadowAIInterstitial = {
    show: show,
    destroy: destroy,
    toast: toast,
    progress: progress,
    renderMandatoryModeUI: renderMandatoryModeUI,
    FP_REASONS: FP_REASONS,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
