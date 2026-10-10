#!/usr/bin/env node
/**
 * Shadow AI Guard — agent guard CLI
 *
 *   node agent-guard/cli.js login     sign in as an employee + join code (once per laptop)
 *   node agent-guard/cli.js status    who is signed in, guard on/off, queued events
 *   node agent-guard/cli.js flush     send queued events to the dashboard now
 *   node agent-guard/cli.js off|on    turn the guard off / back on for this laptop
 *   node agent-guard/cli.js logout    remove the session
 *   node agent-guard/cli.js install <tool> <folder>     add the guard's hooks to ONE project
 *   node agent-guard/cli.js install <tool> --global     …or to every project on this laptop
 *   node agent-guard/cli.js uninstall <tool> <folder|--global>   remove them again
 *        tool = claude-code | cursor | windsurf | antigravity | git | all
 *   node agent-guard/cli.js exempt|unexempt <folder>    keep the guard out of a folder (laptop-wide install)
 *   node agent-guard/cli.js scan <folder>               scan a codebase; findings go to the dashboard
 */
"use strict";
const fs = require("fs");
const readline = require("readline");
const core = require("./lib/core");

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function (s) { if (s.includes(q)) rl.output.write(s); else rl.output.write("*"); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a.trim()); });
  });
}

const DEPARTMENTS = ["Engineering", "Sales", "Marketing", "Finance", "HR", "Legal", "Support", "Other", "Unspecified"];

(async () => {
  const cmd = process.argv[2] || "status";
  try {
    if (cmd === "login") {
      const email = process.env.SHADOW_EMAIL || await ask("Work email: ");
      const password = process.env.SHADOW_PASSWORD || await ask("Password: ", true);
      const code = process.env.SHADOW_JOIN_CODE || await ask("Join code: ");
      let dept = process.env.SHADOW_DEPARTMENT || await ask("Department (" + DEPARTMENTS.join("/") + ") [Engineering]: ");
      if (!DEPARTMENTS.includes(dept)) dept = "Engineering";
      const id = await core.login(email, password, code, dept);
      console.log(`\nSigned in. Desktop AI events will appear in "${id.company_name}" as ${id.employee_hash} (${id.department}).`);
    } else if (cmd === "status") {
      const s = core.readJson(core.FILES.session);
      let queued = 0;
      try { queued = fs.readFileSync(core.FILES.queue, "utf8").split("\n").filter(Boolean).length; } catch (e) {}
      console.log("Guard:     " + (core.isOff() ? "OFF" : "ON"));
      console.log("Signed in: " + (s ? `${s.email} → ${s.company_name} (${s.employee_hash}, ${s.department})` : "no — decisions are logged locally only"));
      console.log("Queued:    " + queued + " event(s) waiting to be sent");
      const seen = core.readJson(core.FILES.seen) || {};
      const ago = (ts) => { const m = Math.round((Date.now() - Date.parse(ts)) / 60000); return m < 1 ? "just now" : m < 120 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
      console.log("Hooks:     " + (Object.keys(seen).length ? "" : "no AI tool has called the guard yet (hooks not loaded? restart the tool)"));
      for (const [tool, v] of Object.entries(seen)) console.log(`           ${tool.padEnd(24)} last call ${ago(v.ts)} (${v.event})`);
      const ex = core.exemptFolders();
      if (ex.length) console.log("Exempt:    " + ex.join("\n           "));
      console.log("Data dir:  " + core.HOME);
    } else if (cmd === "flush") {
      const r = await core.flush();
      console.log(`Sent ${r.sent}, still queued ${r.left}${r.error ? " (" + r.error + ")" : ""}`);
    } else if (cmd === "off") {
      fs.mkdirSync(core.HOME, { recursive: true }); fs.writeFileSync(core.FILES.off, "");
      console.log("Guard OFF for this laptop. Run `cli.js on` to re-enable.");
    } else if (cmd === "on") {
      try { fs.unlinkSync(core.FILES.off); } catch (e) {}
      console.log("Guard ON.");
    } else if (cmd === "install" || cmd === "uninstall") {
      const tool = (process.argv[3] || "").toLowerCase();
      const dir = process.argv[4] || process.cwd();
      const files = require("./lib/install")[cmd](tool, dir);
      console.log((cmd === "install" ? "Installed" : "Removed") + " Shadow AI Guard hooks in " + dir + ":\n  " + files.join("\n  "));
      if (cmd === "install") console.log("Restart / reload the AI tool so it picks up the new hooks.");
      if (cmd === "install" && dir === "--global") console.log("Exempt (guard stays out of these folders):\n  " + core.exemptFolders().join("\n  "));
    } else if (cmd === "exempt" || cmd === "unexempt") {
      const dir = require("path").resolve(process.argv[3] || process.cwd());
      const list = core.setExempt(dir, cmd === "exempt");
      console.log((cmd === "exempt" ? "Exempted " : "Guarding again ") + dir + "\nExempt folders: " + (list.join(", ") || "none"));
    } else if (cmd === "scan") {
      // scan a folder (or the whole laptop's projects folder) — findings go to the dashboard as "codebase scan"
      const target = process.argv[3] || process.cwd();
      process.exitCode = await require("./git/scan").main([...process.argv.slice(4), target], process.cwd());
    } else if (cmd === "logout") {
      core.logout(); console.log("Signed out.");
    } else {
      console.log("Usage: node agent-guard/cli.js login|status|flush|off|on|logout\n" +
        "       node agent-guard/cli.js install|uninstall <claude-code|cursor|windsurf|antigravity|git|all> <folder | --global>\n" +
        "       node agent-guard/cli.js exempt|unexempt <folder>\n" +
        "       node agent-guard/cli.js scan <folder>");
    }
  } catch (e) {
    console.error("Error: " + e.message);
    process.exitCode = 1;
  }
})();
