/**
 * Shadow AI Guard — tool-agnostic decision engine for AI coding agents
 * ===================================================================
 * Every agent adapter (Claude Code, Cursor, Windsurf/Devin, Antigravity)
 * turns its own hook payload into ONE of these actions, and turns the
 * verdict back into its own output format:
 *
 *   { kind: "prompt", text, files? }      what the developer typed + attached files
 *   { kind: "read",   path, content? }    the agent reading a file
 *   { kind: "search", targets: [] }       grep/glob/find
 *   { kind: "shell",  command }           a terminal command
 *   { kind: "write",  path?, text }       the agent writing code
 *   { kind: "tool",   name, text }        MCP / web / anything else
 *
 * Verdicts: "allow" | "ask" (Warn) | "block" (Mandatory / secrets file).
 * The detector, policies, keywords and honeytokens are the browser
 * extension's own. Each non-allow verdict is reported to the dashboard as
 * metadata only (see report()).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const core = require("./core");

const OVERRIDE = "!sendanyway";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const DEFAULT_SENSITIVE_PATHS = [
  "(^|[\\\\/])\\.env(\\.(?!example$|sample$|template$)[\\w-]+)?$",   // .env, .env.local — not .env.example
  "\\.(pem|key|p12|pfx|jks|keystore)$",
  "(^|[\\\\/])id_(rsa|ed25519|ecdsa|dsa)$",
  "(^|[\\\\/])\\.aws[\\\\/]credentials$",
  "(^|[\\\\/])\\.npmrc$",
  "(^|[\\\\/])secrets?([\\\\/]|$)",
  "credentials\\.json$",
];

const MANDATORY_NO_PATTERN = { patternTypes: [], complianceFrameworks: [], riskLevel: "High", overallTier: "MandatoryRedaction", confirmedLeak: false, matches: [] };

// ---------------------------------------------------------------- helpers
function sensitiveMatcher(list) {
  const res = (list || DEFAULT_SENSITIVE_PATHS).map((p) => new RegExp(p, "i"));
  return (p) => !!p && res.some((re) => re.test(String(p).trim().replace(/^["']|["']$/g, "")));
}

function pathsInCommand(cmd) {
  return String(cmd).split(/[\s;|&<>()]+/)
    .map((t) => t.replace(/^@/, "").replace(/^["']|["']$/g, ""))
    .filter((t) => t && !t.startsWith("-") && /[./\\]/.test(t));
}

function readIfSmall(file, cwd) {
  try {
    const full = path.isAbsolute(file) ? file : path.join(cwd || process.cwd(), file);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(full, "utf8");
  } catch (e) { return null; }
}

/**
 * Files a prompt refers to: @mentions (`@notes.txt`, `@"my file.md"`,
 * `@src/a.js#L1-9`) and absolute paths. Only paths that exist as files count.
 */
