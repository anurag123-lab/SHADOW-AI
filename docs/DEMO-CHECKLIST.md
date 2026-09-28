# Demo checklist (one page)

Full script and talking points: [DEMO.md](DEMO.md). This is the tick-list.

## 30 minutes before

- [ ] `npm test` → **114 passing**
- [ ] `npm run preflight` → **"Everything ready"**
- [ ] Dashboard policies reset: **Email = Warn** (you flip it live in step 5), **Confidentiality marker = Warn** if you want the CSV/Warn demos to stay Warn
- [ ] Honeytoken `ACME-HT-9F3K2Q` listed in the dashboard
- [ ] Approved AI tool saved in the dashboard (shows as "Use … instead")
- [ ] Notifier running in a visible terminal: `npm run notifier`
- [ ] Extension popup shows **Active**, company name, join code `783755EA`
- [ ] Tabs open: ChatGPT (logged in), dashboard (admin, Ctrl+Shift+R), `demo-files/` folder
- [ ] Backup ready: `dashboard/offline-preview.html` in case wifi dies

## On stage (≈7 min)

| # | Do | Type / drag | Expect |
|---|---|---|---|
| 1 | Problem, 30s, no slides | — | — |
| 2 | Warn tier (ChatGPT) | `Can you write a follow-up to this customer? Contact priya@acme.com or 9876543210` | Popup with **Send anyway**, **Use approved tool**, redacted preview shows `jane.doe@example.com` / `98765 43210` |
| 3 | Mandatory tier | `Here is the key to debug with: sk-proj-abc123XYZ456def789GHI012jkl` | No "Send anyway" — show in devtools it isn't in the DOM |
| 4 | Card number | `refund card 4111 1111 1111 1111` | Mandatory; redacts to `4242 4242 4242 4242` |
| 5 | Live policy | Dashboard: Email → Mandatory. Back in ChatGPT (**no reload**): `send it to rahul.verma@clientco.in` | Now mandatory, within seconds |
| 6 | Honeytoken | `the reference on that sheet was ACME-HT-9F3K2Q` | Confirmed leak; alert email arrives from notifier |
| 7 | File, blocked | Drag `Q3-forecast-CONFIDENTIAL.pdf` | Upload blocked, reasons listed |
| 8 | File, warn | Drag `customer-export.csv` | Warn: emails + phones found, **Upload anyway** available |
| 9 | File, clean | Drag `team-offsite-notes.pdf` | Uploads with no interruption |
| 10 | Dashboard | Refresh | Tiles, departments, patterns, compliance, discovered tools, anonymous `emp_…` IDs |
| 11 | Close on proof | `supabase/migrations/001_initial_schema.sql` CHECK constraints; RLS on `employee_profiles` | "The privacy guarantee is a database constraint, not a promise" |

Optional extras if time allows: same text on **Claude** or **Gemini**; `server-notes.txt` (AWS key + IPs → blocked); a second Chrome profile with another email on join code `783755EA` showing up as a new anonymous ID.

## Pattern test files (`demo-files/pattern-tests/`)

Wider sweep for rehearsal or Q&A: drag any file into ChatGPT, Claude or Gemini. Together they cover all 19 pattern types. Regenerate with `npm run demo:patterns`; `npm test` checks them.

| File | What's inside | Default | With your current policy* |
|---|---|---|---|
| `payroll-march.csv` | PAN, IFSC, CTC, phone, email | Blocked | Warn |
| `vendor-invoice.pdf` | GSTIN, IFSC, email, phone | Warn | Warn |
| `patient-referral.pdf` | Health terms (ICD-10, medical history), phone, email | Warn | Warn |
| `prod-deploy.yaml` | Private key, internal IPs, random DB password | Blocked | Blocked |
| `app-secrets.json` | OpenAI / GitHub / Slack / AWS keys | Blocked | Blocked |
| `support-tickets.json` | Card number, email, phone | Blocked | Blocked |
| `term-sheet-notes.md` | Legal, strategy and IP terms | Warn | Warn |
| `hr-case-notes.txt` | PIP, severance, exit interview, email | Warn | Warn |
| `board-memo.docx` | "Strictly confidential" + strategy terms | Warn | Blocked |
| `access.log` | Internal IPs, user emails | Warn | Warn |
| `northstar-update.md` | Custom keyword only | Clean | Clean → **Warn after adding "Project Northstar"** as a keyword |
| `offsite-budget.txt` | Honeytoken `ACME-HT-9F3K2Q` | Confirmed leak | Confirmed leak + alert email |
| `near-misses-clean.txt` | Looks risky, isn't (agenda, non-Luhn number, public IP) | Clean | Clean — uploads straight through |

\*Current dashboard policy has **PAN = Warn** and **Confidentiality marker = Mandatory**; that's what changes the two rows.

## After

- [ ] Set **Email** back to **Warn** in the dashboard
