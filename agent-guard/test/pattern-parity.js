/**
 * Pattern parity: every pattern type the browser extension detects is
 * detected by EVERY hook of EVERY tool, with the same tier.
 *
 * For each type in patterns.ALL_PATTERN_TYPES there is one sample. The
 * extension's own detector gives the expected tier; then the sample is
 * pushed through each channel:
 *
 *   Claude Code   prompt · @attached file · Read · Write · Bash · MCP
 *   Cursor        beforeSubmitPrompt · attachments · beforeReadFile · preToolUse(Write) · beforeShellExecution · beforeMCPExecution
 *   Windsurf      pre_user_prompt · pre_read_code · pre_write_code · pre_run_command · pre_mcp_tool_use
 *   Antigravity   view_file · write_to_file · run_command · MCP tool
 *   git           pre-commit scan
 *
 * Pass = Mandatory → blocked; Warn → asked / warned / blocked-with-override
 * (never silently allowed); and the logged event names that pattern type.
 * Secret-shaped samples are assembled at runtime (GitHub push protection).
 *
 *   node agent-guard/test/pattern-parity.js        (-v to list every cell)
 */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GUARD = path.join(ROOT, "guard.js");
const SCAN = path.join(ROOT, "git", "scan.js");
const P = require(path.join(ROOT, "..", "extension", "src", "core", "patterns.js"));
const D = require(path.join(ROOT, "..", "extension", "src", "core", "detector.js"));
const VERBOSE = process.argv.includes("-v");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-parity-"));
const APP = path.join(TMP, "app"), HOME = path.join(TMP, "home");
const ENV = { ...process.env, SHADOW_HOME: HOME, SHADOW_NO_SEND: "1", SHADOW_DEDUP_MS: "0" };
delete ENV.SHADOW_GUARD_OFF;

const HONEYTOKEN = "ACME-HT-" + "9F3K2Q";
const KEYWORD = "Project Falcon";
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(APP, ".shadow-ai-policy.json"), JSON.stringify({ honeytokens: [HONEYTOKEN], customKeywords: [KEYWORD] }));

// one realistic sample per pattern type
const SAMPLES = {
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq3xYz\n-----END " + "RSA PRIVATE KEY-----",
  awsKey: "aws id " + "AKIA" + "Q7Z3M5X9V2B4N6L8",
  apiKey: "stripe " + "sk" + "_live_" + "51TestOnly" + "abcdefghijklmnopqrstuvwxyz0123",
  cardNumber: "card 4111 1111 1111 1111 exp 09/29",
  panCard: "PAN of the vendor: ABCPE1234F",
  gstin: "GSTIN 27AAPFU0939F1ZV on the invoice",
  ifscCode: "transfer to IFSC SBIN0001234",
  email: "write to r.nair@example.in",
  phone: "call me on +91 98765 43210",
  ipAddress: "db host 10.0.4.12",
  confidentialityMarker: "This memo is strictly confidential.",
  legalTerm: "Draft the non-disclosure agreement for the vendor.",
  hrTerm: "Prepare the offer letter for the new hire.",
  corporateStrategyTerm: "Summarise the term sheet from the investor.",
  ipTerm: "This algorithm is a trade secret.",
  healthTerm: "Attach the patient id to the claim.",
  genericSecret: "staging db password: Sup3rS3cret!2024",
  customKeyword: `${KEYWORD} launch moves to Q3.`,
  honeytoken: `old config value ${HONEYTOKEN}`,
};

// ground truth = the extension's own detector, same keywords + honeytokens
function truth(type) {
  D.reset(); D.setHoneytokens([HONEYTOKEN]); D.setCustomKeywords([KEYWORD]);
  const r = D.scan(SAMPLES[type]);
  return { tier: r.overallTier, types: r.patternTypes };
}

