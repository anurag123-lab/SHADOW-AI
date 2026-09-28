/**
 * Downloads the two third-party libraries the file scanner needs into
 * extension/vendor/.
 *
 * They must be BUNDLED, not loaded from a CDN: MV3's content security
 * policy blocks remote script, so a CDN <script> tag silently fails.
 *
 * Run: node scripts/fetch-vendor.js
 * The extension degrades gracefully without them — PDFs and .docx report
 * "not scanned" and fail open — so this is not a hard prerequisite for
 * the text-detection demo.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const VENDOR = path.join(__dirname, "..", "extension", "vendor");

const FILES = [
  {
    name: "pdf.min.mjs",
    url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs",
    why: "PDF text extraction",
  },
  {
    name: "pdf.worker.min.mjs",
    url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs",
    why: "pdf.js worker (must also be local)",
  },
  {
    name: "mammoth.browser.min.js",
    url: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js",
    why: ".docx text extraction",
  },
];

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "shadow-ai-guard-setup" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          fs.writeFileSync(dest, buf);
          resolve(buf.length);
        });
      })
      .on("error", reject);
  });
}

(async () => {
  fs.mkdirSync(VENDOR, { recursive: true });
  let failures = 0;

  for (const file of FILES) {
    const dest = path.join(VENDOR, file.name);
    process.stdout.write(`  ${file.name.padEnd(26)} `);
    try {
      const bytes = await download(file.url, dest);
      console.log(`ok (${Math.round(bytes / 1024)} KB) — ${file.why}`);
    } catch (e) {
      failures++;
      console.log(`FAILED: ${e.message}`);
    }
  }

  if (failures) {
    console.log(
      `\n${failures} file(s) could not be downloaded. Typed-text detection still works;\n` +
      `PDF/.docx uploads will report "not scanned" and fail open until these exist.\n` +
      `You can also download them manually from the URLs in this script.`
    );
    process.exitCode = 0; // not a hard failure
  } else {
    console.log("\nVendor libraries ready.");
  }
})();
