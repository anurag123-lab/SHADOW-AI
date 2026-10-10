/**
 * Windsurf / Devin Desktop adapter — Cascade hooks in <workspace>/.devin/hooks.json
 * (legacy <workspace>/.windsurf/hooks.json; system: C:\ProgramData\Devin\hooks.json)
 *
 * Per the Cascade hooks spec, stdin is { agent_action_name, tool_info, ... }:
 *   pre_user_prompt   tool_info.user_prompt
 *   pre_read_code     tool_info.file_path (may be a directory)
 *   pre_write_code    tool_info.file_path, tool_info.edits[{old_string,new_string}]
 *   pre_run_command   tool_info.command_line, tool_info.cwd
 *   pre_mcp_tool_use  tool_info.mcp_tool_name, tool_info.mcp_tool_arguments
 * Exit code 2 blocks; the stderr message is shown to the agent.
 * There is no "ask": a Warn finding is allowed, with the warning printed
 * (visible when the hook has show_output: true).
 */
"use strict";

module.exports = {
  aiTool: "Windsurf (desktop)",

  parse(input) {
    const ti = input.tool_info || {};
    const cwd = ti.cwd || process.cwd();
    switch (input.agent_action_name) {
      case "pre_user_prompt": return { cwd, action: { kind: "prompt", text: ti.user_prompt } };
      case "pre_read_code": return { cwd, action: { kind: "read", name: "read_code", path: ti.file_path } };
      case "pre_write_code": return { cwd, action: { kind: "write", name: "write_code", path: ti.file_path,
        text: (ti.edits || []).map((e) => e.new_string || "").join("\n") } };
      case "pre_run_command": return { cwd, action: { kind: "shell", name: "run_command", command: ti.command_line } };
      case "pre_mcp_tool_use": return { cwd, action: { kind: "tool", name: ti.mcp_tool_name,
        text: typeof ti.mcp_tool_arguments === "string" ? ti.mcp_tool_arguments : JSON.stringify(ti.mcp_tool_arguments || {}) } };
      default: return null;
    }
  },

  format(d) {
    if (d.verdict === "block") return { stderr: d.message + "\n", exitCode: 2 };
    if (d.verdict === "ask") return { stdout: d.message + " (allowed — your organisation logs this)\n", exitCode: 0 };
    return { exitCode: 0 };
  },
};
