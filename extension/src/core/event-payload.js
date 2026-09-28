/* eslint-disable */
/**
 * Shadow AI Guard — Event Payload Builder
 * =======================================
 * The ONLY place in the extension allowed to construct a network payload
 * from a scan result. Feature 20's second line of defence.
 *
 * The database schema already makes it impossible to STORE raw content.
 * This module makes it impossible to SEND it: it builds the payload from
 * an explicit allow-list of primitive fields, so a future change to the
 * scan result (a new field holding matched text, say) cannot leak by
 * being passed through automatically. Nothing is spread, copied or
 * serialised wholesale — every field is named here or it does not travel.
 *
 * `match.value` — the raw matched substring used for the redaction
 * preview — is deliberately never read by this file.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ShadowAIEventPayload = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  var ALLOWED_ACTIONS = [
    "redacted", "sent_anyway", "marked_false_positive", "dismissed_no_action",
    "blocked", "warned", "uploaded_anyway", "upload_cancelled", "redirected_to_sanctioned",
  ];

  var ALLOWED_FP_REASONS = [
    "not_actually_sensitive", "test_or_sample_data", "already_public_information",
  ];

  var ALLOWED_DEPARTMENTS = [
    "Engineering", "Sales", "Marketing", "Finance", "HR", "Legal", "Support", "Other", "Unspecified",
  ];

  var MAX_PATTERN_TYPES = 32;
  var MAX_FILE_NAME = 255;

  function oneOf(value, allowed, fallback) {
    return allowed.indexOf(value) !== -1 ? value : fallback;
  }

  function shortString(value, max) {
    if (typeof value !== "string") return null;
    var trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, max);
  }

  /**
   * Filenames can themselves carry sensitive content
   * ("Q3-layoff-list-priya-sharma.xlsx"). IT needs to recognise the file,
   * not read the whole name, so we keep the extension and a short stem.
   */
  function safeFileName(name) {
    var clean = shortString(name, MAX_FILE_NAME);
    if (!clean) return null;
    clean = clean.replace(/[\r\n\t]/g, " ");
    if (clean.length <= 64) return clean;
    var dot = clean.lastIndexOf(".");
    var ext = dot > -1 && clean.length - dot <= 10 ? clean.slice(dot) : "";
    return clean.slice(0, 60 - ext.length) + "~" + ext;
  }

  /**
   * @param {object} scanResult   output of ShadowAIDetector.scan()
   * @param {object} context      { companyId, employeeHash, aiTool, department,
   *                                source, fileName, fileType, action,
   *                                falsePositiveReason, timestamp }
   * @returns {object} a payload matching the flagged_events schema exactly
   */
  function buildEventPayload(scanResult, context) {
    var ctx = context || {};
    var scan = scanResult || {};

    var patternTypes = (scan.patternTypes || [])
      .filter(function (t) { return typeof t === "string" && t.length > 0 && t.length <= 40; })
      .slice(0, MAX_PATTERN_TYPES);

    var frameworks = (scan.complianceFrameworks || [])
      .filter(function (f) { return typeof f === "string" && f.length > 0 && f.length <= 60; })
      .slice(0, MAX_PATTERN_TYPES);

    var source = ctx.source === "file" ? "file" : "text";

    var payload = {
      company_id: ctx.companyId || null,
      employee_hash: ctx.employeeHash || null,
      timestamp: ctx.timestamp || new Date().toISOString(),
      ai_tool: shortString(ctx.aiTool, 253) || "unknown",
      source: source,
      file_name: source === "file" ? safeFileName(ctx.fileName) : null,
      file_type: source === "file" ? shortString(ctx.fileType, 40) : null,
      pattern_types: patternTypes,
      compliance_frameworks: frameworks,
      department: oneOf(ctx.department, ALLOWED_DEPARTMENTS, "Unspecified"),
      risk_level: oneOf(scan.riskLevel, ["Low", "Medium", "High"], "Low"),
      tier: oneOf(scan.overallTier, ["Warn", "MandatoryRedaction"], null),
      action: oneOf(ctx.action, ALLOWED_ACTIONS, "warned"),
      false_positive_reason: oneOf(ctx.falsePositiveReason, ALLOWED_FP_REASONS, null),
      confirmed_leak: scan.confirmedLeak === true,
    };

    return payload;
  }

  function buildDiscoveryPayload(context) {
    var ctx = context || {};
    return {
      company_id: ctx.companyId || null,
      employee_hash: ctx.employeeHash || null,
      timestamp: ctx.timestamp || new Date().toISOString(),
      ai_tool: shortString(ctx.aiTool, 253) || "unknown",
    };
  }

  /**
   * Test/CI guard: asserts a built payload carries only expected keys and
   * no long free-text value. Used by the test suite and callable from the
   * background worker in development builds.
   */
  var ALLOWED_KEYS = [
    "company_id", "employee_hash", "timestamp", "ai_tool", "source",
    "file_name", "file_type", "pattern_types", "compliance_frameworks",
    "department", "risk_level", "tier", "action", "false_positive_reason",
    "confirmed_leak",
  ];

  function assertNoContentLeak(payload) {
    var problems = [];
    Object.keys(payload).forEach(function (key) {
      if (ALLOWED_KEYS.indexOf(key) === -1) problems.push("unexpected field: " + key);
      var v = payload[key];
      if (typeof v === "string" && v.length > 255) problems.push("oversized string in: " + key);
      if (Array.isArray(v)) {
        v.forEach(function (item) {
          if (typeof item !== "string" || item.length > 60) problems.push("oversized array item in: " + key);
        });
      }
    });
    return problems;
  }

  return {
    buildEventPayload: buildEventPayload,
    buildDiscoveryPayload: buildDiscoveryPayload,
    assertNoContentLeak: assertNoContentLeak,
    ALLOWED_KEYS: ALLOWED_KEYS,
    ALLOWED_ACTIONS: ALLOWED_ACTIONS,
    ALLOWED_FP_REASONS: ALLOWED_FP_REASONS,
    ALLOWED_DEPARTMENTS: ALLOWED_DEPARTMENTS,
  };
});
