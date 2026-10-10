/**
 * Shared runner for every agent adapter:
 *   stdin JSON → adapter.parse() → decide() → adapter.format() → stdout / exit code
 *
 * An adapter is { aiTool, parse(input) → {action, cwd} | null, format(decision, ctx) → {stdout?, stderr?, exitCode} }.
 *
 * Off switch: SHADOW_GUARD_OFF=1 or `cli.js off`. Exempt folders: `cli.js exempt <folder>`.
 * Every call stamps ~/.shadow-ai/last-seen.json, so `cli.js status` shows the hooks are live.
 * Errors fail OPEN by default (a bug never locks a developer out); set
 * SHADOW_FAIL_CLOSED=1 to block instead — a per-company policy choice.
 * SHADOW_DEBUG_KEYS=1 logs the payload's field NAMES (never values) to
 * help map a new tool version.
 */
"use strict";
const core = require("./core");
const { decide } = require("./decide");

function keysOf(obj, prefix = "", out = []) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of Object.keys(obj)) { out.push(prefix + k); keysOf(obj[k], prefix + k + ".", out); }
  }
  return out;
}

async function handle(adapter, raw) {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch (e) { input = {}; }
  // Always answer in the tool's own format, even when switched off: Cursor
  // treats a missing answer on a permission hook as a block.
  if (core.isOff()) return adapter.format({ verdict: "allow", message: "" }, { input });
  const out = await decideOne(adapter, raw, input);
  // Adapters that can see what was already sent (Claude Code uploads) report it after the fact
  if (adapter.audit && !core.isExempt([input.cwd])) {
    let note = null;
    try { note = await adapter.audit(input); } catch (e) {}
    if (note && adapter.withNote) return adapter.withNote(out, note, input);   // tool-specific way to surface it
    if (note) {
      let obj = {};
      try { obj = out && out.stdout ? JSON.parse(out.stdout) : {}; } catch (e) { obj = {}; }
      obj.systemMessage = note;
      return { ...(out || {}), stdout: JSON.stringify(obj), exitCode: (out && out.exitCode) || 0 };
    }
  }
  return out;
}

async function decideOne(adapter, raw, input) {
  if (process.env.SHADOW_DEBUG_KEYS === "1") {
    core.appendLine(core.FILES.log, { ts: new Date().toISOString(), debug: adapter.aiTool, keys: keysOf(input) });
  }
  if (process.env.SHADOW_TEST_THROW === "1") throw new Error("test-only failure");   // exercises fail-open / fail-closed
  const parsed = await adapter.parse(input);
  core.touchSeen(adapter.aiTool, input.hook_event_name || input.agent_action_name || (input.toolCall && input.toolCall.name) || "call");
  if (!parsed || !parsed.action) return adapter.format({ verdict: "allow", message: "" }, { input });
  // Exempt folders (e.g. the guard's own repo, full of test secrets) — only matters for a laptop-wide install
  const a = parsed.action;
  if (core.isExempt([parsed.cwd, a.path, ...(a.files || [])])) return adapter.format({ verdict: "allow", message: "" }, { input, action: a });
  const d = await decide(parsed.action, { cwd: parsed.cwd, aiTool: adapter.aiTool, quiet: core.seenRecently(adapter.aiTool + "\n" + raw) });
  return adapter.format(d, { input, action: parsed.action });
}

/**
 * stdin bytes → text. Tools on Windows may send a UTF-8 byte-order mark or
 * UTF-16; either makes JSON.parse fail and the hook would silently allow.
 */
function decodeInput(buf) {
  if (!buf || !buf.length) return "";
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.slice(2).toString("utf16le");
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.slice(2)).swap16().toString("utf16le");
  else if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) text = buf.toString("utf16le");   // UTF-16LE without BOM
  else text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // UTF-8 byte-order mark
  const i = text.indexOf("{");
  return i > 0 ? text.slice(i) : text;
}

function run(adapter) {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  process.stdin.on("end", () => {
    const buf = Buffer.concat(chunks);
    const raw = decodeInput(buf);
    try { JSON.parse(raw); } catch (e) {   // diagnostic only: size + first bytes, never content
      try { core.appendLine(core.FILES.log, { ts: new Date().toISOString(), event: "input_unreadable", ai_tool: adapter.aiTool,
        bytes: buf.length, head_hex: buf.slice(0, 8).toString("hex"), argv: process.argv.slice(2),
        env_names: Object.keys(process.env).filter((k) => /cursor|hook|claude|devin|windsurf|antigravity/i.test(k)) }); } catch (x) {}
    }
    handle(adapter, raw).then((out) => {
      if (out && out.stdout) process.stdout.write(out.stdout);
      if (out && out.stderr) process.stderr.write(out.stderr);
      process.exit((out && out.exitCode) || 0);
    }).catch((e) => {
      try { core.appendLine(core.FILES.log, { ts: new Date().toISOString(), event: "error", ai_tool: adapter.aiTool, action: "hook_error", message: String(e && e.message).slice(0, 200) }); } catch (x) {}
      if (process.env.SHADOW_FAIL_CLOSED === "1") {
        let input = {};
        try { input = JSON.parse(raw || "{}"); } catch (x) {}
        const out = adapter.format({ verdict: "block", message: "Shadow AI Guard: the safety check failed, so this was blocked (fail-closed policy)." }, { input });
        if (out.stdout) process.stdout.write(out.stdout);
        if (out.stderr) process.stderr.write(out.stderr);
        return process.exit(out.exitCode || 0);
      }
      process.exit(0);
    });
  });
}

module.exports = { run, handle, decodeInput };
