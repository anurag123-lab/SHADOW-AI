# Shadow AI Guard

**Use AI freely. Leak nothing.**

Shadow AI Guard is a browser extension and IT dashboard that stops sensitive company data from being pasted or uploaded into AI tools like ChatGPT, Claude and Gemini. It inspects text and files inside the browser, before they are sent, and either warns the employee or automatically redacts the risky part. IT sees trends and incidents on a dashboard, but never the content itself.

> Built for **Tech Horizon 2.0** · Theme: **Security & Surveillance**

---

## The problem

Employees use AI chatbots every day for drafting, debugging and summarising. Along the way they paste customer records, API keys, contracts and internal documents into tools the company does not control. Once sent, that data cannot be taken back. Most companies cannot see it happening, and banning AI tools mostly just pushes usage out of sight.

## What Shadow AI Guard does

- **Inspects before sending.** Text is scanned as it is typed, and files (PDF, DOCX, TXT/CSV) are scanned before the upload completes.
- **Responds proportionally.** Minor risks get a warning the employee can override. Serious risks force redaction, but the employee can still use the AI tool.
- **Gives IT visibility without surveillance.** The dashboard shows which teams, tools and data types are involved. It cannot show what anyone typed, because the database has no column that could hold it.

## How it works

```
Employee types / uploads
        │
        ▼
Browser extension (runs 100% locally)
  detect → resolve tier (Warn / Mandatory Redaction) → show popup
        │
        │  metadata only (pattern type, risk, tool, action; never content)
        ▼
Supabase (Postgres + Auth + Realtime)
        │
        ▼
IT dashboard (charts, policy engine, honeytokens, keywords)
```

Detection is deterministic pattern matching (regex, keywords, exact-match honeytokens). **No AI model is involved in detection**, which keeps it instant, private, auditable and free of per-check cost.

## Features

**Detection**
- Real-time detection on typed text
- File scanning for PDF (pdf.js), DOCX (mammoth.js) and TXT/CSV, using the same detector as typed text
- Credentials and secrets: API keys, AWS keys, private keys
- Financial and identity data: card numbers, PAN, IFSC, GSTIN
- Business-document signals: confidentiality markers, legal/NDA terms, HR and compensation terms, M&A and corporate-strategy terms, IP terms
- Company-specific keywords (client names, project codenames)
- **Honeytokens**: planted fake identifiers whose appearance proves a real leak

**Response**
- **Tier 1 (Warn):** redact, send anyway, or mark as a false positive with a reason
- **Tier 2 (Mandatory Redaction):** redact-and-send only, with no override
- **Files:** warn-and-upload or block-with-explanation (files are never rewritten)
- Explanation screen that says what was found and why

**Control and visibility (IT)**
- Live policy engine: set each pattern type to Warn or Mandatory Redaction, with changes pushed to extensions
- AI-tool discovery for tools employees use that IT may not know about
- Compliance tagging (GDPR / PCI DSS / HIPAA / internal policy)
- Department heatmap, false-positive feedback, repeated-override tracking
- Email alerts and weekly digest
- Sanctioned-tool redirect: one click to copy the prompt and open the company's approved AI tool

**Privacy by design**
- Detection and redaction happen on the employee's device
- Only metadata is logged, and the schema physically excludes message and file content

## Tech stack

| Part | Technology |
|---|---|
| Extension | Vanilla JavaScript, Manifest V3 (no build step) |
| Detection engine | Regex + keyword matching, dependency-free |
| File extraction | pdf.js, mammoth.js, FileReader (bundled locally) |
| Backend and auth | Supabase (Postgres, Row Level Security, Realtime), email + OTP login |
| Alerts | Node.js + nodemailer (SMTP) |
| Dashboard | HTML / Tailwind CSS / JavaScript, Chart.js, Supabase JS client |

## Repository structure

> Adjust folder names to match your repo.

```
/extension      Manifest V3 browser extension
  /vendor       pdf.js and mammoth.js (bundled; MV3 blocks CDN scripts)
/dashboard      IT-facing web app (landing page + admin dashboard)
/supabase       SQL migrations and Row Level Security policies
/notifier       Node script for alert and digest emails
/demo-files     Sample files for the demo (including a honeytoken PDF)
```

## Getting started

### 1. Backend (Supabase)
1. Create a Supabase project.
2. Run the SQL in `/supabase/migrations` (tables and Row Level Security policies).
3. Enable email login and configure the OTP email template.
4. Copy the project URL and `anon` key.

### 2. Dashboard
1. Put your Supabase URL and `anon` key in the dashboard config.
2. Serve the folder locally (e.g. `python -m http.server`) or deploy it to any static host.
3. Sign in as an admin and create your company.

### 3. Extension
1. Put the same Supabase URL and `anon` key in the extension config.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `/extension` folder.
4. Sign in from the extension popup.

### 4. Notifier (optional)
```bash
cd notifier
npm install
cp .env.example .env   # add SMTP credentials (Mailtrap works well for demos)
node index.js
```

Use the `service_role` key only in server-side scripts like this one. It must never appear in the extension or dashboard.

## Demo walkthrough

1. **Warn:** type a phone number or email into ChatGPT. The Tier 1 popup offers redact or send anyway.
2. **Mandatory redaction:** paste an API key or card number. Only "Redact and Send" is offered.
3. **File scan:** upload `demo-files/Q3-forecast-CONFIDENTIAL.pdf`. The extension reads it and reacts.
4. **Honeytoken:** in the dashboard, add `ACME-HT-9F3K2Q` under Detection configuration → Honeytokens. Upload the same PDF again and it is flagged as a confirmed leak.
5. **Policy engine:** change a pattern from Warn to Mandatory Redaction in the dashboard and retry.
6. **Dashboard:** show the incident, department heatmap, discovered tools and compliance breakdown.

## Design decisions and honest limitations

- **Content-level, not network-level.** This is not a network firewall. It inspects data at the point of entry, before encryption, which avoids SSL interception. It is one channel (GenAI tools) that complements endpoint, email and cloud DLP rather than replacing them.
- **A governance tool, not a hard security boundary.** A determined insider can disable a browser extension. The goal is to catch careless and accidental leaks and give IT visibility.
- **Pattern matching has limits.** It can miss context-dependent secrets and can produce false positives. The card-number detector should use a Luhn check, and entropy-based secret detection is a natural next step.
- **Files are detected, not redacted.** Rewriting a PDF or DOCX safely is out of scope, so files are warned about or blocked and the employee edits the original.
- **Scanned or image-only PDFs are not supported** (they would need OCR). Unsupported types are allowed through and logged, never silently blocked.
- **Drag-and-drop resume is best-effort** across sites. Click-to-attach is the reliable path.
- **Input handling differs by site.** ChatGPT uses a plain textarea; Claude and Gemini use `contenteditable` editors that can resist programmatic text changes. Test redaction on each.
- **Client-side only for now.** Managed deployment (enterprise browser policy) and server-side verification are future work.

## Roadmap

- Luhn validation and entropy scoring to cut false positives
- Send-button and Enter-key interception in addition to the typing debounce
- ML-based document classification as a secondary layer
- OCR for scanned PDFs
- SSO (Google Workspace / Azure AD) using opaque subject IDs
- Managed rollout via enterprise browser policy
