#!/usr/bin/env node
/**
 * Shadow AI Guard — one entry point for every AI coding agent's hooks.
 *
 *   node agent-guard/guard.js claude-code   (Claude Code hooks)
 *   node agent-guard/guard.js cursor        (Cursor hooks)
 *   node agent-guard/guard.js windsurf      (Windsurf / Devin Desktop Cascade hooks)
 *   node agent-guard/guard.js antigravity   (Google Antigravity hooks)
 *
 * Install the matching hook config into a project with:
 *   node agent-guard/cli.js install <tool> <project folder>
 */
"use strict";

const ADAPTERS = {
  "claude-code": () => require("./adapters/claude-code"),
  cursor: () => require("./adapters/cursor"),
  windsurf: () => require("./adapters/windsurf"),
  antigravity: () => require("./adapters/antigravity"),
};

const name = (process.argv[2] || "claude-code").toLowerCase();
const adapter = (ADAPTERS[name] || ADAPTERS["claude-code"])();
require("./lib/run").run(adapter);

module.exports = { ADAPTERS };
