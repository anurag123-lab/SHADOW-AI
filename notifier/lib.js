/**
 * Shared plumbing for the notifier scripts.
 *
 * This is the one component that runs with the service_role key, so it is
 * the one component that can read across all tenants. Two consequences
 * shape the code below:
 *
 *   1. It never runs in a browser and never ships to a client.
 *   2. Every query is explicitly scoped by company_id in code, because
 *      RLS — the safety net everywhere else — is bypassed here.
 */
require("dotenv").config();

const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

function assertEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`\nMissing required environment variables: ${missing.join(", ")}`);
    console.error("Copy notifier/.env.example to notifier/.env and fill it in.\n");
    process.exit(1);
  }
}

const DRY_RUN = process.env.DRY_RUN === "1" || !process.env.SMTP_USER;

/**
 * Whether filenames may appear in outbound email.
 *
 * A filename is the one semi-sensitive string in an alert:
 * "layoff-list-final.xlsx" tells you something even though no file
 * content is involved. The dashboard keeps it — that lives inside the
 * tenant, behind row-level security, and IT genuinely needs to know
 * which document leaked. Email is different: it crosses to a mail
 * provider, gets forwarded, and sits in inboxes indefinitely.
 *
 * So the default here is to OMIT. Set EMAIL_INCLUDE_FILENAMES=1 to
 * include them, as a deliberate choice rather than an accident.
 */
const INCLUDE_FILENAMES = process.env.EMAIL_INCLUDE_FILENAMES === "1";


let supabase = null;
function db() {
  if (!supabase) {
    assertEnv();
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabase;
}

let transporter = null;
function mailer() {
  if (DRY_RUN) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 2525),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transporter;
}

/**
 * Proves the SMTP credentials work before you depend on them.
 *
 * Worth running once after configuring Mailtrap: a wrong password fails
 * at send time, which during a demo means an alert that simply never
 * arrives with no visible error.
 */
async function verifySmtp() {
  if (DRY_RUN) {
    return {
      ok: false,
      mode: "dry-run",
      detail: "SMTP_USER is empty, so the notifier prints to the console instead of sending.",
    };
  }
  try {
    await mailer().verify();
    return {
      ok: true,
      mode: "smtp",
      detail: `${process.env.SMTP_HOST}:${process.env.SMTP_PORT} accepted the credentials`,
    };
  } catch (e) {
    return { ok: false, mode: "smtp", detail: e.message };
  }
}

async function sendEmail(to, subject, body) {
  if (DRY_RUN) {
    console.log("\n" + "-".repeat(70));
    console.log(`DRY RUN — would email: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log("-".repeat(70));
    console.log(body);
    console.log("-".repeat(70) + "\n");
    return { dryRun: true };
  }

  return mailer().sendMail({
    from: process.env.ALERT_FROM || '"Shadow AI Guard" <alerts@shadowaiguard.demo>',
    to,
    subject,
    text: body,
  });
}

/**
 * The privacy footer goes on every email this system sends.
 *
 * It is not decoration. These emails land in an IT inbox, get forwarded,
 * and end up quoted in a meeting — so the one place people are most
 * likely to assume "the tool must have captured what they typed" is
 * exactly where that assumption needs correcting.
 */
const PRIVACY_FOOTER = `
--
This alert contains only event metadata: a detection category, a hostname, a
department, and an anonymous ID. Shadow AI Guard does not capture the message
or file that triggered it, and cannot tell you which employee this was.
${INCLUDE_FILENAMES
  ? "Filenames are included in these emails by configuration."
  : "Filenames are withheld from email; see the dashboard for the full record."}
Open the dashboard for department trends and the full event history.
`.trim();

/** "Q3-forecast-CONFIDENTIAL.pdf" -> "a .pdf file" */
function describeFile(event) {
  if (!event.file_name) return event.source;
  if (INCLUDE_FILENAMES) return `${event.source} (${event.file_name})`;

  const ext = event.file_type
    ? `.${event.file_type}`
    : (event.file_name.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0];

  return `file${ext ? ` (a ${ext} file — name withheld from email)` : " (name withheld from email)"}`;
}

function formatEvent(event) {
  const patterns = (event.pattern_types || []).join(", ") || "none recorded";
  const frameworks = (event.compliance_frameworks || []).join(", ") || "Internal Policy";
  const when = new Date(event.timestamp).toLocaleString();

  return [
    `  When:        ${when}`,
    `  Tool:        ${event.ai_tool}`,
    `  Department:  ${event.department}`,
    `  Detected:    ${patterns}`,
    `  Frameworks:  ${frameworks}`,
    `  Risk:        ${event.risk_level}${event.confirmed_leak ? "  [CONFIRMED LEAK — honeytoken match]" : ""}`,
    `  Source:      ${describeFile(event)}`,
    `  Anonymous ID: ${event.employee_hash}`,
  ].join("\n");
}

/** Admin recipients for one company, respecting the digest opt-out. */
async function recipientsFor(companyId, { digestOnly = false } = {}) {
  let query = db()
    .from("admin_profiles")
    .select("notification_email, digest_opt_in")
    .eq("company_id", companyId);

  const { data, error } = await query;
  if (error) throw error;

  return (data || [])
    .filter((row) => (digestOnly ? row.digest_opt_in : true))
    .map((row) => row.notification_email)
    .filter(Boolean);
}

module.exports = {
  db,
  verifySmtp,
  sendEmail,
  formatEvent,
  recipientsFor,
  assertEnv,
  PRIVACY_FOOTER,
  DRY_RUN,
};
