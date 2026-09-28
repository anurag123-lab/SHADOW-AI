# Demo run-of-show

Seven minutes, in the order that makes the argument land. The claim you're making is not "we detect card numbers" — everyone detects card numbers. The claim is **"we protect the data without collecting it, and you can verify that."** Structure the demo so the last thing judges see is the proof, not the charts.

---

## Before you start

```bash
npm run preflight      # checks everything below that a script can check
```

It reports blocking issues separately from optional ones, and prints the fix for each. Then, by hand:

- [ ] Extension loaded, signed in, enrolled, showing **Active**
- [ ] Dashboard open in a second tab, signed in as admin, seeded (`node scripts/seed-demo-data.js --list`)
- [ ] Honeytoken `ACME-HT-9F3K2Q` added in the dashboard — **the demo PDF contains it**
- [ ] `notifier/` running in a visible terminal (`node index.js`), or `DRY_RUN=1` so alerts print to console
- [ ] ChatGPT open and logged in
- [ ] **Backup:** `dashboard/offline-preview.html` works with no network, if the venue wifi dies

### Demo files (`demo-files/`, regenerate with `npm run demo:files`)

| File | What it demonstrates |
|---|---|
| `Q3-forecast-CONFIDENTIAL.pdf` | **Blocked.** Card number, confidentiality marker, strategy terms — *and the honeytoken*, so this one lands as a confirmed leak |
| `team-offsite-notes.pdf` | **Uploads through.** Proves the tool isn't just a wall — show this one too |
| `server-notes.txt` | **Blocked.** AWS key + internal IPs, no library involved in extraction |
| `customer-export.csv` | **Warn.** Emails and phones in bulk; "upload anyway" is available |

All four are verified end-to-end (real pdf.js extraction → real detector) by `npm run preflight`.

---

## 1. The problem (30s — no slides)

> "Your employees are pasting customer data, contracts and API keys into ChatGPT right now. Your firewall can't see it, because it's inside an HTTPS session to a site you've already approved. And the two available fixes are both bad: block AI tools and people use their phones, or allow them and hope."

---

## 2. Tier 1 — the employee's experience (60s)

Type into ChatGPT:

```
Can you write a follow-up to this customer? Contact priya@acme.com or 9876543210
```

(Keep a card number out of this one — cards are Mandatory, which removes the "Send anyway" button this step is about.)

Press Enter. The interstitial appears.

**Say while it's on screen:**
> "Three things to notice. It tells you *what* it found in plain English, not a risk score. It shows you exactly what will be sent instead. And 'Send anyway' is right there — this is a guardrail, not a cage. Anything that fights the employee gets uninstalled."

Click **Send redacted version**. The redacted message sends.

---

## 3. Tier 2 — where there's no override (45s)

Type:

```
Here's the key to debug with: sk-proj-abc123XYZ456def789GHI012jkl
```

**Say:**
> "A live API key isn't a judgement call, so this tier has one button. And the override isn't hidden with CSS —"

**Open devtools, inspect the modal.** Show that no "Send anyway" element exists in the DOM.

> "— it was never rendered. There's nothing to un-hide."

---

## 4. The policy engine, live (45s)

Switch to the dashboard → **Policy engine**. Change **Email address** from *Warn* to *Mandatory redaction*.

Switch back to ChatGPT (**do not reload the page**). Type an email address and press Enter.

**Say:**
> "That's a websocket push. No redeploy, no extension update, no waiting. IT changes the rule and every browser in the company has it a second later."

---

## 5. Honeytokens — certainty, not probability (45s)

Type:

```
the reference on that sheet was ACME-HT-9F3K2Q
```

**Say:**
> "That string exists in exactly one place: a document we planted it in. It's not a pattern that *might* be sensitive — a match means internal content reached this input box. That's a confirmed leak, and no policy setting can downgrade it. There's a unit test that sets a hostile policy specifically trying to weaken it, and asserts it can't be done."

Switch to the notifier terminal — the alert email is already there.

---

## 6. Files (45s — do both halves)

Drag `demo-files/Q3-forecast-CONFIDENTIAL.pdf` into ChatGPT. Upload is intercepted, text extracted, the block screen names what's inside and what to do.

**Say:**
> "Same detector, new input — one detection path, not two. We don't auto-redact files; rewriting someone's PDF is a promise we'd break. So for files it's an honest block with instructions."

**Then drag in `team-offsite-notes.pdf`.** It uploads with no interruption.

> "And that's the half that matters more. It read the file, found nothing, and got out of the way."

---

## 7. The dashboard (45s)

Walk the top row of tiles, then the department heatmap and discovered tools.

**Say:**
> "Discovered tools is the one IT usually can't answer at all: which AI tools are people actually using? Twelve sites are tracked passively — a visit signal, once per tool per day, no content inspection."

---

## 8. Close on the proof (60s — the part that wins it)

> "Everything you've seen depends on one claim: that we protect this data without collecting it. Most tools ask you to trust that. Here's why you don't have to."

**Three things, in this order:**

**a. The schema.** Open `001_initial_schema.sql`. Point at the `CHECK` constraints.
> "There is no column in this database capable of holding a message. Every text field is either length-capped or restricted to a fixed list of values."

**b. Break it on stage.** In Supabase's SQL editor, run the insert from `docs/SETUP.md` step 2 that tries to smuggle a message into `pattern_types`. Postgres rejects it.
> "That error is the feature."

**c. Who can de-anonymise.** Point at `employee_profiles` in the RLS file.
> "This is the only table linking a person to their anonymous ID. Admins have no read policy on it. Not 'we choose not to look' — the customer's own IT admin *cannot* make that join. The dashboard shows `emp_4f2a9c...` and there is no query that turns it into a name."

**Land it:**
> "Detection runs locally, enforcement is configurable from a dashboard, and the privacy guarantee is a database constraint instead of a promise. That's the whole product."

---

## Questions you should expect

**"What stops someone just disabling the extension?"**
Nothing, and we don't claim otherwise — this is a guardrail against accidental paste-and-send, which is the overwhelming majority of real incidents. In production it's deployed via enterprise policy, which prevents removal. Honeytokens are the backstop: if content leaves by any route, a match proves it.

**"What about paraphrasing? I could describe the contract instead of pasting it."**
Correct, and out of scope for pattern matching. Semantic detection would require sending content to a model — which would defeat the design. We chose the guarantee.

**"How do you know the false-positive rate is acceptable?"**
There's a 55-sentence benign corpus in the test suite that must produce zero flags, including deliberate near-misses — "agenda" against the `nda` rule, a 16-digit invoice number against the card rule. Card numbers are Luhn-validated, not just shape-matched. And the feedback loop turns disagreement into a tuning signal on the dashboard.

**"Is this GDPR/HIPAA compliant?"**
The framework tags are a triage signal to help prioritise, not a legal determination — we say that in the UI, in the emails, and on the dashboard. Claiming otherwise would be the fastest way to lose a security buyer's trust.
