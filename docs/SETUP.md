# Shadow AI Guard — Setup

Do these in order. Steps 1–3 are yours (console clicking); everything else is already in the repo.

---

## 1. Create the Supabase project (5 min)

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Name it `shadow-ai-guard`, pick a region close to you, set a database password (save it somewhere).
3. Wait for provisioning (~2 min).
4. Go to **Project Settings → API** and copy these two values:

   | Value | Where it goes | Safe to ship? |
   |---|---|---|
   | **Project URL** (`https://xxxx.supabase.co`) | extension + dashboard + notifier | Yes |
   | **anon / public key** | extension + dashboard | **Yes** — RLS is the access control, not this key |
   | **service_role key** | `notifier/.env` ONLY | **No. Never.** It bypasses RLS entirely |

> If the service_role key ever ends up in the extension or dashboard, every company's data is readable by anyone who opens devtools. It exists only so the notifier can send email across all tenants.

---

## 2. Run the migrations (2 min)

In the Supabase dashboard → **SQL Editor** → **New query**. Run these files **in order**, one at a time, pasting the whole contents of each:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_functions.sql`
3. `supabase/migrations/003_row_level_security.sql`
4. `supabase/migrations/004_entropy_detection.sql` — high-entropy secret detection type
5. `supabase/migrations/005_restrict_profile_updates.sql` — admins can't change their own role, company or join code
6. `supabase/migrations/006_company_members.sql` — team roster (email + join date, no anonymous ID)
7. `supabase/migrations/007_realtime_config_tables.sql` — keywords, honeytokens and approved tool push to extensions live

Each should report `Success. No rows returned`. All are safe to re-run. For 005–007 Supabase may warn about "destructive operations" (`REVOKE`, `DROP ... IF EXISTS`); they only touch objects the file itself manages — choose **Run query**.

> **Expect an RLS warning between 001 and 003.** After 001, Supabase's linter will flag every table with *"RLS has not been enabled"*. That is correct and temporary — `001` creates the tables, `003` turns RLS on and adds the policies. Just run all three.
>
> You can click "Enable RLS" in the dashboard if you prefer; it's harmless and `003` is idempotent. But **enabling RLS without policies denies all access** — it's a safe state, not a working one. You still have to run `002` and `003`, in that order (the policies in 003 call the functions defined in 002).

**Verify it worked** — run `supabase/verify.sql` in the SQL editor. It reports table count, RLS status, policy count per table, and whether all 14 functions exist, with the expected values inline.

Or the quick version:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

You should see exactly: `admin_profiles`, `companies`, `custom_keywords`, `discovered_tools`, `employee_profiles`, `flagged_events`, `honeytokens`, `policies`.

**Verify the privacy constraint is live** — this insert MUST fail:

```sql
-- Attempts to smuggle a message into the pattern_types array.
insert into flagged_events (company_id, employee_hash, ai_tool, risk_level, action, pattern_types)
values (gen_random_uuid(), 'emp_0123456789abcdef', 'chatgpt.com', 'High', 'redacted',
        '["my card number is 4111 1111 1111 1111 and my PAN is ABCDE1234F"]'::jsonb);
```

Expected: `new row for relation "flagged_events" violates check constraint`. That error **is** Feature 20 working. (It will also fail the foreign key if the company doesn't exist — either error proves the point, but the check constraint is the one to show.)

---

## 3. Configure Auth (10 min)

### 3a. Email/password — no setup needed
Already enabled by default. For the demo, turn **off** email confirmation so accounts work instantly:
**Authentication → Providers → Email** → disable *Confirm email* → Save.

### 3b. Google OAuth — OPTIONAL, not yet configured

> **Status: deferred.** The code is finished and tested (8/8 auth scenarios,
> including OAuth return, first-login, implicit token and error paths).
> The button is live on the login page but will fail until the two consoles
> below are configured. **Email/password works without any of this** and is
> the recommended demo path.

When you want to enable it:

**Google Cloud** — [console.cloud.google.com](https://console.cloud.google.com)

1. Create/select a project → **APIs & Services → OAuth consent screen** → **External**
   - Fill in app name + support email
   - Under **Test users**, add the Google account you'll demo with. While the
     app is unpublished, only listed testers can sign in.
2. **Credentials → Create Credentials → OAuth client ID → Web application**
3. **Authorized redirect URIs** — add exactly this, no trailing slash:

```
https://rmqtazdvmbyzbnaokkmw.supabase.co/auth/v1/callback
```

4. Copy the **Client ID** and **Client Secret**

**Supabase** — Authentication → Sign In / Providers → **Google**

5. Enable it, paste Client ID + Secret, Save
6. Authentication → **URL Configuration**:
   - Site URL: `http://localhost:5500`
   - Redirect URLs: `http://localhost:5500/**`  ← the `/**` wildcard is required

