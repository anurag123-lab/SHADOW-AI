/**
 * Google Antigravity adapter — hooks in <workspace>/.agents/hooks.json
 * (global: ~/.gemini/config/hooks.json)
 *
 * Per Antigravity's hooks docs, PreToolUse receives { toolCall: { name, args }, ... }
 * and returns { decision: "deny" | "allow" | "ask" | ..., reason }.
 * Antigravity exposes no hook for the typed prompt, so on Antigravity we
 * guard what the agent DOES (commands, file reads/writes, tools).
 *
 * The docs name tools (e.g. run_command, view_file) but not their argument
 * keys, so arguments are read defensively: known key names first, then
 * every string value. Set SHADOW_DEBUG_KEYS=1 to log the payload's key
 * NAMES (never values) and confirm them on a given Antigravity version.
 *
 * For a plain "allow" this adapter prints nothing, so Antigravity's own
 * permission settings decide as usual — the guard never auto-approves
 * anything. (If a version requires an explicit decision, set
 * SHADOW_ANTIGRAVITY_NEUTRAL=ask.)
 */
"use strict";

const CMD_KEYS = ["CommandLine", "commandLine", "command_line", "command", "Command", "cmd"];
const PATH_KEYS = ["AbsolutePath", "absolutePath", "absolute_path", "TargetFile", "targetFile", "target_file",
  "FilePath", "filePath", "file_path", "Path", "path", "SearchPath", "SearchDirectory", "DirectoryPath", "Uri", "uri"];

