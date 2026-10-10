#!/usr/bin/env node
/**
 * Shadow AI Guard — repository scanner (pre-commit + CI)
 * =====================================================
 * Code written by ANY AI tool (Cursor, Antigravity, Copilot, Claude Code)
 * or by hand ends up in git, so this is the layer that covers every tool.
 *
 *   node agent-guard/git/scan.js --staged        pre-commit: the staged version of each changed file
 *   node agent-guard/git/scan.js --diff <base>   CI: files changed since <base> (e.g. origin/main)
 *   node agent-guard/git/scan.js --all           every tracked file
 *   node agent-guard/git/scan.js <file|dir>...   specific paths, no git needed
 *
 * Same detection engine, policies, keywords and honeytokens as the browser
 * extension. Mandatory findings and committed secrets files (.env, keys)
 * fail with exit code 1; Warn findings are printed and pass (add --strict
 * to fail on them too). Output shows file:line and the category — never
 * the secret itself.
 *
 * False positives / test fixtures: list paths in .shadow-ai-ignore at the
 * repo root (one glob per line, e.g. tests/fixtures/**).
 *
 * On a developer laptop signed in with `cli.js login`, each flagged file is
 * reported to the dashboard as "git pre-commit" or "codebase scan"
 * (metadata only). `git commit --no-verify` skips the local hook, which is
 * why the same scan runs in CI, where it can't be skipped.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadDetector, report, sendInBackground, sensitiveMatcher, MANDATORY_NO_PATTERN } = require("../lib/decide");
const core = require("../lib/core");

const MAX_BYTES = 2 * 1024 * 1024;
// .shadow-ai-policy.json lists honeytokens / keywords on purpose
const ALWAYS_SKIP = [/(^|\/)\.shadow-ai-policy\.json$/, /(^|\/)node_modules\//, /(^|\/)\.git\//, /\.min\.(js|mjs|css)$/, /\.(png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|mp4|docx|xlsx)$/i];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}
function repoRoot(cwd) {
  try { return git(["rev-parse", "--show-toplevel"], cwd).toString().trim(); } catch (e) { return null; }
}

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
function loadIgnore(root) {
  try {
    return fs.readFileSync(path.join(root, ".shadow-ai-ignore"), "utf8").split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(globToRegex);
  } catch (e) { return []; }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// ---------------------------------------------------------------- collect files
function collect(args, cwd) {
  const root = repoRoot(cwd) || cwd;
  const files = [];   // { rel, read: () => Buffer|null }
  const fromDisk = (rel) => () => { try { const f = path.join(root, rel); return fs.statSync(f).size > MAX_BYTES ? null : fs.readFileSync(f); } catch (e) { return null; } };

  if (args.includes("--staged")) {
    const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], root).toString().split("\0").filter(Boolean);
    for (const rel of names) files.push({ rel, read: () => { try { return git(["show", ":" + rel], root); } catch (e) { return null; } } });
    return { root, files, mode: "staged" };
  }
  const di = args.indexOf("--diff");
  if (di !== -1) {
    const base = args[di + 1] || "origin/main";
    const names = git(["diff", "--name-only", "--diff-filter=ACMR", "-z", base + "...HEAD"], root).toString().split("\0").filter(Boolean);
    names.forEach((rel) => files.push({ rel, read: fromDisk(rel) }));
    return { root, files, mode: "diff" };
  }
  if (args.includes("--all")) {
    git(["ls-files", "-z"], root).toString().split("\0").filter(Boolean).forEach((rel) => files.push({ rel, read: fromDisk(rel) }));
    return { root, files, mode: "all" };
  }
  // explicit paths
  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "venv", ".venv", "__pycache__", ".cache", "coverage", "target"]);
  const walk = (abs) => {
    let st; try { st = fs.lstatSync(abs); } catch (e) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(abs))) return;
      try { fs.readdirSync(abs).forEach((n) => walk(path.join(abs, n))); } catch (e) {}
      return;
    }
    if (files.length >= 20000) return;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    files.push({ rel, read: fromDisk(rel) });
  };
  args.filter((a) => !a.startsWith("--")).forEach((a) => walk(path.resolve(cwd, a)));
  return { root, files, mode: "paths" };
}

// ---------------------------------------------------------------- main
async function main(argv, cwd) {
  const strict = argv.includes("--strict");
  const { root, files, mode } = collect(argv, cwd);
  if (mode === "staged" && core.isExempt([root])) return 0;   // e.g. the guard's own repo (laptop-wide hook)
  const ignore = loadIgnore(root);
  const { D, policy } = await loadDetector(root);
  const isSensitive = sensitiveMatcher(policy.sensitivePaths);

  const blocked = [], warned = [];
  const flagged = [];   // per file, for the dashboard: { rel, scan }

  for (const f of files) {
    if (ALWAYS_SKIP.some((re) => re.test(f.rel)) || ignore.some((re) => re.test(f.rel))) continue;
    if (isSensitive(f.rel)) {
      blocked.push({ file: f.rel, line: 1, label: "secrets file committed (" + path.basename(f.rel) + ")" });
      flagged.push({ rel: f.rel, scan: MANDATORY_NO_PATTERN });
      continue;
    }
    const buf = f.read();
    if (!buf || buf.includes(0)) continue;   // unreadable or binary
    const text = buf.toString("utf8");
    const scan = D.scan(text);
    if (scan.riskLevel === "None") continue;
    flagged.push({ rel: f.rel, scan });
    for (const m of scan.matches) {
      const entry = { file: f.rel, line: lineOf(text, m.start), label: m.label };
      (D.tierFor(m) === "MandatoryRedaction" ? blocked : warned).push(entry);
    }
  }

  const fail = blocked.length > 0 || (strict && warned.length > 0);
  const print = (list, icon) => list.slice(0, 40).forEach((e) => console.log(`  ${icon} ${e.file}:${e.line}  ${e.label}`));
  if (blocked.length || warned.length) {
    console.log("\nShadow AI Guard — sensitive data found" + (mode === "staged" ? " in this commit" : "") + ":\n");
    print(blocked, "✖");
    print(warned, "!");
    if (blocked.length + warned.length > 80) console.log("  … and more");
    console.log("");
    if (fail) {
      console.log("  ✖ = blocked. Move secrets to environment variables or a vault, and keep");
      console.log("    real customer data out of the repo. If a finding is a test fixture,");
      console.log("    add its path to .shadow-ai-ignore.\n");
    } else {
      console.log("  ! = warning only; allowed. Your organisation logs that this was committed.\n");
    }
  } else if (mode !== "staged") {
    console.log(`Shadow AI Guard — ${files.length} file(s) scanned, nothing sensitive found.`);
  }

  // dashboard (developer laptop signed in with `cli.js login`; CI has no session,
  // so nothing is sent from there) — one event per flagged file, metadata only
  const aiTool = mode === "staged" ? "git pre-commit" : "codebase scan";
  for (const { rel, scan } of flagged.slice(0, 50)) {
    const mandatory = scan.overallTier === "MandatoryRedaction";
    const action = mode === "staged" ? (fail ? "blocked" : "warned") : (mandatory ? "blocked" : "warned");
    report(scan, { kind: mode === "staged" ? "commit" : "scan", channel: "git", action, fileName: path.basename(rel) }, aiTool, { deferSend: true });
  }
  if (flagged.length) sendInBackground();
  return fail ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2), process.cwd())
    .then((code) => process.exit(code))
    .catch((e) => { console.error("Shadow AI Guard scan failed: " + e.message); process.exit(process.env.SHADOW_FAIL_CLOSED === "1" ? 1 : 0); });
}

module.exports = { main, globToRegex };
