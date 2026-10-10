/**
 * Writes (or removes) the hook config for one AI tool — or git — either into
 * ONE project folder, or for every project on this laptop (dir = "--global"):
 *
 *   tool          project file                    --global
 *   claude-code   .claude/settings.json           ~/.claude/settings.json
 *   cursor        .cursor/hooks.json              ~/.cursor/hooks.json
 *   windsurf      .devin/ + .windsurf/hooks.json  ~/.codeium/windsurf/hooks.json
 *   antigravity   .agents/hooks.json              ~/.gemini/config/hooks.json
 *   git           .git/hooks/pre-commit           git config --global core.hooksPath ~/.shadow-ai/git-hooks
 *
 * A global install exempts the guard's own repository (full of test
 * secrets) via ~/.shadow-ai/exempt.json; add more with `cli.js exempt`.
 * Company-wide rollout uses each tool's enterprise / system file (README).
 *
 *   install(tool, dir)    tool = claude-code | cursor | windsurf | antigravity | git | all
 *   uninstall(tool, dir)
 *
 * Existing config files are merged, not overwritten: only entries whose
 * command contains "agent-guard" are added / removed.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const core = require("./core");

const GUARD_DIR = path.resolve(__dirname, "..");
const SOURCE_REPO = path.resolve(GUARD_DIR, "..");
const fwd = (p) => p.split(path.sep).join("/");
const cmd = (tool) => `node "${fwd(path.join(GUARD_DIR, "guard.js"))}" ${tool}`;
// Antigravity (2.4 on Windows) splits the command on spaces WITHOUT a shell, so quotes reach
// node literally ('Cannot find module .agents\"C:\...guard.js"'). Write the path unquoted.
function cmdAntigravity() {
  const p = fwd(path.join(GUARD_DIR, "guard.js"));
  if (/\s/.test(p)) throw new Error("Antigravity can't run a hook path containing spaces (" + p + "). Move agent-guard to a path without spaces.");
  return `node ${p} antigravity`;
}
// Cursor / Windsurf: unverified whether they use a shell on Windows — an unquoted path works
// either way, so use it whenever the path has no spaces (quoted otherwise).
const cmdPlain = (tool) => { const p = fwd(path.join(GUARD_DIR, "guard.js")); return /\s/.test(p) ? cmd(tool) : `node ${p} ${tool}`; };
const ours = (h) => JSON.stringify(h).includes("agent-guard");
const TOOLS = ["claude-code", "cursor", "windsurf", "antigravity", "git"];
const USER_HOME = () => process.env.SHADOW_USER_HOME || os.homedir();
const GLOBAL_FILES = {
  "claude-code": () => [path.join(USER_HOME(), ".claude", "settings.json")],
  cursor: () => [path.join(USER_HOME(), ".cursor", "hooks.json")],
  windsurf: () => [path.join(USER_HOME(), ".codeium", "windsurf", "hooks.json")],
  antigravity: () => [path.join(USER_HOME(), ".gemini", "config", "hooks.json")],
  git: () => [path.join(core.HOME, "git-hooks", "pre-commit")],
};

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } }
function writeJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n"); }

/** The guard's own repo is full of test secrets; guarding it would block work on the guard itself. */
function checkTarget(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error("Not a folder: " + abs);
  const rel = path.relative(SOURCE_REPO, abs);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error("Refusing to install inside the Shadow AI Guard source repo (" + SOURCE_REPO + "). Use a separate project folder.");
  }
  return abs;
}

// ---------------------------------------------------------------- per tool
const CLAUDE_MATCHER = "Read|NotebookRead|Grep|Glob|Bash|PowerShell|Write|Edit|MultiEdit|WebFetch|mcp__.*";
const CURSOR_EVENTS = ["beforeSubmitPrompt", "beforeReadFile", "beforeShellExecution", "beforeMCPExecution", "preToolUse"];
const WINDSURF_EVENTS = ["pre_user_prompt", "pre_read_code", "pre_write_code", "pre_run_command", "pre_mcp_tool_use"];

