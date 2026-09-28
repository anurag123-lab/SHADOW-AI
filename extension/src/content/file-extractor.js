/* eslint-disable */
/**
 * Shadow AI Guard — File Text Extraction (Feature 2.1)
 * ====================================================
 * Turns an attached file into plain text so the SAME detector used for
 * typed text can scan it. No second detection path exists.
 *
 * Libraries are bundled in /vendor because MV3's CSP forbids loading
 * script from a CDN. If a vendor file is missing, extraction reports
 * `supported: false` and the caller FAILS OPEN — the upload proceeds with
 * a console notice. A DLP tool that silently blocks files it merely
 * failed to parse is worse than one that admits the gap.
 */
(function (root) {
  "use strict";

  var pdfjsPromise = null;

  var TEXT_EXTENSIONS = ["txt", "csv", "md", "markdown", "json", "log", "xml", "yaml", "yml", "tsv"];
  var MAX_BYTES = 25 * 1024 * 1024;        // 25MB
  var MAX_PDF_PAGES = 40;

  function extensionOf(name) {
    var idx = String(name || "").lastIndexOf(".");
    return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
  }

  function unsupported(reason) {
    return { text: "", supported: false, reason: reason };
  }

  /* ---------------------------------------------------------------- *
   * .txt / .csv / .md / .json — no dependency
   * ---------------------------------------------------------------- */
  function readAsText(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve({ text: String(reader.result || ""), supported: true }); };
      reader.onerror = function () { resolve(unsupported("could not read file")); };
      reader.readAsText(file);
    });
  }

  /* ---------------------------------------------------------------- *
   * .pdf — pdf.js legacy build, loaded as a module from /vendor
   * ---------------------------------------------------------------- */
  function loadPdfJs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = import(chrome.runtime.getURL("vendor/pdf.min.mjs"))
      .then(function (mod) {
        var lib = mod.default && mod.default.getDocument ? mod.default : mod;
        lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");
        return lib;
      })
      .catch(function (e) {
        pdfjsPromise = null;
        throw e;
      });
    return pdfjsPromise;
  }

  async function readPdf(file) {
    var pdfjs;
    try {
      pdfjs = await loadPdfJs();
    } catch (e) {
      return unsupported("pdf.js not bundled — run: node scripts/fetch-vendor.js");
    }

    try {
      var buffer = await file.arrayBuffer();
      var doc = await pdfjs.getDocument({ data: buffer }).promise;
      var pages = Math.min(doc.numPages, MAX_PDF_PAGES);
      var chunks = [];

      for (var i = 1; i <= pages; i++) {
        var page = await doc.getPage(i);
        var content = await page.getTextContent();
        chunks.push(content.items.map(function (item) { return item.str; }).join(" "));
      }

      var text = chunks.join("\n");

      // A PDF that yields almost no text is a scan/image PDF. OCR is out
      // of scope for v1 (see the spec) — say so rather than pretending
      // the file was checked and found clean.
      if (text.replace(/\s/g, "").length < 20) {
        return unsupported("PDF appears to be scanned/image-based — text extraction is not possible without OCR (not supported in v1)");
      }

      return { text: text, supported: true, pages: doc.numPages, scannedPages: pages };
    } catch (e) {
      return unsupported("could not parse PDF: " + e.message);
    }
  }

  /* ---------------------------------------------------------------- *
   * .docx — mammoth.js, loaded as a classic global by the manifest
   * ---------------------------------------------------------------- */
  async function readDocx(file) {
    if (!root.mammoth || !root.mammoth.extractRawText) {
      return unsupported("mammoth.js not bundled — run: node scripts/fetch-vendor.js");
    }
    try {
      var buffer = await file.arrayBuffer();
      var result = await root.mammoth.extractRawText({ arrayBuffer: buffer });
      return { text: String(result.value || ""), supported: true };
    } catch (e) {
      return unsupported("could not parse .docx: " + e.message);
    }
  }

  /* ---------------------------------------------------------------- *
   * Dispatch
   * ---------------------------------------------------------------- */
  async function extract(file) {
    if (!file) return unsupported("no file");
    if (file.size > MAX_BYTES) return unsupported("file larger than 25MB — not scanned");

    var ext = extensionOf(file.name);
    var type = file.type || "";

    if (TEXT_EXTENSIONS.indexOf(ext) !== -1 || type.indexOf("text/") === 0 || type === "application/json") {
      return readAsText(file);
    }
    if (ext === "pdf" || type === "application/pdf") {
      return readPdf(file);
    }
    if (ext === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return readDocx(file);
    }

    // .xlsx, .pptx, .doc, images, archives...
    return unsupported("unsupported format (." + (ext || "unknown") + ") — not scanned");
  }

  root.ShadowAIFileExtractor = {
    extract: extract,
    extensionOf: extensionOf,
    TEXT_EXTENSIONS: TEXT_EXTENSIONS,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
