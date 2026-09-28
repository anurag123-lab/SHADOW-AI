/**
 * Generates the pattern-coverage test files: one realistic document per
 * scenario, together covering every pattern type the detector knows.
 *
 * The four files in demo-files/ are the short stage demo. These are the
 * wider sweep — drag any of them into ChatGPT, Claude or Gemini to see a
 * specific category fire, or run `npm test` to check them all offline.
 *
 * Every value in here is fake: test card numbers, RFC 2606 example
 * domains, RFC 1918 addresses, documentation-sample GSTIN/PAN/IFSC, and
 * placeholder keys that no vendor would ever issue.
 *
 * Run: node scripts/make-pattern-tests.js
 * Output: demo-files/pattern-tests/
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "demo-files", "pattern-tests");

/* ------------------------------------------------------------------ *
 * Minimal PDF writer (same approach as make-demo-files.js)
 * ------------------------------------------------------------------ */
function escapePdfText(line) {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(lines) {
  const body = [
    "BT", "/F1 11 Tf", "14 TL", "56 780 Td",
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
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/* ------------------------------------------------------------------ *
 * Minimal .docx writer — a zip of four XML parts, deflate-compressed.
 * Enough for Word, Google Docs and mammoth.js to open it.
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(data, "utf8");
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt32LE(0, 10);           // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDocx(paragraphs) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join("");
  return buildZip([
    { name: "[Content_Types].xml", data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>" },
    { name: "_rels/.rels", data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>" },
    { name: "word/_rels/document.xml.rels", data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>' },
    { name: "word/document.xml", data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>` },
  ]);
}

const text = (lines) => Buffer.from(lines.join("\n") + "\n", "utf8");

/* ------------------------------------------------------------------ *
 * The files. `lines` is the text the extension will extract; `expect`
 * is the verdict under DEFAULT policy (no dashboard overrides).
 *   tier:     overall tier — "MandatoryRedaction", "Warn" or null (clean)
 *   types:    pattern types that must all be detected
 *   leak:     true if this must be a confirmed (honeytoken) leak
 *   keywords: custom keywords to load first (mirrors the dashboard)
 * ------------------------------------------------------------------ */
const FILES = [
  {
    name: "payroll-march.csv", kind: "text",
    what: "Payroll export — PAN, IFSC, CTC, phone, email",
    lines: [
      "employee,email,phone,pan,bank_ifsc,ctc_lpa",
      "R. Nair,r.nair@example.in,9876543210,ABCPN1234K,HDFC0001234,18.5",
      "S. Iyer,s.iyer@example.in,9123456780,BCDPI2345L,ICIC0004321,22.0",
      "A. Bose,a.bose@example.in,9812345670,CDEPB3456M,SBIN0007788,15.2",
      "Note: CTC revision letters go out after appraisal.",
    ],
    expect: { tier: "MandatoryRedaction", types: ["panCard", "ifscCode", "hrTerm", "phone", "email"] },
  },
  {
    name: "vendor-invoice.pdf", kind: "pdf",
    what: "Supplier invoice — GSTIN, IFSC, email, phone",
    lines: [
      "TAX INVOICE  #INV-2026-0412",
      "",
      "Supplier: Sharma Office Supplies Pvt Ltd",
      "GSTIN: 27AAPFU0939F1ZV",
      "Billing contact: accounts@sharma-supplies.example.in, 9811122233",
      "",
      "Bill to: Acme Corp, Bengaluru",
      "GSTIN: 29AABCA1234B1Z5",
      "",
      "Item                               Qty    Amount",
      "Ergonomic chairs                    12    1,44,000",
      "Standing desks                       4      96,000",
      "",
      "Pay to: HDFC Bank, IFSC HDFC0000123",
    ],
    expect: { tier: "Warn", types: ["gstin", "ifscCode", "email", "phone"] },
  },
  {
    name: "patient-referral.pdf", kind: "pdf",
    what: "Clinic referral — health terms, phone, email",
    lines: [
      "PATIENT REFERRAL NOTE",
      "",
      "Patient ID: PT-448210",
      "Referred by: Dr. K. Menon (dr.menon@clinic.example.org)",
      "Contact: 9900112233",
      "",
      "Medical history: type 2 diabetes, managed with diet.",
      "Diagnosis code: ICD-10 E11.9",
      "Latest blood test result attached, HbA1c 7.1.",
      "Prescription history available on request.",
    ],
    expect: { tier: "Warn", types: ["healthTerm", "email", "phone"] },
  },
  {
    name: "prod-deploy.yaml", kind: "text",
    what: "Deploy config — private key, internal IPs, random DB password",
    lines: [
      "service: billing-api",
      "environment: production",
      "hosts:",
      "  primary: 10.20.1.15",
      "  replica: 192.168.40.7",
      "database:",
      "  user: billing_svc",
      "  password: 7Kx9mPq2LvR4nT8wZ3bY6cF1jH5gD0sA",
      "tls_key: |",
      "  -----BEGIN RSA PRIVATE KEY-----",
      "  MIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "  -----END RSA PRIVATE KEY-----",
    ],
    expect: { tier: "MandatoryRedaction", types: ["privateKey", "ipAddress", "genericSecret"] },
  },
  {
    name: "app-secrets.json", kind: "text",
    what: "Leaked secrets file — OpenAI, GitHub, Slack and AWS keys",
    lines: [
      "{",
      '  "openai_api_key": "sk-proj-Zx81TestOnlyNotARealKey000000000000",',
      '  "github_token": "ghp_TestOnlyNotARealToken0000000000000000",',
      '  "slack_bot_token": "xoxb-000000000000-TestOnlyNotReal",',
      '  "aws_access_key_id": "AKIAZZZZZZZZZZZZZZZZ",',
      '  "region": "ap-south-1"',
      "}",
    ],
    expect: { tier: "MandatoryRedaction", types: ["apiKey", "awsKey"] },
  },
  {
    name: "support-tickets.json", kind: "text",
    what: "Helpdesk export — card number, email, phone",
    lines: [
      "[",
      '  { "ticket": 5012, "customer": "m.shah@example.in", "phone": "9988776655",',
      '    "issue": "Double charge on card 5555 5555 5555 4444, please refund" },',
      '  { "ticket": 5013, "customer": "a.rao@example.in", "phone": "9876501234",',
      '    "issue": "Cannot reset password" }',
      "]",
    ],
    expect: { tier: "MandatoryRedaction", types: ["cardNumber", "email", "phone"] },
  },
  {
    name: "term-sheet-notes.md", kind: "text",
    what: "Deal notes — legal, strategy and IP terms (no personal data)",
    lines: [
      "# Series B — working notes",
      "",
      "- Term sheet received from lead investor; pre-money valuation still open.",
      "- Due diligence starts next week; data room access for their counsel.",
      "- Mutual NDA signed. Governing law: India, with an arbitration clause in Bengaluru.",
      "- Letter of intent to follow once the cap table is final.",
      "- Their technical DD wants the proprietary algorithm walkthrough; patent pending status to confirm.",
    ],
    expect: { tier: "Warn", types: ["legalTerm", "corporateStrategyTerm", "ipTerm"] },
  },
  {
    name: "hr-case-notes.txt", kind: "text",
    what: "HR case notes — PIP, severance, exit interview",
    lines: [
      "Case: Sales team, Q3",
      "",
      "Employee was placed on a performance improvement plan in July.",
      "Outcome discussed with manager (manager.ops@example.in).",
      "If no improvement by October, proceed with severance per policy",
      "and schedule the exit interview. Notice period buyout approved.",
    ],
    expect: { tier: "Warn", types: ["hrTerm", "email"] },
  },
  {
    name: "board-memo.docx", kind: "docx",
    what: "Word document — confidential marker + strategy terms",
    lines: [
      "Board memo — October",
      "Strictly confidential. Not for distribution.",
      "Board minutes from the last session are attached.",
      "The acquisition target shortlist is down to two companies.",
      "Revenue forecast and burn rate are on slide 4 of the board deck.",
    ],
    expect: { tier: "Warn", types: ["confidentialityMarker", "corporateStrategyTerm"] },
  },
  {
    name: "access.log", kind: "text",
    what: "Server log — internal IPs and user emails",
    lines: [
      '10.0.3.21 - - [24/Sep/2026:10:02:11] "POST /login HTTP/1.1" 200 user=r.nair@example.in',
      '10.0.3.21 - - [24/Sep/2026:10:02:15] "GET /reports HTTP/1.1" 200',
      '192.168.1.44 - - [24/Sep/2026:10:05:40] "POST /login HTTP/1.1" 401 user=s.iyer@example.in',
      '172.16.8.9 - - [24/Sep/2026:10:06:02] "GET /health HTTP/1.1" 200',
    ],
    expect: { tier: "Warn", types: ["ipAddress", "email"] },
  },
  {
    name: "northstar-update.md", kind: "text",
    what: "Custom keyword only — clean until 'Project Northstar' is added in the dashboard",
    lines: [
      "# Weekly update",
      "",
      "Project Northstar is on track for the pilot in November.",
      "The design review moved to Thursday; nothing blocking.",
    ],
    expect: { tier: null, types: [] },
    withKeywords: { keywords: ["Project Northstar"], tier: "Warn", types: ["customKeyword"] },
  },
  {
    name: "offsite-budget.txt", kind: "text",
    what: "Honeytoken hidden in ordinary notes — confirmed leak",
    lines: [
      "Offsite budget, rough numbers",
      "",
      "Venue: about the same as last year.",
      "Travel: trains where possible.",
      "Sheet ref ACME-HT-9F3K2Q (copied from the finance workbook).",
    ],
    expect: { tier: "MandatoryRedaction", types: ["honeytoken"], leak: true },
  },
  {
    name: "near-misses-clean.txt", kind: "text",
    what: "False-positive check — looks risky, contains nothing sensitive",
    lines: [
      "Add the release to the agenda for Monday's sync.",
      "Invoice reference 1234567890123456 was raised yesterday.",
      "Order number 100200300 shipped on the 3rd.",
      "Version 2.10.4 is live on staging; the build took 1234 seconds.",
      "Our public DNS resolver is 8.8.8.8.",
      "Write to the team at the usual channel, not by email.",
    ],
    expect: { tier: null, types: [] },
  },
];

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */
function render(file) {
  if (file.kind === "pdf") return buildPdf(file.lines);
  if (file.kind === "docx") return buildDocx(file.lines);
  return text(file.lines);
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("\nPattern test files → demo-files/pattern-tests/\n");

  const D = require("../extension/src/core/detector.js");
  let allGood = true;

  for (const file of FILES) {
    fs.writeFileSync(path.join(OUT, file.name), render(file));

    const checks = [["default", file.expect, []]];
    if (file.withKeywords) checks.push(["+keyword", file.withKeywords, file.withKeywords.keywords]);

    for (const [label, exp, keywords] of checks) {
      D.reset();
      D.setHoneytokens(["ACME-HT-9F3K2Q"]);
      if (keywords.length) D.setCustomKeywords(keywords);
      const r = D.scan(file.lines.join("\n"));
      const ok = r.overallTier === exp.tier &&
        exp.types.every((t) => r.patternTypes.includes(t)) &&
        r.confirmedLeak === !!exp.leak;
      if (!ok) allGood = false;
      console.log(`  ${ok ? "ok  " : "FAIL"} ${file.name.padEnd(24)} ${label.padEnd(9)} ` +
        `${String(r.overallTier || "clean").padEnd(19)} ${r.patternTypes.join(", ")}`);
    }
  }

  console.log(allGood ? "\nAll pattern files behave as expected.\n" : "\nSome files did not match their expected verdict.\n");
  process.exitCode = allGood ? 0 : 1;
}

module.exports = { FILES };
