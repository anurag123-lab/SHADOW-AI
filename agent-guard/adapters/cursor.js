/**
 * Cursor adapter — hooks in <project>/.cursor/hooks.json
 * (enterprise: C:\ProgramData\Cursor\hooks.json, which users can't override)
 *
 * Per Cursor's hooks spec:
 *   beforeSubmitPrompt   { prompt, attachments[] }  → { continue, user_message }   (attached files are scanned too)
 *   beforeReadFile       { file_path, content }     → { permission: allow|deny, user_message }
 *   beforeShellExecution { command, cwd }           → { permission: allow|deny|ask, user_message, agent_message }
 *   beforeMCPExecution   { tool_name, tool_input }  → { permission: allow|deny|ask, ... }
 *   preToolUse           { tool_name, tool_input }  → { permission: allow|deny, ... }   (used here for file WRITES only;
 *                                                     reads and shell have their own hooks above)
 * Cursor doesn't enforce "ask" for file reads or preToolUse, so a Warn
 * finding there is allowed and shown to the developer as a message.
 */
"use strict";

/** Cursor on Windows sends workspace roots as "/C:/Users/..." — strip the leading slash. */
function winPath(p) {
  return typeof p === "string" ? p.replace(/^\/([A-Za-z]:[\\/])/, "$1") : p;
}
function cwdOf(input) {
  return winPath(input.cwd || (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || process.cwd());
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

module.exports = {
  aiTool: "Cursor (desktop)",

  parse(input) {
    const cwd = cwdOf(input);
    switch (input.hook_event_name) {
      case "beforeSubmitPrompt": return { cwd, action: { kind: "prompt", text: input.prompt,
        files: (Array.isArray(input.attachments) ? input.attachments : []).filter((x) => x && x.type !== "rule" && x.file_path).map((x) => winPath(x.file_path)) } };
      case "beforeReadFile":
      case "beforeTabFileRead": return { cwd, action: { kind: "read", name: input.hook_event_name, path: winPath(input.file_path), content: input.content } };
      case "beforeShellExecution": return { cwd: input.cwd || cwd, action: { kind: "shell", name: "shell", command: input.command } };
      case "beforeMCPExecution": return { cwd, action: { kind: "tool", name: input.tool_name, text: JSON.stringify(input.tool_input || {}) } };
      case "preToolUse": {
        if (!/write|edit|replace|create|apply|patch/i.test(input.tool_name || "")) return null;   // reads/shell handled above
        const ti = input.tool_input || {};
        return { cwd, action: { kind: "write", name: input.tool_name, path: winPath(ti.file_path || ti.path || ti.target_file), text: allStrings(ti) } };
      }
      default: return null;
    }
  },

  format(d, ctx) {
    const ev = ctx.input && ctx.input.hook_event_name;
    const msg = d.message || undefined;
    if (ev === "beforeSubmitPrompt") {
      return { stdout: JSON.stringify(d.verdict === "block" ? { continue: false, user_message: msg } : { continue: true }), exitCode: 0 };
    }
    // Cursor can't ask on reads / preToolUse: a Warn finding is allowed, so say so instead of asking
    const told = d.verdict === "ask" && msg ? msg.replace(/Allow it to be sent to the model\?$/, "Allowed — your organisation logs this.") : msg;
    if (ev === "beforeReadFile" || ev === "beforeTabFileRead") {
      return { stdout: JSON.stringify({ permission: d.verdict === "block" ? "deny" : "allow", user_message: told }), exitCode: 0 };
    }
    if (ev === "beforeShellExecution" || ev === "beforeMCPExecution") {
      const permission = d.verdict === "block" ? "deny" : d.verdict === "ask" ? "ask" : "allow";
      return { stdout: JSON.stringify({ permission, user_message: msg, agent_message: msg }), exitCode: 0 };
    }
    if (ev === "preToolUse") {
      return { stdout: JSON.stringify({ permission: d.verdict === "block" ? "deny" : "allow", user_message: told, agent_message: told }), exitCode: 0 };
    }
    return { exitCode: 0 };
  },
};
