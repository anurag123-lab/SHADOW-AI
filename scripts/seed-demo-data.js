/**
 * Shadow AI Guard — demo data seeder (Phase 11, Step 31)
 * ======================================================
 * Fills a company with realistic-looking history so the dashboard has
 * something to show without performing 100 live actions on stage.
 *
 * Uses the service_role key because it writes events attributed to
 * employee hashes that don't correspond to a signed-in user. That is
 * exactly the kind of write RLS is designed to refuse — which is the
 * correct behaviour, and why this is a server-side script and not a
 * button in the dashboard.
 *
 * Run: node scripts/seed-demo-data.js --company <uuid> [--events 120]
 *      node scripts/seed-demo-data.js --list
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", "notifier", ".env") });
const { createClient } = require("@supabase/supabase-js");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error("\nSet SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in notifier/.env first.\n");
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

/* ------------------------------------------------------------------ *
 * Shape of the demo data
 * ------------------------------------------------------------------ */
const DEPARTMENTS = [
  { name: "Engineering", weight: 30 },
  { name: "Sales", weight: 22 },
  { name: "Finance", weight: 14 },
  { name: "Marketing", weight: 12 },
  { name: "HR", weight: 10 },
  { name: "Legal", weight: 6 },
  { name: "Support", weight: 6 },
];

const TOOLS = [
  { name: "chatgpt.com", weight: 48 },
  { name: "claude.ai", weight: 26 },
  { name: "gemini.google.com", weight: 18 },
  { name: "copilot.microsoft.com", weight: 8 },
];

// Patterns weighted by department, so the heatmap tells a story rather
// than looking like uniform noise. Finance leaks card numbers; Engineering
// leaks API keys; HR leaks HR terms. That is what real data looks like.
const PATTERNS_BY_DEPT = {
  Engineering: [["apiKey", 22], ["awsKey", 12], ["privateKey", 6], ["ipAddress", 18], ["email", 14], ["ipTerm", 10], ["customKeyword", 8]],
  Sales: [["email", 30], ["phone", 24], ["customKeyword", 16], ["legalTerm", 12], ["corporateStrategyTerm", 8]],
  Finance: [["cardNumber", 26], ["gstin", 14], ["ifscCode", 12], ["panCard", 14], ["corporateStrategyTerm", 18], ["email", 10]],
  Marketing: [["email", 34], ["customKeyword", 22], ["confidentialityMarker", 16], ["phone", 12]],
  HR: [["hrTerm", 38], ["email", 20], ["panCard", 12], ["healthTerm", 14], ["phone", 10]],
  Legal: [["legalTerm", 40], ["confidentialityMarker", 24], ["ipTerm", 14], ["email", 10]],
  Support: [["email", 32], ["phone", 26], ["cardNumber", 10], ["customKeyword", 10]],
};

const COMPLIANCE_MAP = {
  cardNumber: "PCI DSS", email: "GDPR", phone: "GDPR",
  panCard: "India DPDP Act", gstin: "India DPDP Act", ifscCode: "PCI DSS",
  healthTerm: "HIPAA", apiKey: "Internal Security Policy",
  awsKey: "Internal Security Policy", privateKey: "Internal Security Policy",
  ipAddress: "Internal Security Policy", honeytoken: "Internal Security Policy",
};

const MANDATORY = ["apiKey", "awsKey", "privateKey", "cardNumber", "panCard"];
const HIGH_RISK = ["apiKey", "awsKey", "privateKey", "cardNumber", "panCard", "healthTerm", "ipTerm", "corporateStrategyTerm", "honeytoken"];
const MEDIUM_RISK = ["gstin", "ifscCode", "confidentialityMarker", "legalTerm", "hrTerm", "customKeyword"];

const FILE_TYPES = [
  ["pdf", "Q3-forecast.pdf"], ["pdf", "vendor-contract.pdf"], ["docx", "offer-letter-draft.docx"],
  ["docx", "board-summary.docx"], ["csv", "customer-export.csv"], ["txt", "server-notes.txt"],
];

