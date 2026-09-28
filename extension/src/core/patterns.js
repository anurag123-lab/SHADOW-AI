/* eslint-disable */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  else { root.ShadowAIPatterns = api; }
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
"use strict";

/**
 * Shadow AI Guard — Pattern Definitions
 * =====================================
 * Pure data. No DOM, no chrome.*, no network. Importable in Node for tests.
 *
 * Every pattern declares:
 *   type        - stable identifier, also the policy key (Feature 8)
 *   label       - human-readable reason shown in the popup (Feature 19).
 *                 The UI renders THIS, never the bare `type`.
 *   risk        - "Low" | "Medium" | "High"
 *   defaultTier - "Warn" | "MandatoryRedaction" (overridable by policy)
 *   redactAs    - placeholder substituted into the redaction preview
 *
 * Regex patterns carry `regex`; keyword patterns carry `keywords`.
 */

const RISK = Object.freeze({ NONE: "None", LOW: "Low", MEDIUM: "Medium", HIGH: "High" });
const TIER = Object.freeze({ WARN: "Warn", MANDATORY: "MandatoryRedaction" });

const RISK_ORDER = { None: 0, Low: 1, Medium: 2, High: 3 };
function maxRisk(a, b) {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/* ------------------------------------------------------------------ *
 * Tier A — regex patterns (structural, high precision)
 * ------------------------------------------------------------------ */
const REGEX_PATTERNS = [
  {
    type: "privateKey",
    label: "Private cryptographic key block",
    risk: RISK.HIGH,
    defaultTier: TIER.MANDATORY,
    redactAs: "[PRIVATE KEY REMOVED]",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)?/g,
  },
  {
    type: "awsKey",
    label: "AWS access key ID",
    risk: RISK.HIGH,
    defaultTier: TIER.MANDATORY,
    redactAs: "AKIAIOSFODNN7EXAMPLE",  // AWS's own official example access key ID (used throughout AWS docs) — publicly known, never a live credential
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  },
  {
    type: "apiKey",
    label: "Live API key or access token",
    risk: RISK.HIGH,
    defaultTier: TIER.MANDATORY,
    redactAs: "sk-EXAMPLE0000000000000000000000000000",  // format-plausible, unmistakably a placeholder
    // Vendor-prefixed tokens only. Deliberately NOT a generic
    // "long random string" rule — that is the single biggest source of
    // false positives (it matches base64, hashes, UUIDs, minified JS).
    // Also: GitHub fine-grained tokens (github_pat_) and Stripe live secret /
    // restricted keys (sk_live_, rk_live_). Publishable pk_ keys are public by design.
    regex: /\b(?:sk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|(?:sk|rk)_live_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|shpat_[a-fA-F0-9]{32}|AC[a-f0-9]{32})\b/g,
  },
  {
    type: "cardNumber",
    label: "Payment card number",
    risk: RISK.HIGH,
    defaultTier: TIER.MANDATORY,
    redactAs: "4242 4242 4242 4242",  // Stripe's widely-recognized public test card number — Luhn-valid, never a real cardholder's
    // Candidate shape only; validated by Luhn in the detector to keep the
    // false-positive rate down (order numbers, IDs, timestamps).
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: luhnValid,
  },
  {
    type: "panCard",
    label: "Indian PAN (permanent account number)",
    risk: RISK.HIGH,
    defaultTier: TIER.MANDATORY,
    redactAs: "ABCDE1234F",  // the standard example PAN cited across Indian tax documentation
    // Upper case as printed; lower case as people often type it — the
    // lower-case form requires a valid 4th (holder-type) letter to stay precise.
    regex: /\b(?:[A-Z]{5}[0-9]{4}[A-Z]|[a-z]{3}[pchfatbljg][a-z][0-9]{4}[a-z])\b/g,
  },
  {
    type: "gstin",
    label: "Indian GSTIN",
    risk: RISK.MEDIUM,
    defaultTier: TIER.WARN,
    redactAs: "22AAAAA0000A1Z5",  // the sample GSTIN published on the official GST portal's own docs
    regex: /\b[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g,
  },
  {
    type: "ifscCode",
    label: "Indian IFSC bank code",
    risk: RISK.MEDIUM,
    defaultTier: TIER.WARN,
    redactAs: "HDFC0001234",  // common documentation-example IFSC code
    // Lower-case form (as typed) requires a numeric branch code to stay precise.
    regex: /\b(?:[A-Z]{4}0[A-Z0-9]{6}|[a-z]{4}0[0-9]{6})\b/g,
  },
  {
    type: "email",
    label: "Email address",
    risk: RISK.LOW,
    defaultTier: TIER.WARN,
    redactAs: "jane.doe@example.com",  // RFC 2606 reserved domain — guaranteed never a real deliverable mailbox
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
  },
  {
    type: "phone",
    label: "Phone number",
    risk: RISK.LOW,
    defaultTier: TIER.WARN,
    redactAs: "98765 43210",  // the standard placeholder Indian mobile number used across tutorials — same role as the US's reserved 555 block
    // India mobile (10 digits starting 6-9), optional +91 / 0 prefix, written
    // either unbroken (9876543210) or split 5-5 as most people type it
    // (98765 43210, 98765-43210).
    // Look-arounds (not ) so +919876543210 and 09876543210 also match, while a
    // 10-digit run inside a longer number (order IDs, cards) still does not.
    regex: /(?<![\w+])(?:\+?91[-\s]?|0)?[6-9]\d{4}[-\s]?\d{5}(?!\w)/g,
  },
  {
    type: "ipAddress",
    label: "Private/internal IP address",
    risk: RISK.LOW,
    defaultTier: TIER.WARN,
    redactAs: "192.0.2.1",  // RFC 5737 TEST-NET-1 — the address block officially reserved for documentation/example use
    // RFC 1918 ranges only — public IPs are not company-sensitive.
    regex: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  },
];

/* ------------------------------------------------------------------ *
 * Tier B — keyword patterns (business-context signals)
 * ------------------------------------------------------------------ */
const KEYWORD_PATTERNS = [
  {
    type: "confidentialityMarker",
    label: "Document marked confidential",
    risk: RISK.MEDIUM,
    defaultTier: TIER.WARN,
    redactAs: "[CONFIDENTIALITY MARKER REMOVED]",
    keywords: [
      "confidential", "strictly confidential", "internal only", "internal use only",
      "do not distribute", "not for distribution", "proprietary and confidential",
      "restricted circulation", "privileged and confidential",
    ],
  },
  {
    type: "legalTerm",
    label: "Legal/contract language",
    risk: RISK.MEDIUM,
    defaultTier: TIER.WARN,
    redactAs: "[LEGAL TERM REMOVED]",
    keywords: [
      "nda", "non-disclosure agreement", "indemnify", "indemnification",
      "arbitration clause", "governing law", "breach of contract",
      "master service agreement", "letter of intent", "settlement agreement",
      "litigation hold", "cease and desist",
    ],
  },
  {
    type: "hrTerm",
    label: "HR / personnel information",
    risk: RISK.MEDIUM,
    defaultTier: TIER.WARN,
    redactAs: "[HR TERM REMOVED]",
    keywords: [
      "ctc", "offer letter", "pip", "performance improvement plan",
      "termination letter", "severance", "appraisal rating", "salary band",
      "notice period buyout", "disciplinary action", "exit interview",
    ],
  },
  {
    type: "corporateStrategyTerm",
    label: "Corporate strategy / finance information",
    risk: RISK.HIGH,
    defaultTier: TIER.WARN,
    redactAs: "[STRATEGY TERM REMOVED]",
    keywords: [
      "cap table", "term sheet", "board minutes", "board deck",
      "due diligence", "acquisition target", "merger agreement",
      "revenue forecast", "burn rate", "runway projection",
      "pre-money valuation", "down round", "earnings call script",
    ],
  },
  {
    type: "ipTerm",
    label: "Intellectual property reference",
    risk: RISK.HIGH,
    defaultTier: TIER.WARN,
    redactAs: "[IP TERM REMOVED]",
    keywords: [
      "trade secret", "patent pending", "provisional patent",
      "proprietary algorithm", "source code repository", "unpublished research",
      "invention disclosure",
    ],
  },
  {
    type: "healthTerm",
    label: "Health information",
    risk: RISK.HIGH,
    defaultTier: TIER.WARN,
    redactAs: "[HEALTH TERM REMOVED]",
    keywords: [
      "medical record", "patient id", "diagnosis code", "icd-10",
      "prescription history", "health insurance claim", "mental health record",
      "blood test result", "medical history",
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Feature 16 — Compliance framework mapping
 * A triage signal, NOT a legal compliance determination.
 * ------------------------------------------------------------------ */
const COMPLIANCE_MAP = Object.freeze({
  cardNumber: "PCI DSS",
  email: "GDPR",
  phone: "GDPR",
  panCard: "India DPDP Act",
  gstin: "India DPDP Act",
  ifscCode: "PCI DSS",
  healthTerm: "HIPAA",
  apiKey: "Internal Security Policy",
  awsKey: "Internal Security Policy",
  privateKey: "Internal Security Policy",
  genericSecret: "Internal Security Policy",
  ipAddress: "Internal Security Policy",
  honeytoken: "Internal Security Policy",
});
const DEFAULT_FRAMEWORK = "Internal Policy";

const COMPLIANCE_DISCLAIMER =
  "Framework tags are a triage signal to help you prioritise, not a legal compliance determination.";

/* ------------------------------------------------------------------ *
 * Luhn check — used to validate card-number candidates
 * ------------------------------------------------------------------ */
function luhnValid(candidate) {
  const digits = String(candidate).replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/* ------------------------------------------------------------------ *
 * Shannon entropy — the backstop for secrets no prefix rule can catch
 * ------------------------------------------------------------------ *
 * Prefix matching (sk-, AKIA, ghp_) only finds credentials from vendors
 * we thought to list. It cannot find an internal service's 40-character
 * random token, a rotated key with a new prefix, or a generated password.
 * Those are exactly the strings entropy is good at: random data has a
 * near-uniform character distribution, English and identifiers do not.
 *
 * Entropy alone is famously noisy, so it is used as a FILTER on top of a
 * candidate regex, never on its own, with the exclusions below.
 * ------------------------------------------------------------------ */

/** Bits of information per character. Random base64 ~5.5-6.0; prose ~3.0-4.0. */
function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = Object.create(null);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    freq[ch] = (freq[ch] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const ch in freq) {
    const p = freq[ch] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ONLY_RE = /^[0-9a-f]+$/i;

/**
 * Digest lengths we deliberately refuse to flag.
 *
 * A 40-char hex string is almost always a git SHA-1; 64 is a SHA-256
 * checksum. Engineers paste both constantly, and flagging them would
 * train people to dismiss the warning — which costs more than the rare
 * secret that happens to be exactly that length. This is a deliberate
 * precision-over-recall trade, and it is the honest answer if asked.
 */
const DIGEST_LENGTHS = [40, 64];

const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_MAX_LENGTH = 200;
const ENTROPY_THRESHOLD_MIXED = 3.8;   // base64/base62-ish secrets
const ENTROPY_THRESHOLD_HEX = 3.2;     // hex has a max of 4.0 by definition

/**
 * Kebab/snake identifiers — slugs, branch names, file stems.
 *
 * "how-to-configure-your-deployment-pipeline-2024" clears 3.8 bits
 * comfortably, because entropy measures character variety and English
 * words have plenty. What separates it from a secret is STRUCTURE: it
 * splits on separators into dictionary-shaped, letters-only segments.
 * A random base64url token might contain a few - or _, but its segments
 * are not words.
 */
function looksLikeSlug(s) {
  const segments = s.split(/[-_]/);
  if (segments.length < 4) return false;
  const wordish = segments.filter((seg) => /^[A-Za-z]{2,}$/.test(seg)).length;
  return wordish >= segments.length - 1;
}

function isHighEntropySecret(candidate) {
  const s = String(candidate);

  if (s.length < ENTROPY_MIN_LENGTH || s.length > ENTROPY_MAX_LENGTH) return false;

  // Needs both letters and digits. Rules out long words, sentences run
  // together, repeated punctuation, and pure numeric IDs.
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return false;

  // Identifiers, not credentials.
  if (UUID_RE.test(s)) return false;

  // A long run of one character is padding or a placeholder, not entropy.
  if (/(.)\1{7,}/.test(s)) return false;

  if (HEX_ONLY_RE.test(s)) {
    if (DIGEST_LENGTHS.indexOf(s.length) !== -1) return false;
    if (s.length < 32) return false;
    return shannonEntropy(s) >= ENTROPY_THRESHOLD_HEX;
  }

  if (looksLikeSlug(s)) return false;

  // Mixed case. Generated credentials draw from the full base62 alphabet;
  // slugs, branch names and lowercase identifiers do not. This costs us
  // all-lowercase tokens — a deliberate precision-over-recall trade, the
  // same one made for digest lengths above.
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) return false;

  return shannonEntropy(s) >= ENTROPY_THRESHOLD_MIXED;
}

/**
 * Candidate shape for the entropy check.
 *
 * `/` is excluded from the character class on purpose: including it makes
 * long URL paths match, and a URL is the single most common long token in
 * ordinary conversation.
 */
const ENTROPY_PATTERN = {
  type: "genericSecret",
  label: "High-entropy string that looks like a credential",
  risk: RISK.HIGH,
  // Warn, not MandatoryRedaction: this is a heuristic, and a heuristic
  // that cannot be overridden is a heuristic that gets the tool disabled.
  // IT can promote it to mandatory from the policy engine (Feature 8).
  defaultTier: TIER.WARN,
  redactAs: "[SECRET REDACTED]",
  // Built from the constants rather than written out, so the candidate
  // shape and the validator can never disagree about the length floor.
  regex: new RegExp(
    "[A-Za-z0-9+_=-]{" + ENTROPY_MIN_LENGTH + "," + ENTROPY_MAX_LENGTH + "}",
    "g"
  ),
  validate: isHighEntropySecret,
  // Lower specificity than the named patterns, so `sk-...` reports as an
  // API key rather than as an anonymous high-entropy blob.
  specificity: 1,
};

const ALL_PATTERN_TYPES = Object.freeze([
  ...REGEX_PATTERNS.map((p) => p.type),
  ...KEYWORD_PATTERNS.map((p) => p.type),
  ENTROPY_PATTERN.type,
  "customKeyword",
  "honeytoken",
]);

return {
  RISK: RISK,
  TIER: TIER,
  maxRisk: maxRisk,
  REGEX_PATTERNS: REGEX_PATTERNS,
  KEYWORD_PATTERNS: KEYWORD_PATTERNS,
  ENTROPY_PATTERN: ENTROPY_PATTERN,
  COMPLIANCE_MAP: COMPLIANCE_MAP,
  DEFAULT_FRAMEWORK: DEFAULT_FRAMEWORK,
  COMPLIANCE_DISCLAIMER: COMPLIANCE_DISCLAIMER,
  luhnValid: luhnValid,
  shannonEntropy: shannonEntropy,
  isHighEntropySecret: isHighEntropySecret,
  ALL_PATTERN_TYPES: ALL_PATTERN_TYPES,
};
});
