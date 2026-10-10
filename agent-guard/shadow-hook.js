#!/usr/bin/env node
/**
 * Shadow AI Guard — Claude Code hook (kept for existing settings files).
 * Same as `node agent-guard/guard.js claude-code`.
 */
"use strict";
require("./lib/run").run(require("./adapters/claude-code"));