function argsOf(input) {
  const tc = input.toolCall || input.tool_call || {};
  let args = tc.args || tc.arguments || {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = { value: args }; } }
  return { name: tc.name || "", args };
}
function pick(args, keys) {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return null;
}
function allStrings(obj) {
  const out = [];
  (function walk(v) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(obj);
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Prompts + uploads. Antigravity has no prompt hook, but PreInvocation
 * fires BEFORE each model call with `transcriptPath`. The transcript's
 * USER_INPUT steps hold the typed request and `media: [{ mime_type, uri }]`
 * pointing at the uploaded file (…/.user_uploaded/media_….pdf).
 * PreInvocation can't cancel the call (not documented), so each new
 * USER_INPUT is scanned once: findings go to the dashboard and an
 * ephemeral instruction tells the agent to warn the user and not repeat
 * the values.
 * ------------------------------------------------------------------ */
const fs = require("fs");
const path = require("path");
const AUDIT_WINDOW_MS = Number(process.env.SHADOW_AUDIT_WINDOW_MIN || 30) * 60 * 1000;

function userInputs(transcriptPath) {
  let text;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 8 * 1024 * 1024);
    const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch (e) { return []; }
  const out = [];
  for (const l of text.split("\n")) {
    if (l.indexOf("USER_INPUT") === -1) continue;
    let o; try { o = JSON.parse(l); } catch (e) { continue; }
    if (o.type !== "USER_INPUT") continue;
    const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(String(o.content || ""));
    out.push({ step: o.step_index, ts: o.created_at ? Date.parse(o.created_at) : 0, request: m ? m[1].trim() : "",
      media: (o.media || []).map((x) => ({ mime: x.mime_type, file: String(x.uri || "").replace(/^file:\/+/, "").replace(/%3A/gi, ":").replace(/%20/g, " ") })) });
  }
  return out;
}

async function audit(input) {
  const tp = input.transcriptPath || input.transcript_path;
  if (!tp) return null;
  const core = require("../lib/core");
  const seenFile = path.join(core.HOME, "scanned-antigravity.json");
  const seen = new Set((core.readJson(seenFile) || {}).ids || []);
  const conv = input.conversationId || path.basename(path.dirname(path.dirname(path.dirname(tp))));
  const fresh = userInputs(tp).filter((u) => !seen.has(conv + ":" + u.step) && (!u.ts || Date.now() - u.ts < AUDIT_WINDOW_MS));
  if (!fresh.length) return null;
  const { loadDetector, report, sensitiveMatcher, MANDATORY_NO_PATTERN } = require("../lib/decide");
  const { extractText } = require("../lib/extract");
  const cwd = (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || process.cwd();
  const { D, policy } = await loadDetector(cwd);
  const isSensitive = sensitiveMatcher(policy.sensitivePaths);
  const notes = [];
  const label = (s) => [...new Set((s.matches || []).map((m) => m.label))].slice(0, 3).join(", ") || "a secrets file";
  for (const u of fresh) {
    if (u.request) {
      const s = D.scan(u.request);
      if (s.riskLevel !== "None") {
        report(s, { kind: "prompt", reason: "prompt_no_hook", action: "warned" }, "Antigravity (desktop)");
        notes.push(`the request (${label(s)})`);
      }
    }
    for (const m of u.media) {
      const name = path.basename(m.file);
      let data = null; try { data = fs.readFileSync(m.file); } catch (e) {}
      const r = data ? await extractText(data, { name, mediaType: m.mime }) : { supported: false };
      const s = isSensitive(name) ? MANDATORY_NO_PATTERN : r.supported && r.text ? D.scan(r.text) : null;
      if (!s || s.riskLevel === "None") continue;
      report(s, { kind: "upload", reason: "uploaded_file", action: "uploaded_anyway", fileName: name }, "Antigravity (desktop)");
      notes.push(`the uploaded file ${name} (${label(s)})`);
    }
  }
  try {
    fs.mkdirSync(core.HOME, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify({ ids: [...seen, ...fresh.map((u) => conv + ":" + u.step)].slice(-500) }));
  } catch (e) {}
  if (!notes.length) return null;
  return "Shadow AI Guard (company data policy): " + notes.join("; ") + " contains sensitive data. This has been reported to " +
    "the security team. Tell the user this first, do not repeat, quote or summarise the sensitive values (keys, passwords, " +
    "card numbers, personal or confidential details), and suggest using placeholders instead.";
}

module.exports = {
  aiTool: "Antigravity (desktop)",
  audit,

  /** Only PreInvocation can carry a message to the agent (injectSteps); tool decisions stay unchanged. */
  withNote(out, note, input) {
    const isPreInvocation = input && input.invocationNum !== undefined && !input.toolCall && !input.tool_call;
    if (!isPreInvocation) return out;
    return { stdout: JSON.stringify({ injectSteps: [{ ephemeralMessage: note }] }), exitCode: 0 };
  },

  parse(input) {
    const { name, args } = argsOf(input);
    if (!name) return null;
    const cwd = (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || process.cwd();
    if (/run_command|terminal|shell|exec/i.test(name)) {
      return { cwd, action: { kind: "shell", name, command: pick(args, CMD_KEYS) || allStrings(args) } };
    }
    if (/view_file|read|open_file|view_code|view_content/i.test(name)) {
      return { cwd, action: { kind: "read", name, path: pick(args, PATH_KEYS) || "" } };
    }
    if (/write|replace|edit|create_file|patch|apply/i.test(name)) {
      const p = pick(args, PATH_KEYS);
      const rest = { ...args }; PATH_KEYS.forEach((k) => delete rest[k]);
      return { cwd, action: { kind: "write", name, path: p, text: allStrings(rest) } };
    }
    if (/grep|search|find|list_dir|glob/i.test(name)) {
      return { cwd, action: { kind: "search", name, targets: [pick(args, PATH_KEYS), allStrings(args)] } };
    }
    return { cwd, action: { kind: "tool", name, text: allStrings(args) } };
  },

  format(d) {
    if (d.verdict === "block") return { stdout: JSON.stringify({ decision: "deny", reason: d.message }), exitCode: 0 };
    if (d.verdict === "ask") return { stdout: JSON.stringify({ decision: "ask", reason: d.message }), exitCode: 0 };
    const neutral = process.env.SHADOW_ANTIGRAVITY_NEUTRAL;
    if (neutral) return { stdout: JSON.stringify({ decision: neutral }), exitCode: 0 };
    return { exitCode: 0 };
  },
};
