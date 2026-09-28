/**
 * Fires a test alert through the real notifier path.
 *
 * Inserts one confirmed-leak event, so `node index.js --once` has
 * something to find. Use it to rehearse the alert before a demo without
 * having to trigger a real honeytoken match in the browser.
 *
 *   node test-alert.js          insert a test event
 *   node test-alert.js --clean  remove test events again
 *
 * Test rows are tagged with employee_hash emp_ffffffffffffffff so they
 * can always be found and removed. Nothing else touches that hash.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const TEST_HASH = "emp_ffffffffffffffff";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function clean() {
  const { error, count } = await sb
    .from("flagged_events")
    .delete({ count: "exact" })
    .eq("employee_hash", TEST_HASH);

  if (error) {
    console.error("  delete failed:", error.message);
    process.exit(1);
  }
  console.log(`  removed ${count === null ? "all" : count} test event(s)\n`);
}

async function seed() {
  const { data: companies, error } = await sb.from("companies").select("id, name");
  if (error) {
    console.error("  could not read companies:", error.message);
    process.exit(1);
  }
  if (!companies.length) {
    console.error("  no company yet — sign up on the dashboard first.\n");
    process.exit(1);
  }

  const company = companies[0];
  const { data: admins } = await sb
    .from("admin_profiles")
    .select("notification_email")
    .eq("company_id", company.id);

  console.log(`  company:    ${company.name}`);
  console.log(`  recipients: ${admins && admins.length ? admins.map((a) => a.notification_email).join(", ") : "NONE — no admin_profiles row"}`);

  const { error: insErr } = await sb.from("flagged_events").insert([
    {
      company_id: company.id,
      employee_hash: TEST_HASH,
      ai_tool: "chatgpt.com",
      source: "text",
      pattern_types: ["honeytoken", "cardNumber"],
      compliance_frameworks: ["Internal Security Policy", "PCI DSS"],
      department: "Finance",
      risk_level: "High",
      tier: "MandatoryRedaction",
      action: "redacted",
      confirmed_leak: true,
      notified: false,
    },
    {
      company_id: company.id,
      employee_hash: TEST_HASH,
      ai_tool: "claude.ai",
      source: "file",
      file_name: "Q3-forecast-CONFIDENTIAL.pdf",
      file_type: "pdf",
      pattern_types: ["cardNumber", "corporateStrategyTerm"],
      compliance_frameworks: ["PCI DSS", "Internal Policy"],
      department: "Finance",
      risk_level: "High",
      tier: "MandatoryRedaction",
      action: "blocked",
      confirmed_leak: false,
      notified: false,
    },
    {
      // A routine Warn-tier event. ALERT_ON=critical ignores this one;
      // ALERT_ON=all picks it up. Included so both paths get exercised.
      company_id: company.id,
      employee_hash: TEST_HASH,
      ai_tool: "gemini.google.com",
      source: "text",
      pattern_types: ["email", "phone"],
      compliance_frameworks: ["GDPR"],
      department: "Sales",
      risk_level: "Low",
      tier: "Warn",
      action: "redacted",
      confirmed_leak: false,
      notified: false,
    },
  ]);

  if (insErr) {
    console.error("  insert failed:", insErr.message);
    process.exit(1);
  }

  console.log("  inserted:   1 confirmed leak + 1 blocked upload + 1 routine Warn\n");
  console.log("  Now run:    node index.js --once\n");
}

console.log("\nShadow AI Guard — alert test\n");
(process.argv.includes("--clean") ? clean() : seed()).catch((e) => {
  console.error("  failed:", e.message, "\n");
  process.exit(1);
});
