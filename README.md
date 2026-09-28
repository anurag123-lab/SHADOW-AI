# Shadow AI Guard

Catches sensitive company data **before** it reaches an AI tool — and proves it never collected the data it was protecting.

Detection runs entirely in the employee's browser. Nothing the employee types or attaches is ever transmitted. What reaches the backend is the *category* of what was found, never the content — and that guarantee is enforced by the database schema, not by a promise in the application code.

---

## What it does

| | |
|---|---|
| **Detects** | 17 pattern types (regex + keyword) plus company-defined keywords and honeytokens, scanned locally on typed text and on PDF/.docx/.txt attachments |
| **Responds** | Two tiers: *Warn* (redact / send anyway / flag as false positive) and *Mandatory redaction* (no override, and the override button is not in the DOM) |
| **Configures** | IT sets the enforcement tier per pattern type from a dashboard; changes reach every extension within seconds over a websocket |
| **Reports** | Anonymised dashboard — department heatmap, compliance exposure, shadow-tool discovery, false-positive tuning signal, repeated-override escalation, plain-language weekly digest |
| **Guarantees** | `flagged_events` has no column capable of holding message or file content. Admins are denied read access to the table that maps an anonymous ID to a person |

---

## Repository layout

```
extension/          Manifest V3 browser extension (vanilla JS, no build step)
  src/core/           detector, patterns, payload builder, Supabase client  <- unit-tested
  src/content/        content script, interstitial UI, file scanner, discovery
  src/background/     service worker (auth, config sync, event queue)
  src/ui/ src/options/ popup and options page
  vendor/             pdf.js + mammoth.js, bundled (MV3 forbids CDN script)
  tests/              53 Node tests, zero dependencies

dashboard/          IT dashboard (plain HTML/JS + Chart.js via CDN, no build step)
supabase/migrations/  schema, functions, row-level security
notifier/           Node scripts: critical-event alerts + weekly digest
scripts/            icon generator, vendor fetcher, dev server, demo seeder
docs/               setup and demo guides
```

---

## Quick start

```bash
# 1. Tests — run these first; they need nothing but Node 20+
npm test

# 2. Bundle the PDF/.docx libraries (one time)
node scripts/fetch-vendor.js

# 3. Backend — follow docs/SETUP.md steps 1-3 (Supabase project + migrations + auth)

# 4. Paste your project URL and anon key into:
#      extension/src/core/config.js
#      dashboard/assets/config.js

# 5. Dashboard
npm run serve:dashboard        # http://localhost:5500

# 6. Extension
#    chrome://extensions -> Developer mode -> Load unpacked -> select extension/

# 7. Optional: demo data and email alerts
node scripts/seed-demo-data.js --list
node scripts/seed-demo-data.js --company <uuid> --events 120
cd notifier && npm install && node index.js
```

Full instructions, including Google OAuth setup: **[docs/SETUP.md](docs/SETUP.md)**
Demo run-of-show: **[docs/DEMO.md](docs/DEMO.md)**

---

## Architecture

```
  Employee's browser                          Supabase                    IT
  ─────────────────                           ────────                    ──
  ┌───────────────────────┐
  │ detector.js           │  100% local. No network in the detection path.
  │  patterns + honeytokens│
  │  tier resolution       │
  └──────────┬────────────┘
             │  flagged? show the interstitial, employee decides
             ▼
  ┌───────────────────────┐   metadata only    ┌──────────────┐   RLS-scoped   ┌───────────┐
  │ event-payload.js      │ ─────────────────► │  Postgres    │ ─────────────► │ dashboard │
  │  allow-list builder   │   (category, tool, │  + RLS       │                │  charts   │
  └───────────────────────┘    dept, action,   │  + Realtime  │ ◄───────────── │  policy   │
                               anonymous ID)   └──────┬───────┘   policy write  └───────────┘
             ▲                                        │
             └──────── policy push (websocket) ───────┘
                                                      │ service_role
                                                      ▼
                                              ┌───────────────┐
                                              │ notifier      │ SMTP alerts + digest
                                              └───────────────┘
```

**Why no backend API layer.** Row-level security already scopes every query to the signed-in admin's own company. A pass-through Express server would add a network hop and a second place for an authorisation bug to live, while enforcing the same rules Postgres is already enforcing.

---

## The privacy claim, and how to check it

Most DLP tools ask you to trust that they discard what they inspect. This one is built so you don't have to:

1. **Run `npm test`.** Twelve tests in `extension/tests/privacy.test.js` take a message full of card numbers, PANs, keys and honeytokens through the real detection and payload path, then assert that every string in the resulting payload comes from a **closed vocabulary fixed at build time**. A payload that can only contain pre-declared tokens cannot contain a message.

2. **Read `supabase/migrations/001_initial_schema.sql`.** Every text column is either length-capped or restricted to a closed value set. The JSONB arrays are constrained by `jsonb_is_short_text_array()` so they cannot hold prose. You can verify the claim from the schema alone, without reading any application code.

3. **Try to break it.** The insert in [docs/SETUP.md](docs/SETUP.md) step 2 attempts to smuggle a message into `pattern_types`. Postgres rejects it.

4. **Check who can de-anonymise.** `employee_profiles` — the only table linking an auth identity to an `employee_hash` — has no admin read policy. The customer's own IT admin cannot perform that join.

---

## Known limitations

Stated plainly, because a security tool that overstates its coverage is worse than one that doesn't:

- **Scanned/image PDFs are not scanned.** Text extraction needs OCR, which is out of scope. These fail *open*: the upload proceeds with a visible notice rather than a silent block.
- **Unsupported formats (.xlsx, .pptx, images) are not scanned.** Same fail-open behaviour.
- **Drag-and-drop resume is best-effort.** After a clean scan we rebuild a `DataTransfer` and re-dispatch the drop; some sites read the original React synthetic event, which can't be reproduced exactly. When it fails the user is told to re-attach. File-input uploads resume reliably.
- **Honeytoken values reach the client.** Local detection requires the literal strings, so a determined employee could read them from extension storage. Server-side matching would fix this but would require transmitting content — which would defeat the entire design.
- **Detection is pattern-based, not semantic.** It will not catch sensitive information paraphrased in ordinary prose. It is a guardrail against accidental paste-and-send, not an adversary-proof control.
- **Compliance framework tags are a triage signal, not a legal determination.** This is stated in the UI, the emails, and the dashboard.
