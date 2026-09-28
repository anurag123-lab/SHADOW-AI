/**
 * Reads the root .env and writes the values into every place that needs
 * them. Run this after editing .env; re-run it any time the keys change.
 *
 *   .env  ->  extension/src/core/config.js   (URL + anon key)
 *         ->  dashboard/assets/config.js     (URL + anon key)
 *         ->  notifier/.env                  (URL + SERVICE ROLE key + SMTP)
 *
 * Why this script exists: a browser extension and a static HTML page have
 * no build step, so they cannot read a .env file at runtime — the values
 * have to be written into source. Doing that by hand across three files
 * is how the service_role key ends up somewhere it must never be, so the
 * split is automated and the anon/service boundary is enforced below.
 *
 * Secrets are never printed. Only key lengths and a masked prefix.
 *
 * Run: npm run sync-config
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

/* ------------------------------------------------------------------ */
function fail(message, hint) {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function mask(value) {
  if (!value) return "(empty)";
  return `${value.slice(0, 6)}…${value.slice(-4)}  (${value.length} chars)`;
}

/** Decodes a Supabase JWT's role claim so we can verify it's the right key. */
function roleOf(jwt) {
  try {
    const payload = jwt.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return claims.role || null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
if (!fs.existsSync(ENV_PATH)) {
  fail(
    ".env not found at the project root.",
    "Create it:  cp .env.example .env    then fill in the three Supabase values.\n" +
      "  (Editing .env.example does nothing — it's the template, not the config.)"
  );
}

const env = parseEnv(fs.readFileSync(ENV_PATH, "utf8"));

const url = env.SUPABASE_URL;
const anon = env.SUPABASE_ANON_KEY;
const service = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) fail("SUPABASE_URL is empty in .env.", "Supabase dashboard -> Project Settings -> API -> Project URL");
if (!anon) fail("SUPABASE_ANON_KEY is empty in .env.", "Supabase dashboard -> Project Settings -> API -> anon / public");
if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url.replace(/\/+$/, ""))) {
  fail(`SUPABASE_URL doesn't look right: ${url}`, "Expected something like https://abcdefghijklmnop.supabase.co (no trailing path).");
}

/* ---- the check that matters: are the two keys the right way round? ---- */
const anonRole = roleOf(anon);
const serviceRole = service ? roleOf(service) : null;

if (anonRole === "service_role") {
  fail(
    "SUPABASE_ANON_KEY holds a SERVICE ROLE key.",
    "That key bypasses row-level security. If it ships in the extension or dashboard,\n" +
      "  anyone can read every company's data. Swap the two values in .env and re-run."
  );
}
if (anonRole && anonRole !== "anon") {
  console.warn(`\n  Warning: SUPABASE_ANON_KEY has role "${anonRole}", expected "anon".`);
}
if (service && serviceRole && serviceRole !== "service_role") {
  console.warn(`\n  Warning: SUPABASE_SERVICE_ROLE_KEY has role "${serviceRole}", expected "service_role".`);
}

const cleanUrl = url.replace(/\/+$/, "");

/* ------------------------------------------------------------------ *
 * Write the targets
 * ------------------------------------------------------------------ */
const written = [];

function patchConfig(rel, urlVar, keyVar) {
  const full = path.join(ROOT, rel);
  let src = fs.readFileSync(full, "utf8");

  // Verify the constants EXIST before rewriting. Checking whether the
  // content changed instead would report a false failure on a re-run,
  // where the correct values are already in place and the replace is a
  // no-op — which is exactly what an idempotent sync should allow.
  const urlPattern = new RegExp(`(${urlVar}\\s*[:=]\\s*)"[^"]*"`);
  const keyPattern = new RegExp(`(${keyVar}\\s*[:=]\\s*)"[^"]*"`);

  if (!urlPattern.test(src) || !keyPattern.test(src)) {
    fail(
      `Could not find the ${urlVar} / ${keyVar} constants in ${rel}.`,
      "Was the file edited by hand? Restore the marked block and re-run."
    );
  }

  src = src.replace(urlPattern, `$1"${cleanUrl}"`);
  src = src.replace(keyPattern, `$1"${anon}"`);

  fs.writeFileSync(full, src);
  written.push(rel);
}

patchConfig("extension/src/core/config.js", "SUPABASE_URL", "SUPABASE_ANON_KEY");
patchConfig("dashboard/assets/config.js", "SUPABASE_URL", "SUPABASE_ANON_KEY");

/* ---- notifier/.env — the ONLY place the service role key goes ---- */
const notifierEnv = path.join(ROOT, "notifier", ".env");
const notifierLines = [
  "# Generated by scripts/sync-config.js — server-side only, never shipped to a client.",
  `SUPABASE_URL=${cleanUrl}`,
  `SUPABASE_SERVICE_ROLE_KEY=${service || ""}`,
  "",
  `SMTP_HOST=${env.SMTP_HOST || "sandbox.smtp.mailtrap.io"}`,
  `SMTP_PORT=${env.SMTP_PORT || "2525"}`,
  `SMTP_USER=${env.SMTP_USER || ""}`,
  `SMTP_PASSWORD=${env.SMTP_PASSWORD || ""}`,
  `ALERT_FROM=${env.ALERT_FROM || '"Shadow AI Guard <alerts@shadowaiguard.demo>"'}`,
  `NOTIFIER_INTERVAL_MINUTES=${env.NOTIFIER_INTERVAL_MINUTES || "2"}`,
  "",
  "# What triggers an email: critical | high | all",
  `ALERT_ON=${env.ALERT_ON || "critical"}`,
  "",
  "# Filenames are withheld from email by default (the dashboard keeps them).",
  `EMAIL_INCLUDE_FILENAMES=${env.EMAIL_INCLUDE_FILENAMES || "0"}`,
  "",
  `# Set to 1 to print alert emails to the console instead of sending them.`,
  `DRY_RUN=${env.SMTP_USER ? env.DRY_RUN || "0" : "1"}`,
  "",
].join("\n");

fs.writeFileSync(notifierEnv, notifierLines);
written.push("notifier/.env");

/* ------------------------------------------------------------------ */
console.log("\n  Config synced from .env\n");
console.log(`  Project URL      ${cleanUrl}`);
console.log(`  anon key         ${mask(anon)}${anonRole ? `  role=${anonRole}` : ""}`);
console.log(`  service key      ${service ? mask(service) : "(not set — notifier will not run)"}${serviceRole ? `  role=${serviceRole}` : ""}`);
console.log("\n  Written:");
written.forEach((w) => console.log(`    ${w}`));
console.log("\n  The service role key went ONLY to notifier/.env.");
console.log("  The extension and dashboard carry the anon key, which is safe to ship.\n");
console.log("  Next:  npm run preflight\n");
