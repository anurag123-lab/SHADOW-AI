/**
 * Shadow AI Guard — critical event notifier
 * =========================================
 * Polls for events IT should hear about immediately and emails them.
 *
 * "Immediately" means two things only:
 *   - a confirmed leak (a honeytoken match — not a probabilistic flag)
 *   - a blocked or cancelled file upload
 *
 * Everything else waits for the weekly digest. An alerting system that
 * emails on every Warn gets muted within a week, and then it is worth
 * nothing on the day it matters.
 *
 * Run: node index.js          (loops)
 *      node index.js --once   (single pass, for testing)
 */
const { db, sendEmail, formatEvent, recipientsFor, verifySmtp, PRIVACY_FOOTER, DRY_RUN } = require("./lib");

const INTERVAL_MINUTES = Number(process.env.NOTIFIER_INTERVAL_MINUTES || 2);
const BATCH_LIMIT = 50;

/**
 * What deserves an email.
 *
 *   critical  confirmed leaks + blocked uploads          (default)
 *   high      the above, plus anything High risk
 *   all       every flagged event
 *
 * The default is deliberate. An alerting system that emails on every
 * flag gets muted within a week, and is then worth nothing on the day it
 * matters — the dashboard already shows everything. Raise it to "all"
 * only if you want to see the mechanism working on every detection,
 * which is a reasonable thing to want during a demo.
 */
const ALERT_ON = (process.env.ALERT_ON || "critical").toLowerCase();

const ALERT_FILTERS = {
  critical: "confirmed_leak.eq.true,action.in.(blocked,upload_cancelled)",
  high: "confirmed_leak.eq.true,action.in.(blocked,upload_cancelled),risk_level.eq.High",
  all: null,   // no filter — every unnotified event
};

async function checkForCriticalEvents() {
  const supabase = db();

  let query = supabase
    .from("flagged_events")
    .select("*")
    .eq("notified", false);

  const filter = Object.prototype.hasOwnProperty.call(ALERT_FILTERS, ALERT_ON)
    ? ALERT_FILTERS[ALERT_ON]
    : ALERT_FILTERS.critical;

  if (filter) query = query.or(filter);

  const { data: events, error } = await query
    .order("timestamp", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.error(`[notifier] query failed: ${error.message}`);
    return 0;
  }
  if (!events || events.length === 0) return 0;

  // Group by company so one incident burst is one email, not twenty.
  const byCompany = new Map();
  for (const event of events) {
    if (!byCompany.has(event.company_id)) byCompany.set(event.company_id, []);
    byCompany.get(event.company_id).push(event);
  }

  let sent = 0;

  for (const [companyId, companyEvents] of byCompany) {
    let recipients;
    try {
      recipients = await recipientsFor(companyId);
    } catch (e) {
      console.error(`[notifier] could not resolve recipients for ${companyId}: ${e.message}`);
      continue;
    }

    if (recipients.length === 0) {
      console.warn(`[notifier] company ${companyId} has ${companyEvents.length} alerts but no admin email — skipping`);
      continue;
    }

    // Three groups, so a heading never mislabels what it contains.
    // (Under ALERT_ON=all, most events are neither leaks nor blocks.)
    const leaks = companyEvents.filter((e) => e.confirmed_leak);
    const blocks = companyEvents.filter(
      (e) => !e.confirmed_leak && (e.action === "blocked" || e.action === "upload_cancelled")
    );
    const others = companyEvents.filter(
      (e) => !e.confirmed_leak && e.action !== "blocked" && e.action !== "upload_cancelled"
    );

    const subject =
      leaks.length > 0
        ? `[Shadow AI Guard] ${leaks.length} confirmed data leak${leaks.length === 1 ? "" : "s"} detected`
        : blocks.length > 0
        ? `[Shadow AI Guard] ${blocks.length} upload${blocks.length === 1 ? "" : "s"} blocked`
        : `[Shadow AI Guard] ${others.length} sensitive item${others.length === 1 ? "" : "s"} flagged`;

    const sections = [];

    function addSection(title, blurb, rows) {
      if (!rows.length) return;
      if (sections.length) sections.push("", "=".repeat(60), "");
      sections.push(`${title} (${rows.length})`, "", ...blurb, "", rows.map(formatEvent).join("\n\n"));
    }

    addSection("CONFIRMED LEAKS", [
      "A honeytoken is a fake identifier planted in a real internal document. It exists",
      "nowhere else, so a match is not a probabilistic guess — internal content reached",
      "an AI tool's input box.",
    ], leaks);

    addSection("BLOCKED UPLOADS", [
      "These files were stopped before upload. The employee was shown what was found",
      "and asked to remove it and re-attach.",
    ], blocks);

    addSection("OTHER FLAGGED ACTIVITY", [
      "Sensitive content was detected and handled in the browser. No message or file",
      "content left the employee's machine.",
    ], others);

    sections.push("", PRIVACY_FOOTER);
    const body = sections.join("\n");

    for (const to of recipients) {
      try {
        await sendEmail(to, subject, body);
        sent++;
      } catch (e) {
        console.error(`[notifier] send to ${to} failed: ${e.message}`);
      }
    }

    // Mark notified only after a successful send, so a broken SMTP
    // connection delays alerts rather than silently swallowing them.
    const ids = companyEvents.map((e) => e.id);
    const { error: updateError } = await supabase
      .from("flagged_events")
      .update({ notified: true })
      .in("id", ids);

    if (updateError) {
      console.error(`[notifier] could not mark events notified: ${updateError.message}`);
    } else {
      console.log(`[notifier] ${companyEvents.length} event(s) -> ${recipients.length} recipient(s)`);
    }
  }

  return sent;
}

async function main() {
  const once = process.argv.includes("--once");

  // --verify: check the SMTP credentials and exit. Run this once after
  // configuring Mailtrap, so a bad password fails here rather than
  // silently swallowing an alert during a demo.
  if (process.argv.includes("--verify")) {
    const result = await verifySmtp();
    console.log("\nSMTP check");
    console.log(`  mode:   ${result.mode}`);
    console.log(`  status: ${result.ok ? "OK" : "not sending"}`);
    console.log(`  detail: ${result.detail}\n`);
    process.exit(result.ok || result.mode === "dry-run" ? 0 : 1);
  }

  console.log("Shadow AI Guard notifier");
  console.log(`  mode:     ${DRY_RUN ? "DRY RUN (printing to console, not sending)" : "sending via SMTP"}`);
  const WATCHING = {
    critical: "confirmed leaks + blocked uploads",
    high: "confirmed leaks, blocked uploads, and all High-risk events",
    all: "every flagged event",
  };
  console.log(`  watching: ${WATCHING[ALERT_ON] || WATCHING.critical}  (ALERT_ON=${ALERT_ON})`);
  console.log(`  interval: every ${INTERVAL_MINUTES} minute(s)${once ? " (single pass)" : ""}\n`);

  const count = await checkForCriticalEvents();
  if (count === 0) console.log("[notifier] nothing to alert on right now");

  if (once) return;

  setInterval(() => {
    checkForCriticalEvents().catch((e) => console.error("[notifier]", e.message));
  }, INTERVAL_MINUTES * 60 * 1000);
}

main().catch((e) => {
  console.error("[notifier] fatal:", e.message);
  process.exit(1);
});