// ------------------------------------------------------------------ channels
const file = (type) => path.join(APP, "samples", `${type}-notes.txt`);
const mcpArgs = (s) => ({ channel: "#general", text: s });
const shellCmd = (s) => `echo "${s.replace(/\n/g, " ")}" > out.txt`;
const CHANNELS = [
  ["Claude Code", "prompt", "claude-code", (s) => ({ hook_event_name: "UserPromptSubmit", cwd: APP, prompt: `help me with this: ${s}` }), "prompt"],
  ["Claude Code", "@attached file", "claude-code", (s, t) => ({ hook_event_name: "UserPromptSubmit", cwd: APP, prompt: `summarise @samples/${t}-notes.txt` }), "prompt"],
  ["Claude Code", "Read", "claude-code", (s, t) => ({ hook_event_name: "PreToolUse", cwd: APP, tool_name: "Read", tool_input: { file_path: file(t) } }), "tool"],
  ["Claude Code", "Write", "claude-code", (s) => ({ hook_event_name: "PreToolUse", cwd: APP, tool_name: "Write", tool_input: { file_path: path.join(APP, "src", "x.js"), content: `// ${s}` } }), "tool"],
  ["Claude Code", "Bash", "claude-code", (s) => ({ hook_event_name: "PreToolUse", cwd: APP, tool_name: "Bash", tool_input: { command: shellCmd(s) } }), "tool"],
  ["Claude Code", "MCP", "claude-code", (s) => ({ hook_event_name: "PreToolUse", cwd: APP, tool_name: "mcp__slack__send_message", tool_input: mcpArgs(s) }), "tool"],
  ["Cursor", "prompt", "cursor", (s) => ({ hook_event_name: "beforeSubmitPrompt", workspace_roots: [APP], prompt: `help me with this: ${s}` }), "prompt"],
  ["Cursor", "attachment", "cursor", (s, t) => ({ hook_event_name: "beforeSubmitPrompt", workspace_roots: [APP], prompt: "summarise the attached file", attachments: [{ type: "file", file_path: file(t) }] }), "prompt"],
  ["Cursor", "beforeReadFile", "cursor", (s, t) => ({ hook_event_name: "beforeReadFile", workspace_roots: [APP], file_path: file(t), content: s }), "read"],
  ["Cursor", "preToolUse Write", "cursor", (s) => ({ hook_event_name: "preToolUse", workspace_roots: [APP], tool_name: "Write", tool_input: { file_path: path.join(APP, "src", "x.js"), content: `// ${s}` } }), "read"],
  ["Cursor", "shell", "cursor", (s) => ({ hook_event_name: "beforeShellExecution", workspace_roots: [APP], cwd: APP, command: shellCmd(s) }), "tool"],
  ["Cursor", "MCP", "cursor", (s) => ({ hook_event_name: "beforeMCPExecution", workspace_roots: [APP], tool_name: "send_message", tool_input: mcpArgs(s) }), "tool"],
  ["Windsurf", "prompt", "windsurf", (s) => ({ agent_action_name: "pre_user_prompt", tool_info: { user_prompt: `help me with this: ${s}` } }), "prompt"],
  ["Windsurf", "read_code", "windsurf", (s, t) => ({ agent_action_name: "pre_read_code", tool_info: { file_path: file(t) } }), "read"],
  ["Windsurf", "write_code", "windsurf", (s) => ({ agent_action_name: "pre_write_code", tool_info: { file_path: path.join(APP, "src", "x.js"), edits: [{ old_string: "", new_string: `// ${s}` }] } }), "read"],
  ["Windsurf", "run_command", "windsurf", (s) => ({ agent_action_name: "pre_run_command", tool_info: { command_line: shellCmd(s), cwd: APP } }), "read"],
  ["Windsurf", "MCP", "windsurf", (s) => ({ agent_action_name: "pre_mcp_tool_use", tool_info: { mcp_server_name: "slack", mcp_tool_name: "send_message", mcp_tool_arguments: mcpArgs(s) } }), "read"],
  ["Antigravity", "view_file", "antigravity", (s, t) => ({ workspacePaths: [APP], toolCall: { name: "view_file", args: { AbsolutePath: file(t) } } }), "tool"],
  ["Antigravity", "write_to_file", "antigravity", (s) => ({ workspacePaths: [APP], toolCall: { name: "write_to_file", args: { TargetFile: path.join(APP, "src", "x.js"), CodeContent: `// ${s}` } } }), "tool"],
  ["Antigravity", "run_command", "antigravity", (s) => ({ workspacePaths: [APP], toolCall: { name: "run_command", args: { CommandLine: shellCmd(s), Cwd: APP } } }), "tool"],
  ["Antigravity", "MCP", "antigravity", (s) => ({ workspacePaths: [APP], toolCall: { name: "mcp_slack_send_message", args: mcpArgs(s) } }), "tool"],
];
// What a Warn finding may look like per channel kind:
//   prompt → blocked with the !sendanyway hint;  tool → ask;  read → allowed with a visible warning
const WARN_OK = { prompt: ["block"], tool: ["ask"], read: ["warn", "ask"] };

