/**
 * Generates the files used in the file-scanning part of the demo.
 *
 * Writes a real (if minimal) PDF by hand — uncompressed text streams and a
 * correct xref table — so pdf.js extracts text from it exactly as it would
 * from a Word export. No dependencies, and no binary blobs committed that
 * nobody can regenerate.
 *
 * Run: node scripts/make-demo-files.js
 * Output: demo-files/
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "demo-files");

/* ------------------------------------------------------------------ *
 * Minimal PDF writer
 * ------------------------------------------------------------------ */
function escapePdfText(line) {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(lines) {
  // Content stream: one line of text per Td step down the page.
  const body = [
    "BT",
    "/F1 12 Tf",
    "14 TL",
    "56 760 Td",
    ...lines.map((line) => (line === "" ? "T*" : `(${escapePdfText(line)}) Tj T*`)),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];

  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/* ------------------------------------------------------------------ *
 * The demo files
 * ------------------------------------------------------------------ */
const FILES = [];

// 1. The one that gets BLOCKED. Card number + confidentiality marker +
//    strategy terms, so the block screen has several findings to show.
FILES.push({
  name: "Q3-forecast-CONFIDENTIAL.pdf",
  why: "Blocked — card number, confidentiality marker, strategy terms",
  data: buildPdf([
    "ACME CORP - Q3 REVENUE FORECAST",
    "CONFIDENTIAL - INTERNAL ONLY. Do not distribute.",
    "",
    "Prepared for the board meeting on 14 October.",
    "",
    "1. Summary",
    "",
    "Revenue forecast for Q3 is tracking 8 percent above plan. The burn",
    "rate improved after the vendor renegotiation closed in August.",
    "Runway projection now extends to 19 months.",
    "",
    "2. Outstanding items",
    "",
    "The cap table needs updating before the term sheet is countersigned.",
    "Board minutes from the July session are still in draft.",
    "",
    "3. Billing escalation (from support)",
    "",
    "Customer disputed a duplicate charge on card 4111 1111 1111 1111.",
    "Refund approved; finance to process this week.",
    "Contact on file: priya.sharma@acmecorp.in, 9876543210",
    "",
    "4. Internal reference",
    "",
    "Document tracking reference: ACME-HT-9F3K2Q",
  ]),
});

// 2. The one that goes THROUGH. Proves the tool is not just a wall —
//    the resume path is the harder thing to demo and the more convincing.
FILES.push({
  name: "team-offsite-notes.pdf",
  why: "Clean — uploads straight through, no interruption",
  data: buildPdf([
    "TEAM OFFSITE - PLANNING NOTES",
    "",
    "Date: second week of November, two full days.",
    "Location shortlist: Coorg, Wayanad, or somewhere near Bangalore",
    "with reliable wifi and space for a workshop session.",
    "",
    "Agenda ideas",
    "",
    "- Morning: retrospective on the last two quarters",
    "- Afternoon: roadmap workshop, split into three groups",
    "- Day two: a long walk and an unstructured conversation",
    "",
    "Someone should book the venue before the end of the month.",
    "Budget is roughly what we spent last year plus a bit.",
    "",
    "Open question: do we invite the contractors? Leaning yes.",
  ]),
});

// 3. A .txt so you can demo extraction with no library involved at all.
FILES.push({
  name: "server-notes.txt",
  why: "Text file — internal IPs and an AWS key",
  data: Buffer.from(
    [
      "Deployment notes - staging rebuild",
      "",
      "The API box at 192.168.10.5 keeps dropping connections after the",
      "nightly job. Worker at 10.0.12.7 is fine.",
      "",
      "Rotate these before Friday:",
      "  AKIAIOSFODNN7EXAMPLE",
      "",
      "Ping me if the health check flaps again.",
      "",
    ].join("\n"),
    "utf8"
  ),
});

// 4. A .csv — the shape of a real accidental export.
FILES.push({
  name: "customer-export.csv",
  why: "CSV — emails and phone numbers in bulk",
  data: Buffer.from(
    [
      "name,email,phone,city",
      "R. Nair,r.nair@example.in,9876543210,Kochi",
      "S. Iyer,s.iyer@example.in,9123456780,Chennai",
      "A. Bose,a.bose@example.in,9812345670,Kolkata",
      "M. Shah,m.shah@example.in,9988776655,Ahmedabad",
      "",
    ].join("\n"),
    "utf8"
  ),
});

/* ------------------------------------------------------------------ *
 * Write + verify
 * ------------------------------------------------------------------ */
fs.mkdirSync(OUT, { recursive: true });

console.log("\nDemo files:\n");
for (const file of FILES) {
  const dest = path.join(OUT, file.name);
  fs.writeFileSync(dest, file.data);
  console.log(`  ${file.name.padEnd(32)} ${(file.data.length / 1024).toFixed(1)} KB`);
  console.log(`  ${" ".repeat(32)} ${file.why}\n`);
}

// Self-check: run the real detector over the text content we expect each
// file to yield, so a broken fixture is caught here and not on stage.
const D = require("../extension/src/core/detector.js");
D.reset();
D.setHoneytokens(["ACME-HT-9F3K2Q"]);

console.log("Detector check (against the text these files contain):\n");

const EXPECT = [
  ["Q3-forecast-CONFIDENTIAL.pdf", "MandatoryRedaction", true],
  ["team-offsite-notes.pdf", null, false],
  ["server-notes.txt", "MandatoryRedaction", false],
  ["customer-export.csv", "Warn", false],
];

let allGood = true;
for (const [name, expectedTier, expectLeak] of EXPECT) {
  const file = FILES.find((f) => f.name === name);
  // For the PDFs, scan the source lines rather than re-parsing the PDF.
  const text = name.endsWith(".pdf")
    ? file.data.toString("latin1").match(/\((.*?)\) Tj/g).map((s) => s.slice(1, -4)).join("\n")
    : file.data.toString("utf8");

  const r = D.scan(text);
  const tierOk = r.overallTier === expectedTier;
  const leakOk = r.confirmedLeak === expectLeak;
  if (!tierOk || !leakOk) allGood = false;

  console.log(
    `  ${tierOk && leakOk ? "ok  " : "FAIL"} ${name.padEnd(32)} ` +
      `${String(r.overallTier).padEnd(19)} ${r.confirmedLeak ? "confirmed leak" : ""}`
  );
  if (r.patternTypes.length) console.log(`       ${r.patternTypes.join(", ")}`);
}

console.log(
  allGood
    ? "\nAll demo files behave as expected.\n"
    : "\nOne or more demo files did not produce the expected verdict.\n"
);
process.exitCode = allGood ? 0 : 1;
