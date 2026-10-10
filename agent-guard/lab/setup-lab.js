#!/usr/bin/env node
/**
 * Shadow AI Guard — demo lab generator
 * ====================================
 * Creates a throw-away "company project" full of FAKE secrets, OUTSIDE this
 * repository, and switches the guard on for it in every AI coding tool:
 *
 *   node agent-guard/lab/setup-lab.js                 → ../shadow-ai-agent-lab (next to this repo)
 *   node agent-guard/lab/setup-lab.js <folder>        → a folder of your choice
 *   node agent-guard/lab/setup-lab.js --remove [dir]  → switch the hooks off and delete the lab
 *
 * Why generated instead of committed:
 *   - the fake keys look real enough that GitHub push protection blocks them,
 *     so they are assembled here at runtime and never stored in git;
 *   - the hook files must point at THIS machine's clone of agent-guard.
 *
 * Nothing in the lab is a real credential, card or person.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const GUARD = path.resolve(__dirname, "..");
const REPO = path.resolve(GUARD, "..");
const MARKER = ".shadow-ai-lab";
const args = process.argv.slice(2);
const REMOVE = args.includes("--remove");
const FORCE = args.includes("--force");
const target = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(REPO, "..", "shadow-ai-agent-lab"));
const install = require(path.join(GUARD, "lib", "install"));

// ------------------------------------------------------------------ fake data (assembled, never stored in git)
const STRIPE = "sk" + "_live_" + "51LabFakeOnly" + "abcdefghijklmnopqrstuvwxyz0123";
const OPENAI = "sk" + "-proj-" + "LabFakeOnly" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
const AWS_EXAMPLE = "AKIA" + "IOSFODNN7" + "EXAMPLE";     // AWS's own documentation example key
const HONEYTOKEN = "AKIA" + "LABCANARY0000001";
const CARD = "4111 1111 1111 1111";                     // standard Visa test number

function tinyPdf(lines) {   // a small valid one-page PDF, readable by pdf.js
  const body = "BT /F1 12 Tf 72 740 Td 16 TL " + lines.map((l) => `(${l.replace(/[()\\]/g, "")}) Tj T*`).join(" ") + " ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const FILES = {
  [MARKER]: "Created by agent-guard/lab/setup-lab.js. Safe to delete with: node agent-guard/lab/setup-lab.js --remove\n",
  "package.json": JSON.stringify({ name: "shadow-ai-agent-lab", private: true, type: "commonjs",
    description: "Demo lab for Shadow AI Guard. Every secret in here is fake." }, null, 2) + "\n",
  ".shadow-ai-policy.json": JSON.stringify({ _comment: "Lab-only extras on top of the company policy from the dashboard.",
    honeytokens: [HONEYTOKEN], customKeywords: ["Project Falcon"] }, null, 2) + "\n",
  // the guide, with this machine's real paths filled in
  "README.md": fs.readFileSync(path.join(__dirname, "README.md"), "utf8")
    .split("<repo>").join(REPO.split(path.sep).join("/")).split("<lab>").join(target.split(path.sep).join("/")),

  // a small "company project"
  "sample-app/.env": `# FAKE secrets for the Shadow AI lab — none of these are real\nDATABASE_URL=postgres://admin:Sup3rS3cret!2024@10.0.4.12:5432/payments\n` +
    `STRIPE_SECRET_KEY=${STRIPE}\nOPENAI_API_KEY=${OPENAI}\nAWS_ACCESS_KEY_ID=${HONEYTOKEN}\n`,
  "sample-app/.env.example": "DATABASE_URL=\nSTRIPE_SECRET_KEY=\nOPENAI_API_KEY=\nAWS_ACCESS_KEY_ID=\n",
  "sample-app/src/payment.js": "// A normal source file — nothing sensitive. The agent may read this freely.\n" +
    "export async function charge(amountInPaise, customerId) {\n  if (amountInPaise <= 0) throw new Error(\"amount must be positive\");\n" +
    "  const res = await fetch(\"/api/charge\", {\n    method: \"POST\",\n    headers: { \"Content-Type\": \"application/json\" },\n" +
    "    body: JSON.stringify({ amount: amountInPaise, customer: customerId }),\n  });\n  return res.json();\n}\n",
  "sample-app/src/legacy-config.js": `// TODO: remove before release\nexport const STRIPE = "${STRIPE}";\n`,
  "sample-app/data/customers.csv": `name,email,phone,card\nR. Nair,r.nair@example.in,98765 43210,${CARD}\nS. Iyer,s.iyer@example.in,91234 56780,5500 0000 0000 0004\n`,
  "sample-app/docs/notes.md": "# Team notes\n\nProject Falcon launch moves to Q3. Keep this internal.\n",

  // files to read / attach / upload in the AI tools
  "sample-app/test-files/server-notes.txt": "Deployment notes - staging rebuild\n\nThe API box at 192.168.10.5 keeps dropping connections after the\n" +
    `nightly job. Worker at 10.0.12.7 is fine.\n\nRotate before Friday: ${AWS_EXAMPLE}\nstaging db password: Sup3rS3cret!2024\n`,
  "sample-app/test-files/board-memo.md": "STRICTLY CONFIDENTIAL - internal only\n\nBoard minutes: term sheet from Northwind received, valuation 40M.\n",
  "sample-app/test-files/prod-keys.txt": `Production keys (do not share)\nSTRIPE_SECRET_KEY=${STRIPE}\n`,
  "sample-app/test-files/customer-export.csv": "name,email,phone\nA. Rao,a.rao@example.in,+91 98765 43210\nK. Das,k.das@example.in,+91 91234 56780\n",
  "sample-app/test-files/meeting-notes.txt": "Sprint planning: refactor payment.js, add retries, write tests.\n",
  "sample-app/test-files/Q3-forecast-CONFIDENTIAL.pdf": tinyPdf(["Q3 FORECAST - STRICTLY CONFIDENTIAL",
    "Revenue target 40M, term sheet under negotiation.", `Corporate card on file: ${CARD}`, "Contact: cfo@example.in"]),
};

// ------------------------------------------------------------------ remove
if (REMOVE) {
  if (!fs.existsSync(path.join(target, MARKER))) { console.error("Not a lab created by this script (no " + MARKER + "): " + target); process.exit(1); }
  for (const t of ["claude-code", "cursor", "windsurf", "antigravity"]) { try { install.uninstall(t, target); } catch (e) {} }
  try { install.uninstall("git", target); } catch (e) {}
  fs.rmSync(target, { recursive: true, force: true });
  console.log("Lab removed: " + target);
  process.exit(0);
}

// ------------------------------------------------------------------ create
const rel = path.relative(REPO, target);
if (!rel.startsWith("..") && !path.isAbsolute(rel)) { console.error("The lab must be OUTSIDE this repository (it is full of fake secrets): " + target); process.exit(1); }
if (fs.existsSync(target) && fs.readdirSync(target).length && !fs.existsSync(path.join(target, MARKER)) && !FORCE) {
  console.error("Folder exists and wasn't created by this script: " + target + "\nChoose another folder, or add --force.");
  process.exit(1);
}
for (const [relPath, data] of Object.entries(FILES)) {
  const f = path.join(target, relPath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

const done = [], skipped = [];
for (const t of ["claude-code", "cursor", "windsurf", "antigravity"]) {
  try { install.install(t, target); done.push(t); } catch (e) { skipped.push(t + " (" + e.message + ")"); }
}
let gitNote = "";
try {
  execFileSync("git", ["init", "-q"], { cwd: target, stdio: "ignore" });
  install.install("git", target);
  done.push("git pre-commit");
} catch (e) { gitNote = " (git not found — commit demo skipped)"; }

console.log(`
Shadow AI Guard lab ready: ${target}

  Hooks on for: ${done.join(", ")}${gitNote}${skipped.length ? "\n  Skipped: " + skipped.join("; ") : ""}
  All secrets in it are FAKE. Remove it any time with:
    node "${path.join(GUARD, "lab", "setup-lab.js")}" --remove "${target}"

Next:
  1. (optional, for the dashboard) node "${path.join(GUARD, "cli.js")}" login
  2. Open the folder above in Claude Code / Cursor / Antigravity / Windsurf.
  3. Follow README.md inside the lab.
`);