function filesInPrompt(text, cwd) {
  const out = [];
  const add = (raw) => {
    if (!raw) return;
    const p = raw.replace(/#L?\d+(-L?\d+)?$/i, "").replace(/[.,;:!?)\]}'"`]+$/, "");
    if (!p) return;
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
    try { if (fs.statSync(abs).isFile()) out.push(abs); } catch (e) {}
  };
  let m;
  const quoted = /@"([^"]+)"|@'([^']+)'/g;
  while ((m = quoted.exec(text))) add(m[1] || m[2]);
  const plain = /(?:^|[\s(])@([^\s"'<>|]+)/g;
  while ((m = plain.exec(text))) add(m[1]);
  const absWin = /(?:^|[\s"'(])([A-Za-z]:[\\/][^\s"'<>|]+)/g;
  while ((m = absWin.exec(text))) add(m[1]);
  const absPosix = /(?:^|[\s"'(])(\/(?:[^\s"'<>|/]+\/)*[^\s"'<>|/]+\.[A-Za-z0-9]{1,8})/g;
  while ((m = absPosix.exec(text))) add(m[1]);
  return [...new Set(out)].slice(0, 20);
}

function summary(scan) {
  const labels = [...new Set(scan.matches.map((m) => m.label))];
  return labels.slice(0, 4).join(", ") + (labels.length > 4 ? ` (+${labels.length - 4} more)` : "");
}

// ---------------------------------------------------------------- engine
async function loadDetector(cwd) {
  const policy = await core.getPolicy(cwd);
  const D = require(path.join(core.CORE, "detector.js"));
  D.reset();
  if (policy.honeytokens.length) D.setHoneytokens(policy.honeytokens);
  if (policy.customKeywords.length) D.setCustomKeywords(policy.customKeywords);
  D.setPolicyOverrides(policy.policyOverrides || {});
  return { D, policy };
}

// ---------------------------------------------------------------- reporting
let EP = null;
/** Metadata-only: local log always, dashboard when signed in. */
function report(scan, info, aiTool, opts) {
  try {
    core.appendLine(core.FILES.log, {
      ts: new Date().toISOString(), channel: info.channel || "agent_hook", ai_tool: aiTool,
      event: info.kind, reason: info.reason, action: info.action,
      tier: scan.overallTier, pattern_types: scan.patternTypes,
    });
  } catch (e) {}

  const s = core.readJson(core.FILES.session);
  if (!s || !s.company_id) return;
  EP = EP || require(path.join(core.CORE, "event-payload.js"));
  const payload = EP.buildEventPayload(scan, {
    companyId: s.company_id, employeeHash: s.employee_hash, department: s.department,
    aiTool, action: info.action,
    source: info.fileName ? "file" : "text",
    fileName: info.fileName, fileType: info.fileName ? path.extname(info.fileName).replace(".", "") || null : null,
  });
  core.enqueue(payload);
  if (!(opts && opts.deferSend)) sendInBackground();
}

/** Starts one detached sender for whatever is queued. */
function sendInBackground() {
  if (process.env.SHADOW_NO_SEND === "1") return;   // tests: queue only
  try {
    spawn(process.execPath, [path.join(__dirname, "send.js")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (e) { /* stays queued; sent next time */ }
}

// ---------------------------------------------------------------- verdict builders
const verdict = (v, message, scan, info) => ({ verdict: v, message: message ? "Shadow AI Guard: " + message : "", scan, info });
const ALLOW = { verdict: "allow", message: "" };

function onText(text, label, info, D) {
  const scan = D.scan(text);
  if (scan.riskLevel === "None") return null;
  if (scan.overallTier === "MandatoryRedaction") {
    return verdict("block", `${label} contains ${summary(scan)} (mandatory). It was not sent to the model.`, scan, info);
  }
  return verdict("ask", `${label} contains ${summary(scan)}. Allow it to be sent to the model?`, scan, info);
}

function secretsFile(file, why, info, D, cwd, content) {
  const text = content != null ? content : readIfSmall(file, cwd);
  const scan = text ? D.scan(text) : null;
  return verdict("block", why, scan && scan.riskLevel !== "None" ? scan : MANDATORY_NO_PATTERN,
    { ...info, reason: "sensitive_path", fileName: path.basename(file) });
}

/**
 * Decide on one normalized action. Returns { verdict, message, scan, info }.
 * Callers pass `promptOverride: false` when the tool can't take an override
 * prefix (verdict for Warn prompts is then "ask").
 */
function decideAction(a, D, policy, cwd) {
  const isSensitive = sensitiveMatcher(policy.sensitivePaths);
  const info = { kind: a.kind, tool: a.name };

  if (a.kind === "prompt") {
    let text = String(a.text || "");
    const override = text.trimStart().toLowerCase().startsWith(OVERRIDE);
    if (override) text = text.trimStart().slice(OVERRIDE.length);

    // Files attached to the prompt (@mentions, pasted paths, Cursor attachments)
    // reach the model WITHOUT a read tool call, so they are checked here.
    const attached = [...new Set([...(a.files || []), ...filesInPrompt(text, cwd)])];
    let fileHit = null;
    // Documents uploaded into the chat (already extracted to text by the adapter)
    for (const doc of a.docs || []) {
      const name = String(doc.name || "attachment");
      if (isSensitive(name)) {
        const s = doc.text ? D.scan(doc.text) : null;
        return verdict("block", `the uploaded file "${name}" is a secrets file. It was not sent to the model.`,
          s && s.riskLevel !== "None" ? s : MANDATORY_NO_PATTERN, { ...info, reason: "uploaded_secrets_file", fileName: name });
      }
      if (!doc.text) continue;
      const s = D.scan(doc.text);
      if (s.riskLevel === "None") continue;
      if (s.overallTier === "MandatoryRedaction") {
        return verdict("block", `the uploaded file "${name}" contains ${summary(s)} (mandatory). It was not sent to the model.`,
          s, { ...info, reason: "uploaded_file", fileName: name });
      }
      if (!fileHit) fileHit = { file: name, scan: s };
    }
    for (const f of attached) {
      if (isSensitive(f)) {
        const content = readIfSmall(f, cwd);
        const s = content ? D.scan(content) : null;
        return verdict("block", `the attached file "${path.basename(f)}" is a secrets file. It was not sent to the model.`,
          s && s.riskLevel !== "None" ? s : MANDATORY_NO_PATTERN, { ...info, reason: "attached_secrets_file", fileName: path.basename(f) });
      }
      const content = readIfSmall(f, cwd);
      if (!content) continue;
      const s = D.scan(content);
      if (s.riskLevel === "None") continue;
      if (s.overallTier === "MandatoryRedaction") {
        return verdict("block", `the attached file "${path.basename(f)}" contains ${summary(s)} (mandatory). It was not sent to the model.`,
          s, { ...info, reason: "attached_file", fileName: path.basename(f) });
      }
      if (!fileHit) fileHit = { file: f, scan: s };
    }

    const scan = D.scan(text);
    if (scan.overallTier === "MandatoryRedaction") {
      return verdict("block", `your prompt contains ${summary(scan)}. This is set to mandatory by your organisation — ` +
        "remove it (use an environment variable or a placeholder) and send again.", scan, info);
    }
    const warnScan = scan.riskLevel !== "None" ? scan : fileHit && fileHit.scan;
    if (!warnScan) return ALLOW;
    const what = scan.riskLevel !== "None" ? "your prompt" : `the attached file "${path.basename(fileHit.file)}"`;
    const wInfo = { ...info, fileName: scan.riskLevel === "None" && fileHit ? path.basename(fileHit.file) : undefined,
      reason: scan.riskLevel === "None" ? "attached_file" : undefined };
    if (override) return verdict("allow_reported", "", warnScan, { ...wInfo, action: "sent_anyway" });
    return verdict("block", `${what} contains ${summary(warnScan)}. Remove it and send again, or start your ` +
      `prompt with "${OVERRIDE}" if you're sure it's fine.`, warnScan, { ...wInfo, warnPrompt: true });
  }

  if (a.kind === "read") {
    const file = a.path || "";
    if (isSensitive(file)) return secretsFile(file, `reading "${path.basename(file)}" is blocked — it's a secrets file.`, info, D, cwd, a.content);
    const text = a.content != null ? a.content : readIfSmall(file, cwd);
    return (text && onText(text, `"${path.basename(file)}"`, { ...info, fileName: path.basename(file) }, D)) || ALLOW;
  }

  if (a.kind === "search") {
    if ((a.targets || []).some((t) => t && (isSensitive(t) || /\.env\b(?!\.example)/i.test(t)))) {
      return verdict("block", "searching secrets files is blocked.", MANDATORY_NO_PATTERN, { ...info, reason: "sensitive_path" });
    }
    return ALLOW;
  }

  if (a.kind === "shell") {
    const cmd = String(a.command || "");
    if (/(^|[\s;|&])(printenv|env|set)(\s*$|\s*[|;&>])/i.test(cmd) || /Get-ChildItem\s+env:/i.test(cmd) || /\bgci\s+env:/i.test(cmd)) {
      return verdict("block", "dumping environment variables is blocked — they hold secrets.", MANDATORY_NO_PATTERN, { ...info, reason: "env_dump" });
    }
    const files = pathsInCommand(cmd);
    const hit = files.find(isSensitive);
    if (hit) return secretsFile(hit, `the command touches "${path.basename(hit)}", a secrets file.`, info, D, cwd);
    const inline = onText(cmd, "this command", { ...info, reason: "inline_secret" }, D);
    if (inline) return inline;
    if (/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|ftp|nc)\b/i.test(cmd)) {
      for (const f of files) {
        const text = readIfSmall(f, cwd);
        const d = text && onText(text, `"${path.basename(f)}" (being sent over the network)`,
          { ...info, reason: "network_upload", fileName: path.basename(f) }, D);
        if (d) return d;
      }
    }
    return ALLOW;
  }

  if (a.kind === "write") {
    if (!a.text) return ALLOW;
    return onText(a.text, "the code being written", { ...info, reason: "secret_in_code", fileName: a.path ? path.basename(a.path) : undefined }, D) || ALLOW;
  }

  // tool: MCP, web fetch, anything else — scan what is being sent out
  if (!a.text) return ALLOW;
  return onText(a.text, `the input to ${a.name || "this tool"}`, { ...info, reason: "tool_input" }, D) || ALLOW;
}

/** Decide, then report anything that wasn't a plain allow. */
async function decide(action, { cwd, aiTool, quiet }) {
  const { D, policy } = await loadDetector(cwd);
  const d = decideAction(action, D, policy, cwd);
  if (d.verdict === "allow") return d;
  const actionName = d.info.action || (d.verdict === "block" ? "blocked" : "warned");
  if (!quiet) report(d.scan, { ...d.info, action: actionName }, aiTool);
  return { ...d, verdict: d.verdict === "allow_reported" ? "allow" : d.verdict };
}

module.exports = { decide, decideAction, filesInPrompt, loadDetector, report, sendInBackground, sensitiveMatcher, pathsInCommand, readIfSmall, OVERRIDE, MANDATORY_NO_PATTERN };
