/**
 * Project status — what is actually set up, read from the live database.
 *
 * Lives in notifier/ because that is where the Supabase dependency and the
 * service_role key are. Answers the question "what is left to do?" with
 * facts rather than recollection.
 *
 * Run: node status.js   (or: npm run status)
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const row = (label, value, note) =>
  console.log("  " + String(label).padEnd(32) + String(value).padEnd(10) + (note || ""));

(async () => {
  const q = async (table, cols) => {
    const { data, error } = await sb.from(table).select(cols);
    if (error) throw new Error(`${table}: ${error.message}`);
    return data || [];
  };

  const companies = await q("companies", "id, name, join_code, sanctioned_ai_tool_url, sanctioned_ai_tool_name");
  const admins = await q("admin_profiles", "company_id, notification_email");
  const employees = await q("employee_profiles", "company_id, department");
  const events = await q("flagged_events", "id, source, action, confirmed_leak, employee_hash");
  const tools = await q("discovered_tools", "id");
  const honeytokens = await q("honeytokens", "id, token");
  const keywords = await q("custom_keywords", "id");
  const policies = await q("policies", "pattern_type");

  console.log("\n" + "=".repeat(62));
  console.log("  SHADOW AI GUARD — live status");
  console.log("=".repeat(62));

  console.log("\n  BACKEND / DATA");
  row("companies", companies.length);
  companies.forEach((c) =>
    row("  " + c.name, "code " + c.join_code,
        c.sanctioned_ai_tool_url ? "sanctioned tool: " + (c.sanctioned_ai_tool_name || "set")
                                 : "no sanctioned tool configured"));
  row("admin accounts", admins.length, admins.map((a) => a.notification_email).join(", "));
  const types = new Set(policies.map((p) => p.pattern_type));
  row("policy rows", policies.length);
  row("migration 004", types.has("genericSecret") ? "APPLIED" : "NOT RUN",
      types.has("genericSecret") ? "" : "<- run supabase/migrations/004_entropy_detection.sql");

  console.log("\n  EXTENSION (employee side)");
  row("employees enrolled", employees.length,
      employees.length ? employees.map((e) => e.department).join(", ")
                       : "<- nobody has joined from the extension yet");
  row("flagged events logged", events.length,
      events.length ? "" : "<- no detection has reached the backend yet");
  if (events.length) {
    const byAction = {};
    events.forEach((e) => (byAction[e.action] = (byAction[e.action] || 0) + 1));
    Object.entries(byAction).forEach(([a, n]) => row("  " + a, n));
    row("  from file uploads", events.filter((e) => e.source === "file").length);
    row("  confirmed leaks", events.filter((e) => e.confirmed_leak).length);
  }
  row("discovered-tool signals", tools.length,
      tools.length ? "" : "<- discovery script has not fired");

  console.log("\n  DETECTION CONFIG");
  row("honeytokens", honeytokens.length,
      honeytokens.length ? honeytokens.map((h) => h.token).join(", ")
                         : "<- add ACME-HT-9F3K2Q to demo confirmed leaks");
  row("custom keywords", keywords.length,
      keywords.length ? "" : "<- optional; add a project codename");

  console.log("\n" + "=".repeat(62) + "\n");
})().catch((e) => {
  console.error("\n  status query failed:", e.message, "\n");
  process.exit(1);
});