function verdictOf(tool, r, j) {
  if (tool === "claude-code") {
    if (!j) return "allow";
    if (j.decision === "block") return "block";
    return { deny: "block", ask: "ask" }[(j.hookSpecificOutput || {}).permissionDecision] || "allow";
  }
  if (tool === "cursor") {
    if (!j) return "no-answer";
    if (j.continue === false || j.permission === "deny") return "block";
    if (j.permission === "ask") return "ask";
    return j.user_message ? "warn" : "allow";
  }
  if (tool === "windsurf") return r.status === 2 ? "block" : /Shadow AI Guard/.test(r.stdout) ? "warn" : "allow";
  if (tool === "antigravity") return j ? ({ deny: "block", ask: "ask" }[j.decision] || "allow") : "allow";
}
const logFile = path.join(HOME, "events.log.jsonl");
const logCount = () => { try { return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).length; } catch (e) { return 0; } };
const lastLog = () => { try { const l = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean); return JSON.parse(l[l.length - 1]); } catch (e) { return {}; } };

// ------------------------------------------------------------------ run the matrix
const types = P.ALL_PATTERN_TYPES.slice();
const missingSample = types.filter((t) => !SAMPLES[t]);
const fails = [];
let cells = 0;
const grid = {};   // type → [mark per channel]

for (const type of types) {
  if (!SAMPLES[type]) continue;
  const s = SAMPLES[type];
  fs.mkdirSync(path.dirname(file(type)), { recursive: true });
  fs.writeFileSync(file(type), s + "\n");
  const t = truth(type);
  grid[type] = { tier: t.tier, marks: [] };
  if (!t.types.includes(type)) { fails.push(`${type}: the SAMPLE itself isn't detected by the extension as ${type} (got ${t.types.join(",") || "nothing"})`); continue; }

  for (const [toolName, channel, tool, build, kind] of CHANNELS) {
    cells++;
    const before = logCount();
    const r = spawnSync(process.execPath, [GUARD, tool], { input: JSON.stringify(build(s, type)), encoding: "utf8", cwd: APP, env: ENV });
    let j = null; try { j = r.stdout && r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null; } catch (e) {}
    const v = verdictOf(tool, r, j);
    const logged = logCount() > before ? lastLog() : null;
    const typeLogged = !!(logged && (logged.pattern_types || []).includes(type));
    const tierOk = t.tier === "MandatoryRedaction" ? v === "block" : WARN_OK[kind].includes(v);
    const ok = tierOk && typeLogged;
    grid[type].marks.push(ok ? (t.tier === "MandatoryRedaction" ? "✖" : "!") : "‼");
    if (!ok) fails.push(`${type} via ${toolName} ${channel}: expected ${t.tier === "MandatoryRedaction" ? "block" : WARN_OK[kind].join("/")}, got ${v}` +
      (typeLogged ? "" : `; event types ${logged ? JSON.stringify(logged.pattern_types) : "none logged"}`));
  }
}

