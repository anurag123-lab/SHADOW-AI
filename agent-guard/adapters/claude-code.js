/**
 * Claude Code adapter — hooks in <project>/.claude/settings.json
 *   UserPromptSubmit: input.prompt (+ uploads, if already in the transcript) → { decision: "block", reason }
 *   PreToolUse: input.tool_name + tool_input    → { hookSpecificOutput: { permissionDecision: deny|ask, ... } }
 *   Stop (end of turn): nothing to decide — only the upload audit below runs.
 *
 * Files UPLOADED into the chat (paperclip / drag-and-drop in VS Code) are
 * sent inside the message, not through a tool, and Claude Code usually
 * writes that message to the transcript only after UserPromptSubmit. So:
 *   1. before sending  — scanned if the message is already there (then blocked / held like any attachment);
 *   2. right after     — audit(): on every later hook call of the session, uploads not yet checked are
 *                        scanned; sensitive ones are reported to the dashboard as "uploaded_anyway" and
 *                        the developer sees a warning (systemMessage). Each upload is checked once.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const core = require("../lib/core");
const { currentMessage, recentUploads } = require("../lib/transcript");
const { extractText } = require("../lib/extract");

const AI_TOOL = "Claude Code (desktop)";
const AUDIT_WINDOW_MS = 30 * 60 * 1000;   // only uploads from the last 30 minutes (not a whole old history)
const SCANNED = () => path.join(core.HOME, "scanned-uploads.json");

function scannedIds() { return new Set((core.readJson(SCANNED()) || {}).ids || []); }
function markScanned(ids) {
  if (!ids.length) return;
  try {
    const all = [...scannedIds(), ...ids].slice(-500);
    fs.mkdirSync(core.HOME, { recursive: true });
    fs.writeFileSync(SCANNED(), JSON.stringify({ ids: all }));
  } catch (e) {}
}

async function toText(docs) {
  const out = [];
  for (const d of docs) {
    const r = await extractText(d.data, { name: d.name, mediaType: d.mediaType });
    out.push({ name: d.name, text: r.supported ? r.text : "" });
  }
  return out;
}

/** Before sending: this prompt's uploads + IDE selection, if the message is already in the transcript. */
async function uploads(input) {
  const t0 = Date.now();
  const msg = await currentMessage(input.transcript_path, input.prompt, input.prompt_id || input.promptId);
  try {   // diagnostic, metadata only
    core.appendLine(core.FILES.log, { ts: new Date().toISOString(), event: "upload_check", ai_tool: AI_TOOL,
      has_transcript: !!input.transcript_path, found: !!msg, uploads: msg ? msg.docs.length : 0, waited_ms: Date.now() - t0 });
  } catch (e) {}
  if (!msg) return { docs: [], extraText: "" };
  if (msg.uuid) markScanned([msg.uuid]);   // decided here; the audit must not report it again
  return { docs: await toText(msg.docs), extraText: msg.extraText };
}

/**
 * After sending: report uploads that already reached the model.
 * → a warning for the developer, or null.
 */
async function audit(input) {
  if (!input.transcript_path) return null;
  const done = scannedIds();
  const fresh = recentUploads(input.transcript_path).filter((u) => !done.has(u.uuid) && (!u.ts || Date.now() - u.ts < AUDIT_WINDOW_MS));
  if (!fresh.length) return null;
  const { loadDetector, report, sensitiveMatcher, MANDATORY_NO_PATTERN } = require("../lib/decide");
  const { D, policy } = await loadDetector(input.cwd);
  const isSensitive = sensitiveMatcher(policy.sensitivePaths);
  const notes = [];
  for (const u of fresh) {
    for (const doc of await toText(u.docs)) {
      const scan = isSensitive(doc.name) ? (doc.text && D.scan(doc.text).riskLevel !== "None" ? D.scan(doc.text) : MANDATORY_NO_PATTERN)
        : doc.text ? D.scan(doc.text) : null;
      if (!scan || scan.riskLevel === "None") continue;
      report(scan, { kind: "upload", reason: "uploaded_file", action: "uploaded_anyway", fileName: doc.name }, AI_TOOL);
      const labels = [...new Set((scan.matches || []).map((m) => m.label))].slice(0, 3).join(", ") || "a secrets file";
      notes.push(`"${doc.name}" (${labels})`);
    }
  }
  markScanned(fresh.map((u) => u.uuid));
  if (!notes.length) return null;
  return `Shadow AI Guard: you uploaded ${notes.join("; ")} to the AI. Uploads in the chat reach the model before any check can stop them, ` +
    "so this has been reported to your security team. Use placeholders, or let the agent read the file (that is checked first).";
}

module.exports = {
  aiTool: AI_TOOL,
  audit,

  async parse(input) {
    const cwd = input.cwd;
    if (input.hook_event_name === "UserPromptSubmit") {
      const up = await uploads(input);
      return { cwd, action: { kind: "prompt", text: [input.prompt, up.extraText].filter(Boolean).join("\n"), docs: up.docs } };
    }
    if (input.hook_event_name !== "PreToolUse") return null;
    const t = input.tool_name || "", ti = input.tool_input || {};
    if (/^(Read|NotebookRead)$/.test(t)) return { cwd, action: { kind: "read", name: t, path: ti.file_path || ti.notebook_path } };
    if (/^(Grep|Glob)$/.test(t)) return { cwd, action: { kind: "search", name: t, targets: [ti.path, ti.glob, ti.pattern] } };
    if (/^(Bash|PowerShell)$/.test(t)) return { cwd, action: { kind: "shell", name: t, command: ti.command } };
    if (/^(Write|Edit|MultiEdit)$/.test(t)) {
      const text = ti.content || ti.new_string || (Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string || "").join("\n") : "");
      return { cwd, action: { kind: "write", name: t, path: ti.file_path, text } };
    }
    return { cwd, action: { kind: "tool", name: t, text: JSON.stringify(ti) } };
  },

  format(d, ctx) {
    if (d.verdict === "allow") return { exitCode: 0 };
    const isPrompt = ctx.action ? ctx.action.kind === "prompt" : (ctx.input && ctx.input.hook_event_name === "UserPromptSubmit");
    if (isPrompt) return { stdout: JSON.stringify({ decision: "block", reason: d.message }), exitCode: 0 };
    return {
      stdout: JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: d.verdict === "block" ? "deny" : "ask",
        permissionDecisionReason: d.message,
      } }),
      exitCode: 0,
    };
  },
};
