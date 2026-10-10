/**
 * Files attached to a prompt (@mentions, pasted paths, Cursor attachments),
 * the laptop-wide install, exempt folders, the hook heartbeat and the
 * duplicate-call guard. Everything runs in temp folders: a fake user home
 * (SHADOW_USER_HOME) and a fake global git config (GIT_CONFIG_GLOBAL), so
 * the real ~/.claude, ~/.cursor and git config are never touched.
 *
 *   node agent-guard/test/attachments-global.js
 */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GUARD = path.join(ROOT, "guard.js");
const CLI = path.join(ROOT, "cli.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-attach-"));
const APP = path.join(TMP, "app"), HOME = path.join(TMP, "home"), USER = path.join(TMP, "user");
const GITCFG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCFG, "");
const ENV = { ...process.env, SHADOW_HOME: HOME, SHADOW_NO_SEND: "1", SHADOW_DEDUP_MS: "0", SHADOW_USER_HOME: USER, GIT_CONFIG_GLOBAL: GITCFG };
const LIVE_KEY = "sk" + "_live_" + "51TestOnly" + "abcdefghijklmnopqrstuvwxyz0123";

const put = (rel, text) => { const f = path.join(APP, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
put("server-notes.txt", `Prod box notes\nstripe key ${LIVE_KEY}\n`);
put("db-notes.txt", "staging db password: Sup3rS3cret!2024\n");
put("board-memo.md", "CONFIDENTIAL - internal only. Q3 acquisition target list.\n");
put("my notes/plan.txt", "CONFIDENTIAL draft\n");
put("src/payment.js", "export const charge = (a) => a;\n");
put(".env", `STRIPE_SECRET_KEY=${LIVE_KEY}\n`);
const P = (rel) => path.join(APP, rel);

const results = [];
function check(name, ok, got) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(66)}${ok ? "" : " → got " + String(got).slice(0, 300)}`);
}
function guard(tool, input, env) {
  const r = spawnSync(process.execPath, [GUARD, tool], { input: JSON.stringify(input), encoding: "utf8", cwd: APP, env: { ...ENV, ...(env || {}) } });
  let j = null; try { j = r.stdout && r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null; } catch (e) {}
  return { code: r.status, j, out: r.stdout, err: r.stderr };
}
const cc = (prompt, extra) => guard("claude-code", { hook_event_name: "UserPromptSubmit", cwd: APP, prompt, ...(extra || {}) });
const blocked = (r) => r.j && r.j.decision === "block";
const logLines = () => { try { return fs.readFileSync(path.join(HOME, "events.log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };

// ------------------------------------------------------------------ attachments
console.log("\nFiles attached to a prompt\n" + "-".repeat(78));
let r = cc("summarise @server-notes.txt please");
check("Claude Code: @server-notes.txt with a live key → prompt blocked", blocked(r) && /server-notes\.txt/.test(r.j.reason), JSON.stringify(r.j));
check("…the message never repeats the key", !JSON.stringify(r.j).includes(LIVE_KEY), "leak");
r = cc("what's in @db-notes.txt");
check("Claude Code: @db-notes.txt with a plain-text password → blocked + hint", blocked(r) && /!sendanyway/.test(r.j.reason), JSON.stringify(r.j));
r = cc("review @board-memo.md");
check("Claude Code: @board-memo.md (CONFIDENTIAL) → blocked + hint", blocked(r) && /board-memo\.md/.test(r.j.reason), JSON.stringify(r.j));
r = cc("!sendanyway review @board-memo.md");
const last = logLines().pop() || {};
check("…!sendanyway → allowed and logged as sent_anyway", !r.out.trim() && last.action === "sent_anyway", r.out + JSON.stringify(last));
r = cc('look at @"my notes/plan.txt"');
check("Claude Code: quoted @\"path with spaces\" → checked", blocked(r), JSON.stringify(r.j));
r = cc(`read ${P("server-notes.txt")} and fix the bug`);
check("Claude Code: absolute path pasted into the prompt → blocked", blocked(r), JSON.stringify(r.j));
r = cc("open @.env and tell me the stripe key");
check("Claude Code: @.env → blocked (secrets file)", blocked(r) && /secrets file/.test(r.j.reason), JSON.stringify(r.j));
r = cc("refactor @src/payment.js#L1-3");
check("Claude Code: @src/payment.js#L1-3 (clean) → allowed", !r.out.trim(), r.out);
r = cc("email me at the usual place @nonexistent.txt");
check("Claude Code: @mention of a file that doesn't exist → ignored", !r.out.trim(), r.out);

r = guard("cursor", { hook_event_name: "beforeSubmitPrompt", workspace_roots: [APP], prompt: "summarise the attached file",
  attachments: [{ type: "file", file_path: P("server-notes.txt") }, { type: "rule", file_path: P("src/payment.js") }] });
check("Cursor: attachments[] with a live key → continue:false", r.j && r.j.continue === false && /server-notes/.test(r.j.user_message), JSON.stringify(r.j));
r = guard("cursor", { hook_event_name: "beforeSubmitPrompt", workspace_roots: [APP], prompt: "explain", attachments: [{ type: "file", file_path: P("src/payment.js") }] });
check("Cursor: clean attachment → continue:true", r.j && r.j.continue === true, JSON.stringify(r.j));
r = guard("windsurf", { agent_action_name: "pre_user_prompt", tool_info: { user_prompt: `check ${P("db-notes.txt")}` } });
check("Windsurf: prompt naming a file with a password → exit 2", r.code === 2 && /db-notes/.test(r.err), r.code + r.err);

const ev = logLines().filter((e) => e.ai_tool === "Claude Code (desktop)" && e.event === "prompt");
check("attachment events are logged with metadata only", ev.length >= 5 && !JSON.stringify(logLines()).includes(LIVE_KEY) && !JSON.stringify(logLines()).includes("Sup3rS3cret"), ev.length);

// Files UPLOADED into the chat (paperclip / drag-and-drop): Claude Code writes them into the
// transcript as `document` blocks just before UserPromptSubmit runs.
const TRANSCRIPT = path.join(TMP, "session.jsonl");
const AWS = "AKIA" + "Q7Z3M5X9V2B4N6L8";
function tinyPdf(line) {   // a minimal one-page PDF with one line of text
  const body = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
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
function upload(promptText, blocks, { withId = true } = {}) {
  const id = "p-" + Math.random().toString(16).slice(2);
  const rec = { type: "user", promptId: id, timestamp: new Date().toISOString(),
    message: { role: "user", content: [...blocks, { type: "text", text: promptText }] } };
  fs.appendFileSync(TRANSCRIPT, JSON.stringify({ type: "attachment", attachment: { type: "date" } }) + "\n" + JSON.stringify(rec) + "\n");
  return cc(promptText, { transcript_path: TRANSCRIPT, ...(withId ? { prompt_id: id } : {}) });
}
const textDoc = (title, text) => ({ type: "document", title, source: { type: "text", media_type: "text/plain", data: text } });
const b64Doc = (title, media, buf) => ({ type: "document", title, source: { type: "base64", media_type: media, data: buf.toString("base64") } });

r = upload("read this", [textDoc("server-notes.txt", `api host 192.168.10.5\nkey ${AWS}\n`)]);
check("uploaded server-notes.txt with an AWS key → prompt blocked", blocked(r) && /uploaded file "server-notes\.txt"/.test(r.j.reason) && /AWS/.test(r.j.reason), JSON.stringify(r.j));
check("…the reason names the file + category, never the key", !JSON.stringify(r.j).includes(AWS), "leak");
r = upload("summarise", [b64Doc("Q3-forecast.pdf", "application/pdf", tinyPdf(`card ${"4111 1111 1111 1111"}`))]);
check("uploaded PDF with a card number → blocked (pdf.js, same as extension)", blocked(r) && /Q3-forecast\.pdf/.test(r.j.reason) && /card/i.test(r.j.reason), JSON.stringify(r.j));
r = upload("summarise", [b64Doc("board.pdf", "application/pdf", tinyPdf("STRICTLY CONFIDENTIAL board minutes"))]);
check("uploaded confidential PDF → held with !sendanyway hint", blocked(r) && /!sendanyway/.test(r.j.reason), JSON.stringify(r.j));
r = upload("!sendanyway summarise", [b64Doc("board.pdf", "application/pdf", tinyPdf("STRICTLY CONFIDENTIAL board minutes"))]);
check("…!sendanyway → sent, logged as sent_anyway", !r.out.trim() && (logLines().pop() || {}).action === "sent_anyway", r.out);
r = upload("check config", [textDoc(".env", "DEBUG=true\n")]);
check("uploaded .env (even harmless) → blocked as a secrets file", blocked(r) && /secrets file/.test(r.j.reason), JSON.stringify(r.j));
r = upload("what is this", [b64Doc("photo.png", "image/png", Buffer.from([137, 80, 78, 71]))]);
check("unsupported upload (image) → fails open, like the extension", !r.out.trim(), r.out);
r = upload("fix this", [{ type: "text", text: `<ide_selection>const k = "${LIVE_KEY}";</ide_selection>` }]);
check("IDE selection sent with the prompt containing a key → blocked", blocked(r), JSON.stringify(r.j));
r = upload("look at this file", [textDoc("notes.txt", `key ${AWS}`)], { withId: false });
check("no prompt_id in the hook input → newest matching record still found", blocked(r), JSON.stringify(r.j));
{ // later records of the same turn (tool results) share the promptId — the lookup must skip them
  const id = "p-turn";
  fs.appendFileSync(TRANSCRIPT, JSON.stringify({ type: "user", promptId: id, timestamp: new Date().toISOString(),
    message: { role: "user", content: [textDoc("server-notes.txt", `key ${AWS}`), { type: "text", text: "add this file" }] } }) + "\n" +
    JSON.stringify({ type: "user", promptId: id, timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "blocked" }] } }) + "\n");
  r = cc("add this file", { transcript_path: TRANSCRIPT, prompt_id: id });
  check("same promptId on a later tool_result record → still finds the upload", blocked(r), JSON.stringify(r.j));
}
// AFTER sending: Claude Code wrote the upload only after UserPromptSubmit (new chat) → the next hook call reports it
{
  const T2 = path.join(TMP, "session2.jsonl");
  const stop = () => guard("claude-code", { hook_event_name: "Stop", cwd: APP, transcript_path: T2, stop_hook_active: false });
  const before = logLines().length;
  r = cc("read this", { transcript_path: T2, prompt_id: "late-1" });   // transcript doesn't exist yet
  check("upload not yet in transcript at prompt time → prompt goes through", !r.out.trim(), r.out);
  fs.writeFileSync(T2, JSON.stringify({ type: "user", uuid: "u-late-1", promptId: "late-1", timestamp: new Date().toISOString(),
    message: { role: "user", content: [textDoc("server-notes.txt", `host 192.168.10.5\nkey ${AWS}\n`), { type: "text", text: "read this" }] } }) + "\n");
  r = stop();
  const ev2 = logLines().slice(before).filter((e) => e.action === "uploaded_anyway");
  check("end-of-turn hook → reports it as uploaded_anyway (dashboard)", ev2.length === 1 && ev2[0].pattern_types.includes("awsKey"), JSON.stringify(ev2));
  check("…and warns the developer (systemMessage), without the key", r.j && /uploaded "server-notes\.txt"/.test(r.j.systemMessage || "") && !r.out.includes(AWS), r.out);
  r = stop();
  check("…only once: the next hook call doesn't report it again", !r.out.trim() && logLines().slice(before).filter((e) => e.action === "uploaded_anyway").length === 1, r.out);
  r = guard("claude-code", { hook_event_name: "PreToolUse", cwd: APP, transcript_path: T2, tool_name: "Read", tool_input: { file_path: P("src/payment.js") } });
  check("a later tool call still works normally", !r.out.trim(), r.out);
  // caught BEFORE sending → never reported a second time afterwards
  const T3 = path.join(TMP, "session3.jsonl");
  fs.writeFileSync(T3, JSON.stringify({ type: "user", uuid: "u-early", promptId: "early", timestamp: new Date().toISOString(),
    message: { role: "user", content: [textDoc("server-notes.txt", `key ${AWS}`), { type: "text", text: "read this" }] } }) + "\n");
  r = cc("read this", { transcript_path: T3, prompt_id: "early" });
  const n = logLines().length;
  const r3 = guard("claude-code", { hook_event_name: "Stop", cwd: APP, transcript_path: T3 });
  check("upload blocked before sending → not re-reported at end of turn", blocked(r) && !r3.out.trim() && logLines().length === n, r3.out);
}
r = upload("plain question", []);
check("prompt without uploads → allowed, no delay from the transcript", !r.out.trim(), r.out);

// Read through the agent's own tool still works as before (direct ask in chat)
r = guard("claude-code", { hook_event_name: "PreToolUse", cwd: APP, tool_name: "Read", tool_input: { file_path: P("db-notes.txt") } });
check("Claude Code Read db-notes.txt (password) → ask", r.j && r.j.hookSpecificOutput.permissionDecision === "ask", JSON.stringify(r.j));

// ------------------------------------------------------------------ heartbeat + dedupe
console.log("\nHeartbeat and duplicate calls\n" + "-".repeat(78));
const st = spawnSync(process.execPath, [CLI, "status"], { encoding: "utf8", env: ENV });
check("`cli.js status` shows each tool's last hook call", /Claude Code \(desktop\)\s+last call just now/.test(st.stdout) && /Cursor \(desktop\)/.test(st.stdout), st.stdout);
const before = logLines().length;
const same = { hook_event_name: "PreToolUse", cwd: APP, tool_name: "Bash", tool_input: { command: "cat .env" } };
const r1 = guard("claude-code", same, { SHADOW_DEDUP_MS: "5000" });
const r2 = guard("claude-code", same, { SHADOW_DEDUP_MS: "5000" });
check("same hook firing twice (project + global) → both deny, ONE event", r1.j.hookSpecificOutput.permissionDecision === "deny" &&
  r2.j.hookSpecificOutput.permissionDecision === "deny" && logLines().length === before + 1, logLines().length - before);

// ------------------------------------------------------------------ laptop-wide install + exempt
console.log("\nLaptop-wide install (fake home + fake global git config)\n" + "-".repeat(78));
r = spawnSync(process.execPath, [CLI, "install", "all", "--global"], { encoding: "utf8", env: ENV });
const J = (...p) => JSON.parse(fs.readFileSync(path.join(USER, ...p), "utf8"));
check("install all --global → exit 0", r.status === 0, r.stdout + r.stderr);
check("~/.claude/settings.json has the hooks", J(".claude", "settings.json").hooks.PreToolUse[0].hooks[0].command.endsWith('guard.js" claude-code'), "");
check("~/.cursor/hooks.json has the hooks", J(".cursor", "hooks.json").hooks.beforeSubmitPrompt[0].command.endsWith('guard.js cursor'), "");
check("~/.codeium/windsurf/hooks.json has the hooks", J(".codeium", "windsurf", "hooks.json").hooks.pre_run_command[0].command.endsWith('guard.js windsurf'), "");
check("~/.gemini/config/hooks.json has the hooks", J(".gemini", "config", "hooks.json")["shadow-ai-guard"].enabled === true, "");
const hp = spawnSync("git", ["config", "--global", "core.hooksPath"], { encoding: "utf8", env: ENV }).stdout.trim();
check("git: global core.hooksPath → ~/.shadow-ai/git-hooks", hp.replace(/\\/g, "/") === path.join(HOME, "git-hooks").replace(/\\/g, "/"), hp);
const ex = JSON.parse(fs.readFileSync(path.join(HOME, "exempt.json"), "utf8")).folders;
check("the guard's own repo is exempted automatically", ex.some((d) => path.resolve(d) === path.resolve(ROOT, "..")), JSON.stringify(ex));

// a real commit in a fresh repo goes through the GLOBAL hook
const REPO = path.join(TMP, "repo"); fs.mkdirSync(REPO);
const git = (a, cwd) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: cwd || REPO, encoding: "utf8", env: ENV });
git(["init", "-q"]);
fs.writeFileSync(path.join(REPO, "cfg.js"), `const k = "${LIVE_KEY}";\n`);
git(["add", "."]);
r = git(["commit", "-q", "-m", "x"]);
check("any repo on the laptop: commit with a live key → rejected", r.status !== 0, r.status + r.stdout + r.stderr);
fs.writeFileSync(path.join(REPO, "cfg.js"), "const k = process.env.K;\n");
fs.writeFileSync(path.join(REPO, "ok.txt"), "hello\n");
git(["add", "."]);
r = git(["commit", "-q", "-m", "y"]);
check("…clean commit → accepted", r.status === 0, r.stdout + r.stderr);

// exempt folder: decisions in it are always allow
const EXDIR = path.join(TMP, "exempt-proj"); fs.mkdirSync(EXDIR);
fs.writeFileSync(path.join(EXDIR, ".env"), `K=${LIVE_KEY}\n`);
spawnSync(process.execPath, [CLI, "exempt", EXDIR], { encoding: "utf8", env: ENV });
r = guard("claude-code", { hook_event_name: "PreToolUse", cwd: EXDIR, tool_name: "Bash", tool_input: { command: "cat .env" } });
check("exempt folder → guard stays out (cat .env allowed)", !r.out.trim(), r.out);
spawnSync(process.execPath, [CLI, "unexempt", EXDIR], { encoding: "utf8", env: ENV });
r = guard("claude-code", { hook_event_name: "PreToolUse", cwd: EXDIR, tool_name: "Bash", tool_input: { command: "cat .env" } });
check("unexempt → guarded again", r.j && r.j.hookSpecificOutput.permissionDecision === "deny", r.out);

r = spawnSync(process.execPath, [CLI, "uninstall", "all", "--global"], { encoding: "utf8", env: ENV });
const hp2 = spawnSync("git", ["config", "--global", "core.hooksPath"], { encoding: "utf8", env: ENV }).stdout.trim();
check("uninstall all --global → hooks + git hooksPath removed", r.status === 0 && !J(".claude", "settings.json").hooks.PreToolUse &&
  !J(".gemini", "config", "hooks.json")["shadow-ai-guard"] && !hp2, r.stdout + r.stderr + hp2);

// ------------------------------------------------------------------ cli scan
console.log("\nCodebase scan from the CLI\n" + "-".repeat(78));
r = spawnSync(process.execPath, [CLI, "scan", APP], { encoding: "utf8", env: ENV });
check("cli.js scan <folder> → finds key, password, .env; exit 1", r.status === 1 && /server-notes\.txt:2/.test(r.stdout) && /db-notes\.txt:1/.test(r.stdout) && /\.env/.test(r.stdout), r.status + r.stdout);

fs.rmSync(TMP, { recursive: true, force: true });
const passed = results.filter(Boolean).length;
console.log("=".repeat(78) + `\n${passed} / ${results.length} passed\n`);
process.exitCode = passed === results.length ? 0 : 1;
