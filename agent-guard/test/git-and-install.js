/**
 * Git layer (pre-commit + CI scan) and `cli.js install` — all inside
 * throw-away repos under the OS temp folder.
 *
 *   node agent-guard/test/git-and-install.js
 */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN = path.join(ROOT, "git", "scan.js");
const CLI = path.join(ROOT, "cli.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-git-"));
const HOME = path.join(TMP, "home");
const ENV = { ...process.env, SHADOW_HOME: HOME, SHADOW_NO_SEND: "1", SHADOW_DEDUP_MS: "0" };
const LIVE_KEY = "sk" + "_live_" + "51TestOnly" + "abcdefghijklmnopqrstuvwxyz0123";
const CARD = "4111 1111 1111 1111";

const results = [];
function check(name, ok, got) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)}${ok ? "" : " → got " + String(got).slice(0, 300)}`);
}
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: ENV });
const git = (args, cwd) => sh("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "core.autocrlf=false", ...args], cwd);
function repo(name) {
  const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true });
  git(["init", "-q", "-b", "main"], d);
  return d;
}
const put = (d, rel, text) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const scan = (d, ...args) => sh(process.execPath, [SCAN, ...args], d);

// ------------------------------------------------------------------ scanner
console.log("\nGit scanner  (git/scan.js)\n" + "-".repeat(78));
let d = repo("scan");
put(d, "src/app.js", "module.exports = 1;\n");
git(["add", "."], d);
let r = scan(d, "--staged");
check("clean staged change → exit 0", r.status === 0, r.status + r.stdout);

put(d, "src/config.js", `// TODO move\nconst stripe = "${LIVE_KEY}";\n`);
git(["add", "."], d);
r = scan(d, "--staged");
check("staged live key → exit 1, file:line reported", r.status === 1 && /src\/config\.js:2/.test(r.stdout), r.status + r.stdout);
check("output never contains the secret itself", !r.stdout.includes(LIVE_KEY) && !r.stderr.includes(LIVE_KEY), r.stdout);
git(["reset", "-q"], d); fs.unlinkSync(path.join(d, "src/config.js"));

put(d, ".env", "DEBUG=true\n");
git(["add", "-f", ".env"], d);
r = scan(d, "--staged");
check("committing a .env file (even harmless) → exit 1", r.status === 1 && /secrets file committed/.test(r.stdout), r.status + r.stdout);
git(["reset", "-q"], d); fs.unlinkSync(path.join(d, ".env"));

put(d, ".env.example", "STRIPE_SECRET_KEY=\n");
git(["add", "."], d);
r = scan(d, "--staged");
check(".env.example template → allowed", r.status === 0, r.status + r.stdout);

put(d, "data/customers.csv", `name,card\nR. Nair,${CARD}\n`);
git(["add", "."], d);
r = scan(d, "--staged");
check("customer card numbers → exit 1", r.status === 1 && /customers\.csv:2/.test(r.stdout), r.status + r.stdout);
put(d, ".shadow-ai-ignore", "# test fixtures\ndata/**\n");
git(["add", "."], d);
r = scan(d, "--staged");
check(".shadow-ai-ignore allow-lists a fixture folder", r.status === 0, r.status + r.stdout);
git(["reset", "-q"], d);
fs.rmSync(path.join(d, "data"), { recursive: true }); fs.unlinkSync(path.join(d, ".shadow-ai-ignore"));

put(d, "docs/plan.md", "Project Falcon launch moves to Q3.\n");
put(d, ".shadow-ai-policy.json", JSON.stringify({ customKeywords: ["Project Falcon"] }));
git(["add", "."], d);
r = scan(d, "--staged");
check("company keyword (Warn) → printed but allowed", r.status === 0 && /plan\.md:1/.test(r.stdout), r.status + r.stdout);
r = scan(d, "--staged", "--strict");
check("--strict → Warn findings fail too", r.status === 1, r.status);

// CI modes
git(["commit", "-q", "-m", "base", "--no-verify"], d);
git(["checkout", "-q", "-b", "feature"], d);
put(d, "src/pay.js", `const k = "${LIVE_KEY}";\n`);
git(["add", "."], d); git(["commit", "-q", "-m", "feat", "--no-verify"], d);
r = scan(d, "--diff", "main");
check("CI --diff main → catches the key added on the branch", r.status === 1 && /src\/pay\.js:1/.test(r.stdout), r.status + r.stdout);
r = scan(d, "--all");
check("CI --all → full-repo scan also fails", r.status === 1, r.status);
r = scan(d, "src/app.js");
check("explicit path, clean file → exit 0", r.status === 0, r.status + r.stdout);

// ------------------------------------------------------------------ real git commit through the installed hook
console.log("\nPre-commit hook  (cli.js install git)\n" + "-".repeat(78));
d = repo("hooked");
r = sh(process.execPath, [CLI, "install", "git", d], d);
check("install git → writes .git/hooks/pre-commit", r.status === 0 && fs.existsSync(path.join(d, ".git", "hooks", "pre-commit")), r.stdout + r.stderr);
put(d, "src/config.js", `const stripe = "${LIVE_KEY}";\n`);
git(["add", "."], d);
r = git(["commit", "-q", "-m", "leak"], d);
const commits = () => git(["rev-list", "--all", "--count"], d).stdout.trim();
check("git commit with a live key → rejected, nothing committed", r.status !== 0 && commits() === "0", r.status + " commits=" + commits());
fs.writeFileSync(path.join(d, "src/config.js"), "const stripe = process.env.STRIPE_SECRET_KEY;\n");
git(["add", "."], d);
r = git(["commit", "-q", "-m", "fixed"], d);
check("after moving the key to an env var → commit succeeds", r.status === 0 && commits() === "1", r.status + r.stderr);

