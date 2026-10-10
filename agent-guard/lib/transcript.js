/**
 * Files UPLOADED into a Claude Code chat (paperclip / drag-and-drop in the
 * VS Code panel) never appear in the UserPromptSubmit `prompt` field and are
 * never read with a tool: Claude Code puts them in the message itself as
 * `document` blocks, and writes that message to the session transcript
 * (`transcript_path`, given to every hook) — usually AFTER UserPromptSubmit.
 *
 * currentMessage() tries to find THIS prompt's record before it is sent;
 * recentUploads() lists uploads already sent, so the next hook call (or the
 * end-of-turn Stop hook) can report them. See adapters/claude-code.js.
 *
 * Read-only, local only: nothing from the transcript is stored or sent.
 */
"use strict";
const fs = require("fs");

const TAIL_BYTES = 8 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

function findRecord(lines, prompt, promptId) {
  const want = String(prompt || "").trim();
  const now = Date.now();
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    if (o.type !== "user" || !o.message || !Array.isArray(o.message.content)) continue;
    // tool results later in the same turn carry the same promptId — they are not the prompt
    if (o.message.content.every((b) => b && b.type === "tool_result")) continue;
    if (promptId) { if (o.promptId === promptId) return o; continue; }
    const texts = o.message.content.filter((b) => b && b.type === "text").map((b) => String(b.text || "").trim());
    const recent = !o.timestamp || now - Date.parse(o.timestamp) < 60 * 1000;
    if (recent && (!want || texts.some((t) => t === want || t.endsWith(want)))) return o;
    return null;   // newest user record isn't this prompt (yet)
  }
  return null;
}

function contentOf(rec, prompt) {
  const docs = [], extra = [];
  for (const b of rec.message.content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "document" && b.source) {
      const s = b.source;
      const data = s.type === "base64" ? Buffer.from(String(s.data || ""), "base64") : s.type === "text" ? String(s.data || "") : null;
      if (data != null) docs.push({ name: b.title || b.name || "attachment", mediaType: s.media_type, data });
    } else if (b.type === "text") {
      const t = String(b.text || "");
      // the typed prompt is scanned separately; IDE notes that only name an open file carry no content
      if (t.trim() !== String(prompt || "").trim() && !/^<ide_opened_file>/.test(t)) extra.push(t);
    }
  }
  return { docs, extraText: extra.join("\n") };
}

/**
 * BEFORE sending: this prompt's uploads, if Claude Code has already written
 * the message. Observed on Claude Code for VS Code: in a new chat the
 * transcript doesn't exist yet when the hook runs, so this can come back
 * null — auditUploads() then catches the upload right after it was sent.
 * → { uuid, docs: [{ name, mediaType, data }], extraText } or null
 */
async function currentMessage(transcriptPath, prompt, promptId) {
  if (!transcriptPath) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let rec = null;
    try { rec = findRecord(readTail(transcriptPath).split("\n").filter(Boolean), prompt, promptId); } catch (e) { rec = null; }
    if (rec) return { uuid: rec.uuid || rec.promptId, ...contentOf(rec, prompt) };
    await sleep(100);
  }
  return null;
}

/**
 * AFTER sending: user messages in the transcript tail that carry uploaded
 * documents. → [{ uuid, ts, docs }] (newest last)
 */
function recentUploads(transcriptPath, maxRecords = 30) {
  let lines;
  try { lines = readTail(transcriptPath).split("\n").filter(Boolean); } catch (e) { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxRecords; i--) {
    if (lines[i].indexOf('"document"') === -1) continue;   // cheap pre-filter
    let o; try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    if (o.type !== "user" || !o.message || !Array.isArray(o.message.content)) continue;
    const { docs } = contentOf(o, "");
    if (docs.length) out.unshift({ uuid: o.uuid || o.promptId || String(i), ts: o.timestamp ? Date.parse(o.timestamp) : 0, docs });
  }
  return out;
}

module.exports = { currentMessage, recentUploads, findRecord };