const HANDLERS = {
  "claude-code": {
    files: (d) => [path.join(d, ".claude", "settings.json")],
    add(f) {
      const s = readJson(f, {});
      s.hooks = s.hooks || {};
      const h = [{ type: "command", command: cmd("claude-code"), timeout: 15 }];
      s.hooks.UserPromptSubmit = (s.hooks.UserPromptSubmit || []).filter((e) => !ours(e)).concat([{ hooks: h }]);
      s.hooks.PreToolUse = (s.hooks.PreToolUse || []).filter((e) => !ours(e)).concat([{ matcher: CLAUDE_MATCHER, hooks: h }]);
      // end of each turn: report files uploaded into the chat that reached the model (see adapters/claude-code.js)
      s.hooks.Stop = (s.hooks.Stop || []).filter((e) => !ours(e)).concat([{ hooks: h }]);
      writeJson(f, s);
    },
    remove(f) {
      const s = readJson(f, null); if (!s || !s.hooks) return;
      for (const k of Object.keys(s.hooks)) { s.hooks[k] = s.hooks[k].filter((e) => !ours(e)); if (!s.hooks[k].length) delete s.hooks[k]; }
      writeJson(f, s);
    },
  },
  cursor: {
    files: (d) => [path.join(d, ".cursor", "hooks.json")],
    add(f) {
      const s = readJson(f, { version: 1, hooks: {} });
      s.version = s.version || 1; s.hooks = s.hooks || {};
      for (const ev of CURSOR_EVENTS) s.hooks[ev] = (s.hooks[ev] || []).filter((e) => !ours(e)).concat([{ command: cmdPlain("cursor"), timeout: 15 }]);
      writeJson(f, s);
    },
    remove(f) {
      const s = readJson(f, null); if (!s || !s.hooks) return;
      for (const k of Object.keys(s.hooks)) { s.hooks[k] = s.hooks[k].filter((e) => !ours(e)); if (!s.hooks[k].length) delete s.hooks[k]; }
      writeJson(f, s);
    },
  },
  windsurf: {
    // Devin Desktop reads .devin/; older Windsurf builds read .windsurf/
    files: (d) => [path.join(d, ".devin", "hooks.json"), path.join(d, ".windsurf", "hooks.json")],
    add(f) {
      const s = readJson(f, { hooks: {} });
      s.hooks = s.hooks || {};
      const entry = { command: cmdPlain("windsurf"), powershell: cmdPlain("windsurf"), show_output: true };
      for (const ev of WINDSURF_EVENTS) s.hooks[ev] = (s.hooks[ev] || []).filter((e) => !ours(e)).concat([entry]);
      writeJson(f, s);
    },
    remove(f) { HANDLERS.cursor.remove(f); },
  },
  antigravity: {
    files: (d) => [path.join(d, ".agents", "hooks.json")],
    add(f) {
      const s = readJson(f, {});
      s["shadow-ai-guard"] = { enabled: true, PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmdAntigravity(), timeout: 15 }] }],
        // before each model call: scan the typed request + uploads (no prompt hook exists)
        PreInvocation: [{ type: "command", command: cmdAntigravity(), timeout: 15 }] };
      writeJson(f, s);
    },
    remove(f) { const s = readJson(f, null); if (!s) return; delete s["shadow-ai-guard"]; writeJson(f, s); },
  },
  git: {
    files(d) {
      let gitDir;
      try { gitDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch (e) { throw new Error("Not a git repository: " + d); }
      return [path.join(path.resolve(d, gitDir), "pre-commit")];
    },
    add(f) {
      if (fs.existsSync(f) && !fs.readFileSync(f, "utf8").includes("agent-guard")) {
        throw new Error("A different pre-commit hook already exists at " + f + ". Add this line to it instead:\n  node \"" + fwd(path.join(GUARD_DIR, "git", "scan.js")) + "\" --staged || exit 1");
      }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const global = f === GLOBAL_FILES.git()[0];
      fs.writeFileSync(f, "#!/bin/sh\n# Shadow AI Guard (agent-guard) — blocks commits containing secrets / regulated data.\n" +
        "# Skip once with: git commit --no-verify   (CI runs the same scan and cannot be skipped)\n" +
        `node "${fwd(path.join(GUARD_DIR, "git", "scan.js"))}" --staged || exit 1\n` +
        (global ? "# a global hooksPath replaces each repo's own hooks, so run the repo's pre-commit too\n" +
          "repo_hook=\"$(git rev-parse --git-dir)/hooks/pre-commit\"\n" +
          "if [ -x \"$repo_hook\" ]; then exec \"$repo_hook\" \"$@\"; fi\n" : ""));
      try { fs.chmodSync(f, 0o755); } catch (e) {}
      if (global) {
        const cur = gitGlobalHooksPath();
        if (cur && path.resolve(cur) !== path.dirname(f)) throw new Error("git core.hooksPath is already set to " + cur + " — not overriding it.");
        execFileSync("git", ["config", "--global", "core.hooksPath", fwd(path.dirname(f))]);
      }
    },
    remove(f) {
      if (fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("agent-guard")) fs.unlinkSync(f);
      if (f === GLOBAL_FILES.git()[0]) {
        const cur = gitGlobalHooksPath();
        if (cur && path.resolve(cur) === path.dirname(f)) execFileSync("git", ["config", "--global", "--unset", "core.hooksPath"]);
      }
    },
  },
};

function gitGlobalHooksPath() {
  try { return execFileSync("git", ["config", "--global", "core.hooksPath"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (e) { return ""; }
}

function each(tool, dir, fn) {
  const global = dir === "--global";
  const abs = global ? null : checkTarget(dir);
  const list = tool === "all" ? TOOLS.filter((t) => global || t !== "git") : [tool];
  const done = [];
  if (global && fn === "add") core.setExempt(SOURCE_REPO, true);
  for (const t of list) {
    const h = HANDLERS[t];
    if (!h) throw new Error("Unknown tool '" + t + "'. Use one of: " + TOOLS.join(", ") + ", all");
    const files = global ? GLOBAL_FILES[t]() : h.files(abs);
    for (const f of files) { h[fn](f); done.push(global ? f : path.relative(abs, f) || f); }
  }
  return done;
}

module.exports = {
  install: (tool, dir) => each(tool, dir, "add"),
  uninstall: (tool, dir) => each(tool, dir, "remove"),
  checkTarget, TOOLS, GLOBAL_FILES, SOURCE_REPO,
};
