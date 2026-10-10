/**
 * Text extraction for uploaded / attached documents — the desktop twin of
 * extension/src/content/file-extractor.js, using the SAME bundled libraries
 * (extension/vendor/pdf.min.mjs, mammoth.browser.min.js), so a file the
 * extension can read in the browser is read the same way here.
 *
 *   await extractText(bufferOrString, { name, mediaType }) → { text, supported, reason? }
 *
 * Like the extension, a file we can't parse FAILS OPEN (supported: false):
 * a DLP tool that blocks every file it merely failed to read gets disabled.
 */
"use strict";
const path = require("path");
const { pathToFileURL } = require("url");

const VENDOR = path.resolve(__dirname, "..", "..", "extension", "vendor");
const TEXT_EXTENSIONS = ["txt", "csv", "md", "markdown", "json", "log", "xml", "yaml", "yml", "tsv",
  "env", "ini", "conf", "cfg", "properties", "toml", "js", "ts", "py", "java", "go", "rb", "php", "sql", "sh", "ps1", "html", "css"];
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 40;

const extOf = (name) => { const i = String(name || "").lastIndexOf("."); return i === -1 ? "" : String(name).slice(i + 1).toLowerCase(); };
const unsupported = (reason) => ({ text: "", supported: false, reason });

let pdfjs = null;
async function readPdf(buf) {
  try {
    if (!pdfjs) {
      pdfjs = await import(pathToFileURL(path.join(VENDOR, "pdf.min.mjs")).href);
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(VENDOR, "pdf.worker.min.mjs")).href;
    }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const chunks = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES); i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      chunks.push(c.items.map((it) => it.str).join(" "));
    }
    return { text: chunks.join("\n"), supported: true };
  } catch (e) { return unsupported("could not parse .pdf: " + String(e && e.message).slice(0, 80)); }
}

let mammoth = null;
async function readDocx(buf) {
  try {
    mammoth = mammoth || require(path.join(VENDOR, "mammoth.browser.min.js"));
    const r = await mammoth.extractRawText({ arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    return { text: String(r.value || ""), supported: true };
  } catch (e) { return unsupported("could not parse .docx: " + String(e && e.message).slice(0, 80)); }
}

async function extractText(data, { name, mediaType } = {}) {
  if (data == null) return unsupported("no data");
  if (typeof data === "string") return { text: data, supported: true };   // already text (e.g. a text/plain upload)
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > MAX_BYTES) return unsupported("larger than 25MB — not scanned");
  const ext = extOf(name), type = String(mediaType || "");
  if (TEXT_EXTENSIONS.includes(ext) || type.startsWith("text/") || type === "application/json") return { text: buf.toString("utf8"), supported: true };
  if (ext === "pdf" || type === "application/pdf") return readPdf(buf);
  if (ext === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return readDocx(buf);
  return unsupported("unsupported format (." + (ext || type || "unknown") + ") — not scanned");
}

module.exports = { extractText, extOf };
