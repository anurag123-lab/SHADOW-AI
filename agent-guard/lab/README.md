# Shadow AI Guard — try it on your own laptop

This lab is a small fake "company project" full of **fake** secrets: API keys,
a `.env` file, customer card numbers, a confidential board memo. You open it in
an AI coding tool, ask the AI to read things, and watch Shadow AI Guard stop the
sensitive data **before it reaches the AI**. Every decision also appears on the
company dashboard, without the secret itself.

Nothing in the lab is real. You can delete it at any time.

---

## 1. What you need

- **Node.js 18 or newer**: <https://nodejs.org> (check with `node -v`)
- **git**: <https://git-scm.com>
- At least one AI coding tool: **Claude Code** (VS Code extension), **Cursor**,
  **Google Antigravity**, or **Windsurf**
- Optional: **Google Chrome**, for the browser extension part

No `npm install` is needed. Everything runs with Node alone.

## 2. Set up (about 2 minutes)

```
git clone https://github.com/anurag123-lab/SHADOW-AI.git
cd SHADOW-AI
npm run lab:setup
```

This creates the lab **next to** the cloned repo (`../shadow-ai-agent-lab`) and
switches the guard on for that folder only, in every AI tool. Your other
projects are not affected.

> Clone into a path **without spaces** (e.g. `C:\dev\SHADOW-AI`). Antigravity
> can't run hooks from a path with spaces.

## 3. Connect to the dashboard (optional, but the best part)

Detections are always enforced on the laptop. To see them on the manager's
dashboard as well:

1. Start the dashboard: `npm run serve:dashboard`, then open <http://localhost:5500>.
2. **Manager:** sign up, create a workspace, and note its **join code**.
   (Or ask whoever runs the demo workspace for its join code.)
3. **Employee laptop:** sign in once with a *different* account:
   ```
   node <repo>/agent-guard/cli.js login
   ```
   Enter the email, password, join code and department.
4. Check it: `node <repo>/agent-guard/cli.js status` should show `Signed in: …`.

The dashboard shows the employee as an anonymous ID (`emp_…`) plus department,
never the prompt, file contents or secret.

## 4. The demo

Open the **lab folder** in the AI tool, then **start a new chat**.

- **Claude Code:** choose the **Manual** permission mode, so you see the "allow?" popups.
- **Cursor:** use **Agent** mode.

Keep the test files **closed** in the editor.

| Ask the AI | What happens |
|---|---|
| `Read sample-app/test-files/prod-keys.txt` | **Blocked**: live API key (mandatory) |
| `Run: cat sample-app/.env` | **Blocked**: secrets file |
| `Read sample-app/data/customers.csv` | **Blocked**: card numbers |
| `Read sample-app/test-files/board-memo.md` | **Warning**: "contains Document marked confidential…". Claude Code and Antigravity ask you; Cursor and Windsurf show the warning and continue. |
| `Read sample-app/test-files/meeting-notes.txt` | **Works normally**: nothing sensitive |
| `Add our Stripe key to payment.js` + paste the key from `prod-keys.txt` | **Your prompt is blocked** before it's sent |
| Attach a file with `@sample-app/test-files/server-notes.txt` and ask "summarise" | Held: "remove it, or start your prompt with `!sendanyway`" |
| **Upload** `sample-app/test-files/Q3-forecast-CONFIDENTIAL.pdf` into the chat | **Cursor:** blocked before sending. **Claude Code / Antigravity:** detected right after sending, a warning appears, and it's reported as *uploaded anyway* (these tools give no way to stop an upload first). |

Then refresh the dashboard. Each event is labelled with the tool name,
**Claude Code (desktop)**, **Cursor (desktop)** and so on, plus the category and
the file name.

### Code that's already in the project

```
cd <lab>
node <repo>/agent-guard/cli.js scan sample-app
```
This lists every `file:line` with a secret or personal data, never the value.
Results appear on the dashboard as **codebase scan**.

### Committing a secret

The lab is a git repo with the guard's pre-commit hook:
```
git add sample-app/src/legacy-config.js
git commit -m "wip"
```
The commit is **rejected**: a live key in `legacy-config.js`. Move the key to an
environment variable and the commit goes through. The dashboard shows
**git pre-commit**.

### No AI tool installed? Run the whole demo in a terminal

```
node <repo>/agent-guard/demo.js --step
```
This runs the same actions through the real hooks of all four tools side by
side. Add `--dashboard` (after `login`) to send the events to the dashboard.

## 5. Browser extension (optional)

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and choose `<repo>/extension`.
2. Sign in from the extension popup with the same employee account and join code.
3. On ChatGPT, Claude or Gemini, paste a fake key or the card number
   `4111 1111 1111 1111`. You'll get a warning or redaction before it's sent.

## 6. If something doesn't trigger

- Run `node <repo>/agent-guard/cli.js status`. Under **Hooks**, each tool you
  used should say *last call just now*. If a tool is missing, reopen the lab
  folder in that tool and approve its hooks if asked.
- In Claude Code's **auto** or **edit automatically** modes, warnings can be
  approved without a popup. Use **Manual**.
- Warnings never block. Only mandatory items (keys, cards, `.env`, honeytokens) do.

## 7. Clean up

```
node <repo>/agent-guard/lab/setup-lab.js --remove
```
This switches the hooks off and deletes the lab folder.

---

`<repo>` is the folder you cloned (e.g. `C:/dev/SHADOW-AI`) and `<lab>` is the
lab folder. In the copy of this file **inside the lab**, both are already
filled in with the real paths.