// dashboard event (fake signed-in session; queue only)
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, "session.json"), JSON.stringify({ email: "d@example.com", company_id: "00000000-0000-0000-0000-000000000001",
  employee_hash: "emp_0123456789abcdef", department: "Engineering", company_name: "T", access_token: "x", refresh_token: "y", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
fs.writeFileSync(path.join(HOME, "policy-cache.json"), JSON.stringify({ fetchedAt: Date.now(), policyOverrides: {}, honeytokens: [], customKeywords: [] }));
put(d, "src/b.js", `const stripe = "${LIVE_KEY}";\n`);
git(["add", "."], d);
git(["commit", "-q", "-m", "leak2"], d);
let q = [];
try { q = fs.readFileSync(path.join(HOME, "queue.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) {}
const ev = q[q.length - 1] || {};
check("blocked commit → one dashboard event 'git pre-commit' / blocked", q.length === 1 && ev.ai_tool === "git pre-commit" && ev.action === "blocked" && ev.file_name === "b.js", JSON.stringify(q));
check("dashboard event holds no secret", !JSON.stringify(q).includes(LIVE_KEY), "leak");
git(["reset", "-q"], d);

r = sh(process.execPath, [CLI, "uninstall", "git", d], d);
check("uninstall git → hook removed", r.status === 0 && !fs.existsSync(path.join(d, ".git", "hooks", "pre-commit")), r.stdout + r.stderr);

// ------------------------------------------------------------------ installer for the AI tools
console.log("\nInstaller  (cli.js install <tool>)\n" + "-".repeat(78));
const proj = path.join(TMP, "proj"); fs.mkdirSync(proj);
put(proj, ".cursor/hooks.json", JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }] } }));
r = sh(process.execPath, [CLI, "install", "all", proj], proj);
const J = (rel) => JSON.parse(fs.readFileSync(path.join(proj, rel), "utf8"));
check("install all → exit 0", r.status === 0, r.stdout + r.stderr);
const c = J(".claude/settings.json");
check("Claude Code: UserPromptSubmit + PreToolUse → guard.js claude-code", c.hooks.UserPromptSubmit[0].hooks[0].command.endsWith('guard.js" claude-code') && c.hooks.PreToolUse[0].matcher.includes("Bash"), JSON.stringify(c));
const cu = J(".cursor/hooks.json");
check("Cursor: 5 events, existing afterFileEdit hook kept", ["beforeSubmitPrompt", "beforeReadFile", "beforeShellExecution", "beforeMCPExecution", "preToolUse"].every((e) => cu.hooks[e][0].command.endsWith('guard.js cursor')) && cu.hooks.afterFileEdit.length === 1, JSON.stringify(cu));
const w1 = J(".devin/hooks.json"), w2 = J(".windsurf/hooks.json");
check("Windsurf/Devin: .devin + .windsurf, command + powershell", w1.hooks.pre_run_command[0].powershell.includes("windsurf") && w2.hooks.pre_read_code.length === 1, JSON.stringify(w1));
const a = J(".agents/hooks.json");
check("Antigravity: .agents/hooks.json PreToolUse matcher *", a["shadow-ai-guard"].enabled === true && a["shadow-ai-guard"].PreToolUse[0].matcher === "*", JSON.stringify(a));
// Antigravity 2.4 (Windows) runs hooks without a shell: quotes would reach node literally
check("Antigravity command has no quotes (no-shell runner)", !a["shadow-ai-guard"].PreToolUse[0].hooks[0].command.includes('"'), a["shadow-ai-guard"].PreToolUse[0].hooks[0].command);
sh(process.execPath, [CLI, "install", "cursor", proj], proj);
check("re-install is idempotent (no duplicate entries)", J(".cursor/hooks.json").hooks.beforeShellExecution.length === 1, JSON.stringify(J(".cursor/hooks.json")));
r = sh(process.execPath, [CLI, "uninstall", "all", proj], proj);
check("uninstall all → our entries gone, user's own hook kept", r.status === 0 && !J(".cursor/hooks.json").hooks.beforeShellExecution && J(".cursor/hooks.json").hooks.afterFileEdit.length === 1 && !J(".agents/hooks.json")["shadow-ai-guard"], r.stdout + r.stderr);
r = sh(process.execPath, [CLI, "install", "cursor", path.resolve(ROOT, "..")], TMP);
check("refuses to install inside the Shadow AI Guard repo", r.status === 1 && /Refusing/.test(r.stderr), r.status + r.stderr);

fs.rmSync(TMP, { recursive: true, force: true });
const passed = results.filter(Boolean).length;
console.log("=".repeat(78) + `\n${passed} / ${results.length} passed\n`);
process.exitCode = passed === results.length ? 0 : 1;