// git pre-commit: every sample file committed at once, each must be reported
const REPO = path.join(TMP, "repo"); fs.mkdirSync(REPO);
const git = (a) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: REPO, encoding: "utf8", env: ENV });
git(["init", "-q"]);
fs.copyFileSync(path.join(APP, ".shadow-ai-policy.json"), path.join(REPO, ".shadow-ai-policy.json"));
for (const type of Object.keys(grid)) fs.writeFileSync(path.join(REPO, `${type}-notes.txt`), SAMPLES[type] + "\n");
git(["add", "."]);
const before = logCount();
const g = spawnSync(process.execPath, [SCAN, "--staged"], { cwd: REPO, encoding: "utf8", env: ENV });
const gitEvents = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l));
for (const type of Object.keys(grid)) {
  cells++;
  const hit = gitEvents.some((e) => (e.pattern_types || []).includes(type));
  const listed = g.stdout.includes(`${type}-notes.txt`);
  grid[type].marks.push(hit && listed ? (grid[type].tier === "MandatoryRedaction" ? "✖" : "!") : "‼");
  if (!(hit && listed)) fails.push(`${type} via git pre-commit: ${listed ? "listed" : "not listed"}, ${hit ? "reported" : "not reported"}`);
}

// ------------------------------------------------------------------ policy overrides (set on the dashboard) apply to the hooks too
// genericSecret promoted to Mandatory, panCard lowered to Warn — one channel per tool.
fs.writeFileSync(path.join(APP, ".shadow-ai-policy.json"), JSON.stringify({ honeytokens: [HONEYTOKEN], customKeywords: [KEYWORD],
  policyOverrides: { genericSecret: "MandatoryRedaction", panCard: "Warn" } }));
const overrideRows = [];
for (const [type, want] of [["genericSecret", "block"], ["panCard", "warnish"]]) {
  const marks = [];
  for (const idx of [2, 8, 13, 17]) {   // Claude Read, Cursor beforeReadFile, Windsurf read_code, Antigravity view_file
    const [toolName, channel, tool, build, kind] = CHANNELS[idx];
    cells++;
    const r = spawnSync(process.execPath, [GUARD, tool], { input: JSON.stringify(build(SAMPLES[type], type)), encoding: "utf8", cwd: APP, env: ENV });
    let j = null; try { j = r.stdout && r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null; } catch (e) {}
    const v = verdictOf(tool, r, j);
    const ok = want === "block" ? v === "block" : WARN_OK[kind].includes(v);
    marks.push(ok ? (want === "block" ? "✖" : "!") : "‼");
    if (!ok) fails.push(`override ${type} → ${want} via ${toolName} ${channel}: got ${v}`);
  }
  overrideRows.push(`  ${type.padEnd(23)}${(want === "block" ? "→ Mandatory" : "→ Warn").padEnd(14)}${marks.join("  ")}`);
}

// ------------------------------------------------------------------ report
const heads = [...CHANNELS.map(([t, c]) => `${t.split(" ")[0]} ${c}`), "git pre-commit"];
if (VERBOSE) {
  console.log("\nColumns:\n" + heads.map((h, i) => `  ${String(i + 1).padStart(2)}  ${h}`).join("\n"));
}
console.log("\nPattern parity — extension detector vs every hook of every tool");
console.log("  ✖ blocked (Mandatory)   ! Warn: asks / shows a warning / prompt held until !sendanyway   ‼ MISMATCH\n");
console.log("  " + "pattern type".padEnd(23) + "tier        " + "Claude Code".padEnd(13) + "Cursor".padEnd(13) + "Windsurf".padEnd(11) + "Antigravity  git");
for (const [type, g2] of Object.entries(grid)) {
  const m = g2.marks;
  const seg = (a, b) => m.slice(a, b).join("");
  console.log("  " + type.padEnd(23) + (g2.tier === "MandatoryRedaction" ? "Mandatory " : "Warn      ") + "  " +
    seg(0, 6).padEnd(13) + seg(6, 12).padEnd(13) + seg(12, 17).padEnd(11) + seg(17, 21).padEnd(13) + seg(21, 22));
}
console.log("\n  Dashboard policy override → same change in every tool (file read: Claude, Cursor, Windsurf, Antigravity)");
overrideRows.forEach((l) => console.log(l));
if (missingSample.length) fails.push("no sample for: " + missingSample.join(", "));
console.log("\n  " + types.length + " pattern types × " + (CHANNELS.length + 1) + " channels = " + cells + " checks");
if (fails.length) console.log("\n" + fails.map((f) => "FAIL  " + f).join("\n"));
console.log("=".repeat(78) + `\n${cells - fails.length} / ${cells} passed\n`);

fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = fails.length ? 1 : 0;