**For the extension too** (separate redirect): load the extension, copy its ID
from `chrome://extensions`, then add `https://<EXTENSION_ID>.chromiumapp.org/**`
to the same Supabase redirect list.

**Verify:** hard-refresh the dashboard, click *Continue with Google*.
A `redirect_uri_mismatch` means the URI in step 3 doesn't match exactly.
Any other failure now surfaces as a message on the page rather than
silently doing nothing.

---

## 4. Point the code at your project

Put your three values in **`.env`** at the project root, then run one command.

```bash
cp .env.example .env     # then edit .env — NOT .env.example
npm run sync-config
```

`.env` needs these three:

```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=eyJ...          # anon / public
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # service_role
```

> **`.env.example` is the template, not the config.** Editing it has no effect — and it isn't git-ignored, so real keys don't belong there. Only `.env` is read, and only `.env` is ignored.

`sync-config` writes each value where it belongs:

| Destination | Gets | Why |
|---|---|---|
| `extension/src/core/config.js` | URL + **anon** key | An extension has no build step; values must be in source |
| `dashboard/assets/config.js` | URL + **anon** key | Same — static HTML, no bundler |
| `notifier/.env` | URL + **service_role** key | The only place that key may ever appear |

It **decodes both JWTs and reads their `role` claim** before writing anything. If the service_role key is in the anon slot, it refuses and tells you to swap them — that mistake would otherwise ship a key that bypasses row-level security to every browser.

Re-run it whenever the keys change.

You can also set the URL and anon key at runtime from the extension's options page, without editing files — useful when demoing from someone else's machine.

---

## 5. Load the extension

1. Chrome → `chrome://extensions` → toggle **Developer mode** on.
2. **Load unpacked** → select the `extension/` folder.
3. Copy the **ID** shown on the card — that's `<EXTENSION_ID>` for step 3b.6.
4. Go back and finish step 3b.6, then reload the extension.

---

## 6. Create your admin account + company

1. Serve the dashboard: `npm run serve:dashboard` → open <http://localhost:5500>.
2. Sign up with email/password (or Google).
3. On first login you'll be asked for a **company name**. This calls `create_company_and_admin()`, which creates the company, makes you its owner, and seeds the 17 default policies.
4. The dashboard shows a **join code** (e.g. `A1B2C3D4`). Employees enrol with this.

---

## 7. Enrol the employee side

1. Click the extension icon → **Sign in** (Google or email/password).
2. Paste the join code → pick a department → **Join**.
3. The extension calls `join_company_as_employee()`, receives an opaque `employee_hash`, and caches it.

---

## 8. Notifier (email alerts)

```bash
cd notifier
npm install
cp ../.env.example .env     # then fill it in
node index.js
```

For SMTP, [Mailtrap](https://mailtrap.io) sandbox is recommended for demos — it captures mail in a web inbox instead of sending to real people. Sign up, create an inbox, copy the SMTP credentials into `.env`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `invalid join code` | Codes are uppercase; the RPC uppercases input, but check for stray spaces |
| Google sign-in: `redirect_uri_mismatch` | Step 3b.6 not done, or extension ID changed after reload |
| Extension signs in but events don't appear | RLS is rejecting the insert — the employee hasn't enrolled, so `current_employee_hash()` is null |
| Dashboard shows nothing | You're signed in as an employee, not an admin. Admins can read events; employees cannot (by design) |
| `violates check constraint` on insert | Working as intended — see step 2 |
