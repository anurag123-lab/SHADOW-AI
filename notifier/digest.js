/**
 * Shadow AI Guard — weekly digest (Feature 18)
 * ============================================
 * Turns a week of metadata into something an IT lead reads in 20 seconds.
 *
 * Deliberately template-based, with no LLM call. A reporting feature that
 * depends on an AI API adds a cost, a latency, a failure mode and a
 * privacy question ("wait, you send our data to whom?") to solve a
 * problem that string interpolation already solves. The aggregation
 * itself runs in SQL (get_weekly_digest), so this file stays a formatter.
 *
 * Run: node digest.js              (all companies)
 *      node digest.js --days 30    (custom window)
 */
const { db, sendEmail, recipientsFor, PRIVACY_FOOTER, DRY_RUN } = require("./lib");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DAYS = Number(arg("days", 7));

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function buildDigest(companyName, d) {
  const lines = [];

  lines.push(`Shadow AI Guard — ${companyName}`);
  lines.push(`Your last ${DAYS} days`);
  lines.push("=".repeat(60));
  lines.push("");

  if (!d.total) {
    lines.push("No events were flagged this period.");
    lines.push("");
    lines.push("That means one of two things: nobody pasted anything sensitive into an AI");
    lines.push("tool, or nobody has the extension installed yet. Worth checking which.");
    lines.push("");
    lines.push(PRIVACY_FOOTER);
    return lines.join("\n");
  }

  // ---- the headline ----
  lines.push(`${plural(d.total, "event was", "events were")} flagged before reaching an AI tool.`);
  if (d.topDepartment) {
    lines.push(`${d.topDepartment} accounted for the most (${d.topDepartmentCount}).`);
  }
  lines.push("");

  // ---- what happened ----
  lines.push("WHAT HAPPENED");
  lines.push(`  Mandatory redactions triggered   ${d.mandatoryRedactions}`);
  lines.push(`  Sent anyway after a warning      ${d.overrides}`);
  lines.push(`  Uploads blocked                  ${d.blockedUploads}`);
  lines.push(`  Marked as false alarms           ${d.falsePositives}`);
  lines.push(`  Distinct AI tools seen in use    ${d.newToolsCount}`);
  lines.push("");

  // ---- the part that isn't routine ----
  if (d.confirmedLeaks > 0) {
    lines.push("NEEDS ATTENTION");
    lines.push(`  ${plural(d.confirmedLeaks, "confirmed leak", "confirmed leaks")} — a honeytoken planted in an internal`);
    lines.push("  document was pasted into an AI tool. This is not a probabilistic flag.");
    lines.push("");
  }

  // ---- top categories ----
  if (Array.isArray(d.topPatterns) && d.topPatterns.length) {
    lines.push("MOST COMMON DETECTIONS");
    d.topPatterns.forEach((p) => {
      lines.push(`  ${String(p.pattern).padEnd(28)} ${p.n}`);
    });
    lines.push("");
  }

  // ---- one actionable suggestion, not a wall of advice ----
  const fpRate = d.total ? d.falsePositives / d.total : 0;
  const overrideRate = d.total ? d.overrides / d.total : 0;

  lines.push("SUGGESTED NEXT STEP");
  if (fpRate > 0.25) {
    lines.push("  More than a quarter of flags were marked false alarms. Open the dashboard's");
    lines.push("  false-positive panel and consider retiring the noisiest rule — an alert");
    lines.push("  people distrust is worse than no alert.");
  } else if (overrideRate > 0.4) {
    lines.push("  Most warnings were overridden. Either the rules are firing on things that");
    lines.push("  genuinely aren't sensitive, or people need a faster approved alternative.");
    lines.push("  Check whether an approved AI tool is configured.");
  } else if (d.confirmedLeaks > 0) {
    lines.push("  Review the confirmed leaks first. Honeytoken matches tell you exactly which");
    lines.push("  internal document is circulating outside its intended audience.");
  } else if (d.blockedUploads > 0) {
    lines.push("  Blocked uploads mean people are attaching internal documents to AI tools.");
    lines.push("  A short note about what is and isn't OK to upload usually moves this number.");
  } else {
    lines.push("  Nothing needs action. Warnings are being respected and no confirmed leaks");
    lines.push("  were recorded this period.");
  }
  lines.push("");
  lines.push(PRIVACY_FOOTER);

  return lines.join("\n");
}

async function sendWeeklyDigest() {
  const supabase = db();

  const { data: companies, error } = await supabase.from("companies").select("id, name");
  if (error) throw error;
  if (!companies || companies.length === 0) {
    console.log("[digest] no companies found");
    return;
  }

  console.log(`Shadow AI Guard digest — ${DAYS} day window`);
  console.log(`  mode: ${DRY_RUN ? "DRY RUN (printing to console)" : "sending via SMTP"}\n`);

  for (const company of companies) {
    const { data: summary, error: rpcError } = await supabase.rpc("get_weekly_digest", {
      p_company_id: company.id,
      p_days: DAYS,
    });

    if (rpcError) {
      console.error(`[digest] ${company.name}: ${rpcError.message}`);
      continue;
    }

    const recipients = await recipientsFor(company.id, { digestOnly: true });
    if (recipients.length === 0) {
      console.warn(`[digest] ${company.name}: no opted-in admin emails — skipping`);
      continue;
    }

    const body = buildDigest(company.name, summary);
    const subject = `[Shadow AI Guard] ${company.name} — ${summary.total} flagged event${summary.total === 1 ? "" : "s"} this week`;

    for (const to of recipients) {
      try {
        await sendEmail(to, subject, body);
        console.log(`[digest] ${company.name} -> ${to}`);
      } catch (e) {
        console.error(`[digest] send to ${to} failed: ${e.message}`);
      }
    }
  }
}

sendWeeklyDigest().catch((e) => {
  console.error("[digest] fatal:", e.message);
  process.exit(1);
});
