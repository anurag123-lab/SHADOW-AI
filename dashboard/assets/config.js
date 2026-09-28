/**
 * Shadow AI Guard — Dashboard configuration
 *
 * The anon key belongs here. Row Level Security (003_row_level_security.sql)
 * is what stops one company reading another's data — not key secrecy.
 * The service_role key must NEVER appear in this directory.
 */
window.SAG_CONFIG = {
  /* ============ PASTE YOUR PROJECT VALUES HERE ============ */
  SUPABASE_URL: "https://rmqtazdvmbyzbnaokkmw.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtcXRhemR2bWJ5emJuYW9ra213Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNzk4MjgsImV4cCI6MjEwNTc1NTgyOH0.Ai5EemmVwa5UgyH-fGP4ce3xUEHKzl5cicYJpHZxY_s",
  /* ======================================================== */

  PATTERN_TYPES: [
    { type: "privateKey", label: "Private key block", group: "Credentials" },
    { type: "awsKey", label: "AWS access key", group: "Credentials" },
    { type: "apiKey", label: "API key / token", group: "Credentials" },
    { type: "genericSecret", label: "High-entropy secret (heuristic)", group: "Credentials" },
    { type: "cardNumber", label: "Payment card number", group: "Regulated data" },
    { type: "panCard", label: "Indian PAN", group: "Regulated data" },
    { type: "gstin", label: "Indian GSTIN", group: "Regulated data" },
    { type: "ifscCode", label: "Indian IFSC code", group: "Regulated data" },
    { type: "email", label: "Email address", group: "Personal data" },
    { type: "phone", label: "Phone number", group: "Personal data" },
    { type: "ipAddress", label: "Internal IP address", group: "Personal data" },
    { type: "healthTerm", label: "Health information", group: "Regulated data" },
    { type: "confidentialityMarker", label: "Confidentiality marker", group: "Business" },
    { type: "legalTerm", label: "Legal / contract language", group: "Business" },
    { type: "hrTerm", label: "HR / personnel", group: "Business" },
    { type: "corporateStrategyTerm", label: "Corporate strategy", group: "Business" },
    { type: "ipTerm", label: "Intellectual property", group: "Business" },
    { type: "customKeyword", label: "Company-defined keyword", group: "Business" },
  ],

  FP_REASON_LABELS: {
    not_actually_sensitive: "Not actually sensitive",
    test_or_sample_data: "Test or sample data",
    already_public_information: "Already public information",
  },

  ACTION_LABELS: {
    redacted: "Redacted",
    sent_anyway: "Sent anyway",
    marked_false_positive: "Marked false positive",
    dismissed_no_action: "Dismissed",
    blocked: "Blocked",
    warned: "Warned",
    uploaded_anyway: "Uploaded anyway",
    upload_cancelled: "Upload cancelled",
    redirected_to_sanctioned: "Moved to approved tool",
  },
};
