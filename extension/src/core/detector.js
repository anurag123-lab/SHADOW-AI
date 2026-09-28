/* eslint-disable */
/**
 * Shadow AI Guard — Detection Engine
 * ==================================
 * The single detection path for BOTH typed text (Feature 1) and extracted
 * file text (Feature 2). There is deliberately no second implementation.
 *
 * Hard rules enforced here, in code, not by convention:
 *   - Fully synchronous. No network, no chrome.*, no DOM. A scan can
 *     never be delayed or influenced by a server being slow or down.
 *   - A honeytoken hit (Feature 3) resolves to MandatoryRedaction BEFORE
 *     policy overrides are consulted, so no policy can downgrade it.
 *   - Matched values live only inside the returned object, for the
 *     redaction preview. Nothing here builds a network payload.
 *
 * Loads as a classic content script (globalThis.ShadowAIDetector) and as
 * a Node CommonJS module (require) — same file, no build step.
 */
(function (root, factory) {
  var patterns =
    typeof module === "object" && module.exports
      ? require("./patterns.js")
      : root.ShadowAIPatterns;
  var api = factory(patterns);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ShadowAIDetector = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function (P) {
  "use strict";

  var RISK = P.RISK;
  var TIER = P.TIER;

  /** Guard against pathological input (a 5MB paste shouldn't freeze the tab). */
  var MAX_SCAN_LENGTH = 200000;

  /* ---------------------------------------------------------------- *
   * Mutable configuration — set by the extension at runtime.
   * ---------------------------------------------------------------- */
  var state = {
    honeytokens: [],
    customKeywords: [],
    policyOverrides: {},
  };

  function setHoneytokens(tokens) {
    state.honeytokens = (tokens || [])
      .filter(function (t) { return typeof t === "string" && t.trim().length >= 4; })
      .map(function (t) { return t.trim(); });
    return state.honeytokens.length;
  }

  function setCustomKeywords(keywords) {
    state.customKeywords = (keywords || [])
      .filter(function (k) { return typeof k === "string" && k.trim().length >= 2; })
      .map(function (k) { return k.trim(); });
    return state.customKeywords.length;
  }

  /**
   * Feature 8. Accepts { patternType: "Warn" | "MandatoryRedaction" }.
   * Unknown tier values are ignored rather than trusted — a malformed
   * policy row must never silently weaken enforcement.
   */
  function setPolicyOverrides(overrides) {
    var clean = {};
    Object.keys(overrides || {}).forEach(function (key) {
      var tier = overrides[key];
      if (tier === TIER.WARN || tier === TIER.MANDATORY) clean[key] = tier;
    });
    state.policyOverrides = clean;
    return clean;
  }

  function getConfig() {
    return {
      honeytokenCount: state.honeytokens.length,
      customKeywordCount: state.customKeywords.length,
      policyOverrides: Object.assign({}, state.policyOverrides),
    };
  }

  function reset() {
    state.honeytokens = [];
    state.customKeywords = [];
    state.policyOverrides = {};
  }

  /* ---------------------------------------------------------------- *
   * Tier resolution — Feature 3's non-negotiable rule lives HERE.
   * ---------------------------------------------------------------- */
  function tierFor(match) {
    // A confirmed leak is not a matter of policy. Checked first, and
    // returned before state.policyOverrides is even read.
    if (match && match.confirmedLeak === true) return TIER.MANDATORY;

    var override = state.policyOverrides[match.type];
    if (override) return override;
    return match.defaultTier || TIER.WARN;
  }

  /* ---------------------------------------------------------------- *
   * Matching helpers
   * ---------------------------------------------------------------- */
  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** \b only behaves correctly when the term edge is a word character. */
  function buildTermRegex(term) {
    var escaped = escapeRegExp(term);
    var left = /^\w/.test(term) ? "\\b" : "";
    var right = /\w$/.test(term) ? "\\b" : "";
    return new RegExp(left + escaped + right, "gi");
  }

  function pushMatch(list, def, value, index, extra) {
    var m = {
      type: def.type,
      label: def.label,
      risk: def.risk,
      defaultTier: def.defaultTier,
      redactAs: def.redactAs,
      value: value,           // LOCAL ONLY — for the redaction preview
      start: index,
      end: index + value.length,
      confirmedLeak: false,
      // Named patterns outrank the generic entropy rule on the same span,
      // so "sk-..." is reported as an API key, not as an unnamed blob.
      specificity: typeof def.specificity === "number" ? def.specificity : 2,
    };
    if (extra) Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
    m.tier = tierFor(m);
    list.push(m);
  }

  function scanRegexPatterns(text, out) {
    // The entropy rule runs last so that, on an equal span, the named
    // pattern is already in the list and wins the specificity tie-break.
    var defs = P.REGEX_PATTERNS.concat([P.ENTROPY_PATTERN]);
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i];
      var re = new RegExp(def.regex.source, def.regex.flags); // fresh lastIndex
      var m;
      var guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 500) {
        var value = m[0];
        if (value.length === 0) { re.lastIndex++; continue; }
        if (typeof def.validate === "function" && !def.validate(value)) continue;
        pushMatch(out, def, value, m.index);
      }
    }
  }

  function scanKeywordPatterns(text, out) {
    for (var i = 0; i < P.KEYWORD_PATTERNS.length; i++) {
      var def = P.KEYWORD_PATTERNS[i];
      for (var j = 0; j < def.keywords.length; j++) {
        var re = buildTermRegex(def.keywords[j]);
        var m;
        var guard = 0;
        while ((m = re.exec(text)) !== null && guard++ < 200) {
          pushMatch(out, def, m[0], m.index);
        }
      }
    }
  }

  function scanCustomKeywords(text, out) {
    var def = {
      type: "customKeyword",
      label: "Company-defined sensitive term",
      risk: RISK.MEDIUM,
      defaultTier: TIER.WARN,
      redactAs: "[COMPANY TERM REMOVED]",
    };
    for (var i = 0; i < state.customKeywords.length; i++) {
      var term = state.customKeywords[i];
      var re = buildTermRegex(term);
      var m;
      var guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 200) {
        pushMatch(out, def, m[0], m.index, { keyword: term });
      }
    }
  }

  /**
   * Feature 3. Literal substring match, case-insensitive: a honeytoken
   * pasted in a different case is still the same planted identifier.
   */
  function scanHoneytokens(text, out) {
    var haystack = text.toLowerCase();
    var def = {
      type: "honeytoken",
      label: "Planted tracking identifier — confirmed data leak",
      risk: RISK.HIGH,
      defaultTier: TIER.MANDATORY,
      redactAs: "[TRACKED IDENTIFIER REMOVED]",
    };
    for (var i = 0; i < state.honeytokens.length; i++) {
      var token = state.honeytokens[i];
      var needle = token.toLowerCase();
      var from = 0;
      var idx;
      var guard = 0;
      while ((idx = haystack.indexOf(needle, from)) !== -1 && guard++ < 100) {
        pushMatch(out, def, text.substr(idx, token.length), idx, { confirmedLeak: true });
        from = idx + needle.length;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Overlap resolution — keeps the redaction preview coherent when two
   * patterns cover the same characters (a phone inside a card number,
   * a honeytoken inside a confidential block).
   * ---------------------------------------------------------------- */
  var RISK_RANK = { None: 0, Low: 1, Medium: 2, High: 3 };

  function resolveOverlaps(matches) {
    var sorted = matches.slice().sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      var lenDiff = (b.end - b.start) - (a.end - a.start);
      if (lenDiff !== 0) return lenDiff;                    // longest wins
      if (a.confirmedLeak !== b.confirmedLeak) return a.confirmedLeak ? -1 : 1;
      var spec = (b.specificity || 2) - (a.specificity || 2);
      if (spec !== 0) return spec;                          // named beats generic
      return RISK_RANK[b.risk] - RISK_RANK[a.risk];         // then riskiest
    });

    var kept = [];
    var lastEnd = -1;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].start >= lastEnd) {
        kept.push(sorted[i]);
        lastEnd = sorted[i].end;
      }
    }
    return kept;
  }

  /* ---------------------------------------------------------------- *
   * Redaction — rebuilds the text with placeholders substituted in.
   *
   * Two substitution styles, chosen per pattern (patterns.js documents
   * each choice):
   *   - structured data (card numbers, emails, PANs, IPs, ...) becomes a
   *     realistic, industry-recognized dummy value, so the sentence still
   *     reads naturally and the AI tool isn't confused by bracket syntax
   *     embedded mid-message.
   *   - business-context phrases and confirmed-leak matches (honeytokens)
   *     keep an explicit [REMOVED] tag — there is no safe "fake" trade
   *     secret to swap in, and a confirmed leak should stay unambiguous
   *     rather than quietly blend into plausible-looking text.
   *
   * redactWithSpans additionally returns the [start, end) range of each
   * substitution WITHIN THE OUTPUT text, so the UI can highlight exactly
   * what changed without re-parsing the text for bracket syntax — which
   * would silently stop working the moment a substitution doesn't use
   * brackets (i.e. every structured-data case above).
   * ---------------------------------------------------------------- */
  function redactWithSpans(text, matches) {
    if (!matches || matches.length === 0) return { text: text, spans: [] };
    var ordered = resolveOverlaps(matches).sort(function (a, b) { return a.start - b.start; });
    var result = "";
    var cursor = 0;
    var spans = [];
    for (var i = 0; i < ordered.length; i++) {
      var m = ordered[i];
      if (m.start < cursor) continue;
      result += text.slice(cursor, m.start);
      var spanStart = result.length;
      result += m.redactAs;
      spans.push({ start: spanStart, end: result.length, type: m.type, confirmedLeak: !!m.confirmedLeak });
      cursor = m.end;
    }
    result += text.slice(cursor);
    return { text: result, spans: spans };
  }

  /** Back-compat string-only wrapper — used directly by a few call sites and tests. */
  function redact(text, matches) {
    return redactWithSpans(text, matches).text;
  }

  /* ---------------------------------------------------------------- *
   * Feature 16 — compliance tagging
   * ---------------------------------------------------------------- */
  function frameworksFor(types) {
    var set = {};
    types.forEach(function (t) {
      set[P.COMPLIANCE_MAP[t] || P.DEFAULT_FRAMEWORK] = true;
    });
    return Object.keys(set);
  }

  /* ---------------------------------------------------------------- *
   * scan() — the single public entry point
   * ---------------------------------------------------------------- */
  function scan(text) {
    var empty = {
      riskLevel: RISK.NONE,
      matches: [],
      overallTier: null,
      complianceFrameworks: [],
      patternTypes: [],
      confirmedLeak: false,
      redactedText: typeof text === "string" ? text : "",
      redactionSpans: [],
      truncated: false,
    };

    if (typeof text !== "string" || text.trim().length === 0) return empty;

    var truncated = false;
    var subject = text;
    if (subject.length > MAX_SCAN_LENGTH) {
      subject = subject.slice(0, MAX_SCAN_LENGTH);
      truncated = true;
    }

    var raw = [];
    scanRegexPatterns(subject, raw);
    scanKeywordPatterns(subject, raw);
    scanCustomKeywords(subject, raw);
    scanHoneytokens(subject, raw);

    if (raw.length === 0) {
      empty.truncated = truncated;
      return empty;
    }

    var matches = resolveOverlaps(raw);

    var riskLevel = RISK.NONE;
    var overallTier = TIER.WARN;
    var confirmedLeak = false;
    var typeSet = {};

    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      riskLevel = P.maxRisk(riskLevel, m.risk);
      if (m.tier === TIER.MANDATORY) overallTier = TIER.MANDATORY;
      if (m.confirmedLeak) confirmedLeak = true;
      typeSet[m.type] = true;
    }

    var patternTypes = Object.keys(typeSet);

    var redaction = redactWithSpans(text, matches);

    return {
      riskLevel: riskLevel,
      matches: matches,
      overallTier: overallTier,
      complianceFrameworks: frameworksFor(patternTypes),
      patternTypes: patternTypes,
      confirmedLeak: confirmedLeak,
      redactedText: redaction.text,
      redactionSpans: redaction.spans,
      truncated: truncated,
    };
  }

  return {
    scan: scan,
    redact: redact,
    redactWithSpans: redactWithSpans,
    tierFor: tierFor,
    setHoneytokens: setHoneytokens,
    setCustomKeywords: setCustomKeywords,
    setPolicyOverrides: setPolicyOverrides,
    getConfig: getConfig,
    reset: reset,
    RISK: RISK,
    TIER: TIER,
    MAX_SCAN_LENGTH: MAX_SCAN_LENGTH,
  };
});