const DISCOVERY_TOOLS = [
  ["perplexity.ai", 30], ["poe.com", 14], ["you.com", 10], ["chat.deepseek.com", 12],
  ["character.ai", 6], ["grok.com", 9], ["huggingface.co", 7], ["pi.ai", 5],
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function weightedPick(items) {
  const total = items.reduce((sum, i) => sum + (i.weight || i[1]), 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight || item[1];
    if (roll <= 0) return item.name || item[0];
  }
  return items[0].name || items[0][0];
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function makeHash() {
  let hex = "";
  for (let i = 0; i < 16; i++) hex += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return `emp_${hex}`;
}

/** Recent days are denser — a demo shouldn't look abandoned. */
function randomTimestamp(days) {
  const skewed = Math.pow(Math.random(), 1.6) * days;
  const ms = Date.now() - skewed * 86400000;
  const d = new Date(ms);
  // Land inside working hours so the time chart looks human.
  d.setHours(9 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60));
  return d.toISOString();
}

function riskFor(types) {
  if (types.some((t) => HIGH_RISK.includes(t))) return "High";
  if (types.some((t) => MEDIUM_RISK.includes(t))) return "Medium";
  return "Low";
}

function buildEvent(companyId, employees, days, honeytokenChance) {
  const employee = pick(employees);
  const department = employee.department;
  const patternPool = PATTERNS_BY_DEPT[department] || PATTERNS_BY_DEPT.Engineering;

  const types = [weightedPick(patternPool)];
  if (Math.random() < 0.28) {
    const second = weightedPick(patternPool);
    if (!types.includes(second)) types.push(second);
  }

  const confirmedLeak = Math.random() < honeytokenChance;
  if (confirmedLeak) types.push("honeytoken");

  const tier = confirmedLeak || types.some((t) => MANDATORY.includes(t)) ? "MandatoryRedaction" : "Warn";
  const isFile = Math.random() < 0.22;
  const risk = riskFor(types);

  let action;
  if (isFile) {
    action = tier === "MandatoryRedaction"
      ? pick(["blocked", "upload_cancelled", "upload_cancelled"])
      : pick(["uploaded_anyway", "upload_cancelled", "warned"]);
  } else if (tier === "MandatoryRedaction") {
    action = Math.random() < 0.88 ? "redacted" : "dismissed_no_action";
  } else {
    // A realistic spread: most people take the redaction, some override,
    // a few push back. A demo where everyone complies isn't believable.
    const roll = Math.random();
    action = roll < 0.55 ? "redacted"
      : roll < 0.75 ? "sent_anyway"
      : roll < 0.88 ? "marked_false_positive"
      : roll < 0.95 ? "dismissed_no_action"
      : "redirected_to_sanctioned";
  }

  const frameworks = [...new Set(types.map((t) => COMPLIANCE_MAP[t] || "Internal Policy"))];
  const file = isFile ? pick(FILE_TYPES) : null;

  return {
    company_id: companyId,
    employee_hash: employee.hash,
    timestamp: randomTimestamp(days),
    ai_tool: weightedPick(TOOLS),
    source: isFile ? "file" : "text",
    file_name: file ? file[1] : null,
    file_type: file ? file[0] : null,
    pattern_types: types,
    compliance_frameworks: frameworks,
    department,
    risk_level: risk,
    tier,
    action,
    false_positive_reason:
      action === "marked_false_positive"
        ? pick(["not_actually_sensitive", "test_or_sample_data", "already_public_information"])
        : null,
    confirmed_leak: confirmedLeak,
    notified: true,   // seeded history shouldn't trigger a burst of alert emails
  };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function listCompanies() {
  const { data, error } = await sb.from("companies").select("id, name, join_code").order("created_at");
  if (error) throw error;
  if (!data.length) {
    console.log("\nNo companies yet. Sign up on the dashboard first (setup step 6).\n");
    return;
  }
  console.log("\nCompanies:\n");
  data.forEach((c) => console.log(`  ${c.id}  ${c.name}  (join code ${c.join_code})`));
  console.log("\nSeed one with:  node scripts/seed-demo-data.js --company <id>\n");
}

async function seed() {
  let companyId = arg("company", null);

  if (!companyId) {
    const { data } = await sb.from("companies").select("id, name").order("created_at").limit(1);
    if (!data || !data.length) {
      console.error("\nNo company found. Sign up on the dashboard first (setup step 6).\n");
      process.exit(1);
    }
    companyId = data[0].id;
    console.log(`No --company given; using "${data[0].name}".`);
  }

  const eventCount = Number(arg("events", 120));
  const days = Number(arg("days", 30));
  const employeeCount = Number(arg("employees", 14));

  // Anonymous IDs only. This script never invents a name or an email,
  // because there is nowhere in the schema to put one.
  const employees = [];
  for (let i = 0; i < employeeCount; i++) {
    employees.push({ hash: makeHash(), department: weightedPick(DEPARTMENTS) });
  }

  // One employee is a deliberate repeat-overrider so Feature 14's panel
  // has something in it during the demo.
  const overrider = employees[0];

  const events = [];
  for (let i = 0; i < eventCount; i++) {
    events.push(buildEvent(companyId, employees, days, 0.045));
  }
  for (let i = 0; i < 5; i++) {
    const e = buildEvent(companyId, [overrider], 20, 0);
    e.action = "sent_anyway";
    e.risk_level = "High";
    e.tier = "Warn";
    e.source = "text";
    e.file_name = null;
    e.file_type = null;
    events.push(e);
  }

  console.log(`\nSeeding ${events.length} events across ${employees.length} anonymous IDs (${days} day window)...`);

  for (let i = 0; i < events.length; i += 100) {
    const batch = events.slice(i, i + 100);
    const { error } = await sb.from("flagged_events").insert(batch);
    if (error) {
      console.error("  insert failed:", error.message);
      process.exit(1);
    }
    console.log(`  inserted ${Math.min(i + 100, events.length)}/${events.length}`);
  }

  // Discovery signals (Feature 15)
  const discoveries = [];
  for (let i = 0; i < Math.round(eventCount * 0.5); i++) {
    discoveries.push({
      company_id: companyId,
      employee_hash: pick(employees).hash,
      timestamp: randomTimestamp(days),
      ai_tool: weightedPick(DISCOVERY_TOOLS),
    });
  }
  const { error: dErr } = await sb.from("discovered_tools").insert(discoveries);
  if (dErr) console.error("  discovery insert failed:", dErr.message);
  else console.log(`  inserted ${discoveries.length} tool-discovery signals`);

  // A couple of honeytokens and keywords so the config panels aren't bare.
  await sb.from("honeytokens").upsert(
    [
      { company_id: companyId, token: "ACME-HT-9F3K2Q", description: "planted in Q3 forecast deck" },
      { company_id: companyId, token: "INT-REF-77213B", description: "planted in the vendor contract template" },
    ],
    { onConflict: "company_id,token", ignoreDuplicates: true }
  );
  await sb.from("custom_keywords").upsert(
    [
      { company_id: companyId, keyword: "Project Northstar" },
      { company_id: companyId, keyword: "Helios Migration" },
    ],
    { onConflict: "company_id,keyword", ignoreDuplicates: true }
  );

  console.log("\nDone. Reload the dashboard.\n");
  console.log(`Repeat-override demo ID: ${overrider.hash} (${overrider.department})\n`);
}

(process.argv.includes("--list") ? listCompanies() : seed()).catch((e) => {
  console.error("\nfailed:", e.message, "\n");
  process.exit(1);
});
