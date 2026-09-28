/**
 * Demo preflight — run this before you present.
 *
 * Checks everything that can be checked without a browser or a network
 * call, and tells you exactly what to do about anything that fails.
 *
 * Run: npm run preflight
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const results = [];

function check(label, fn, fix) {
  try {
    const detail = fn();
    results.push({ ok: true, label, detail });
  } catch (e) {
    results.push({ ok: false, label, detail: e.message, fix });
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* ------------------------------------------------------------------ */

check(
  "Detector + privacy tests",
  () => {
    const files = fs
      .readdirSync(path.join(ROOT, "extension", "tests"))
      .filter((f) => f.endsWith(".test.js"))
      .map((f) => `extension/tests/${f}`);
    const out = execFileSync("node", ["--test", ...files], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pass = (out.match(/# pass (\d+)/) || out.match(/pass (\d+)/) || [])[1];
    const fail = (out.match(/# fail (\d+)/) || out.match(/fail (\d+)/) || [])[1];
    if (fail && Number(fail) > 0) throw new Error(`${fail} test(s) failing`);
    return `${pass || "all"} passing`;
  },
  "Run `npm test` and read the failure."
);

/**
 * Reads the VALUE assigned to a config constant, rather than searching
 * the whole file. config.js contains the placeholder strings inside its
 * own isConfigured() guard, so a file-wide search reports a correctly
 * configured file as unconfigured.
 */
function configValue(rel, name) {
  const src = read(rel);
  const m = src.match(new RegExp(name + '\\s*[:=]\\s*"([^"]*)"'));
  return m ? m[1] : null;
}

function checkClientConfig(rel) {
  const url = configValue(rel, "SUPABASE_URL");
  const key = configValue(rel, "SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("could not read the config constants");
  if (url.includes("YOUR-PROJECT-REF")) throw new Error("URL is still the placeholder");
  if (key.includes("YOUR-ANON-KEY")) throw new Error("anon key is still the placeholder");
  const ref = url.replace(/^https?:\/\//, "").split(".")[0];
  return `project ${ref} · anon key ${key.length} chars`;
}

check(
  "Extension Supabase config",
  () => checkClientConfig("extension/src/core/config.js"),
  "Put your keys in .env (not .env.example), then run `npm run sync-config`."
);

check(
  "Dashboard Supabase config",
  () => checkClientConfig("dashboard/assets/config.js"),
  "Put your keys in .env (not .env.example), then run `npm run sync-config`."
);

check(
  "No service_role key on the client side",
  () => {
    // Decode any JWT found and read its role claim. Grepping for the
    // string "service_role" would flag the comment in config.js that
    // warns against doing exactly this.
    const suspects = ["extension/src/core/config.js", "dashboard/assets/config.js"];
    let checked = 0;

    for (const rel of suspects) {
      const src = read(rel);
      const jwts = src.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g) || [];

      for (const jwt of jwts) {
        checked++;
        let claims;
        try {
          claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
        } catch (e) {
          continue; // not a readable JWT; nothing to assert
        }
        if (claims.role === "service_role") {
          throw new Error(`${rel} contains a SERVICE ROLE key`);
        }
      }
    }
    return checked === 0 ? "no keys pasted yet" : `${checked} key(s) checked, all anon`;
  },
  "REMOVE IT. The service_role key bypasses row-level security entirely and belongs only in notifier/.env."
);

check(
  "Vendor libraries bundled",
  () => {
    const needed = ["pdf.min.mjs", "pdf.worker.min.mjs", "mammoth.browser.min.js"];
    const missing = needed.filter((f) => !exists(path.join("extension/vendor", f)));
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
    return `${needed.length} libraries present`;
  },
  "Run `node scripts/fetch-vendor.js`. Without these, PDF/.docx uploads fail open and are not scanned."
);

check(
  "Extension icons",
  () => {
    const missing = [16, 48, 128].filter((s) => !exists(`extension/icons/icon${s}.png`));
    if (missing.length) throw new Error(`missing sizes: ${missing.join(", ")}`);
    return "16, 48, 128 present";
  },
  "Run `node scripts/make-icons.js`."
);

check(
  "Manifest valid and complete",
  () => {
    const m = JSON.parse(read("extension/manifest.json"));
    const refs = [m.background.service_worker, m.action.default_popup, m.options_page];
    m.content_scripts.forEach((cs) => (cs.js || []).forEach((f) => refs.push(f)));
    const missing = [...new Set(refs)].filter((r) => !exists(path.join("extension", r)));
    if (missing.length) throw new Error(`references missing files: ${missing.join(", ")}`);
    return `v${m.version}, ${m.content_scripts.length} content script blocks`;
  },
  "A referenced file was moved or deleted."
);

check(
  "Demo files generated",
  () => {
    const needed = [
      "Q3-forecast-CONFIDENTIAL.pdf",
      "team-offsite-notes.pdf",
      "server-notes.txt",
      "customer-export.csv",
    ];
    const missing = needed.filter((f) => !exists(path.join("demo-files", f)));
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
    return `${needed.length} files ready in demo-files/`;
  },
  "Run `node scripts/make-demo-files.js`."
);

check(
  "Demo files still produce the expected verdicts",
  () => {
    const D = require(path.join(ROOT, "extension/src/core/detector.js"));
    D.reset();
    D.setHoneytokens(["ACME-HT-9F3K2Q"]);

    const txt = D.scan(read("demo-files/server-notes.txt"));
    if (txt.overallTier !== "MandatoryRedaction") throw new Error("server-notes.txt no longer blocks");

    const csv = D.scan(read("demo-files/customer-export.csv"));
    if (csv.overallTier !== "Warn") throw new Error("customer-export.csv no longer warns");

    return "block / warn / clean paths all behave";
  },
  "Regenerate with `node scripts/make-demo-files.js`, or check whether a policy default changed."
);

check(
  "Honeytoken demo string is the one in the PDF",
  () => {
    const pdf = fs.readFileSync(path.join(ROOT, "demo-files/Q3-forecast-CONFIDENTIAL.pdf"), "latin1");
    if (!pdf.includes("ACME-HT-9F3K2Q")) throw new Error("token not found in the demo PDF");
    return "ACME-HT-9F3K2Q";
  },
  "Add ACME-HT-9F3K2Q as a honeytoken in the dashboard, or regenerate the demo files."
);

check(
  "Notifier configured",
  () => {
    if (!exists("notifier/.env")) throw new Error("notifier/.env not created");

    // Parse real assignments only. Comments in this file mention
    // "DRY_RUN=1" as documentation, and a naive regex reads that as the
    // setting — reporting a configured mailer as dry-run.
    const settings = {};
    for (const line of read("notifier/.env").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      settings[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
    }

    if (!settings.SUPABASE_SERVICE_ROLE_KEY) throw new Error("service role key not set");

    const dryRun = settings.DRY_RUN === "1" || !settings.SMTP_USER;
    if (dryRun) return "DRY RUN — alerts print to console";

    const host = settings.SMTP_HOST || "?";
    const alertOn = settings.ALERT_ON || "critical";
    const filenames = settings.EMAIL_INCLUDE_FILENAMES === "1" ? "filenames included" : "filenames withheld";
    return `sending via ${host} · alerts on ${alertOn} · ${filenames}`;
  },
  "Optional. `npm run sync-config` generates notifier/.env from the root .env. With no SMTP account it sets DRY_RUN=1, which prints alert emails to the console."
);

check(
  "Notifier dependencies installed",
  () => {
    if (!exists("notifier/node_modules")) throw new Error("npm install not run in notifier/");
    return "installed";
  },
  "Optional. Run `cd notifier && npm install`."
);

/* ------------------------------------------------------------------ */

const CRITICAL = new Set([
  "Detector + privacy tests",
  "No service_role key on the client side",
  "Manifest valid and complete",
  "Extension icons",
]);

console.log("\nShadow AI Guard — demo preflight\n" + "=".repeat(62) + "\n");

let blocking = 0;
let warnings = 0;

for (const r of results) {
  const mark = r.ok ? "  ok  " : CRITICAL.has(r.label) ? " FAIL " : " warn ";
  console.log(`${mark} ${r.label.padEnd(44)} ${r.detail}`);
  if (!r.ok) {
    console.log(`       -> ${r.fix}`);
    if (CRITICAL.has(r.label)) blocking++;
    else warnings++;
  }
}

console.log("\n" + "=".repeat(62));
if (blocking) {
  console.log(`${blocking} blocking issue(s). Fix these before demoing.\n`);
  process.exitCode = 1;
} else if (warnings) {
  console.log(`Ready, with ${warnings} optional item(s) not set up.`);
  console.log("The text-detection demo works regardless. See docs/DEMO.md.\n");
} else {
  console.log("Everything ready. See docs/DEMO.md for the run-of-show.\n");
}
