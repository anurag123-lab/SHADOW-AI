# Shadow AI Guard — coding agents + git

The browser extension protects AI chat tools. This folder extends the **same
detection engine, policies and dashboard** to AI coding agents and to git:

| Layer | How it hooks in | Labelled on the dashboard |
|---|---|---|
| Claude Code | `.claude/settings.json`: `UserPromptSubmit`, `PreToolUse` | Claude Code (desktop) |
| Cursor | `.cursor/hooks.json`: `beforeSubmitPrompt`, `beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution`, `preToolUse` | Cursor (desktop) |
| Windsurf / Devin Desktop | `.devin/hooks.json` (+ legacy `.windsurf/`): `pre_user_prompt`, `pre_read_code`, `pre_write_code`, `pre_run_command`, `pre_mcp_tool_use` | Windsurf (desktop) |
| Google Antigravity | `.agents/hooks.json`: `PreToolUse` (Antigravity has no prompt hook) | Antigravity (desktop) |
| git (any tool, or by hand) | `.git/hooks/pre-commit`, plus the same scan in CI | git pre-commit |

## What it does

| Agent / developer does | Guard does |
|---|---|
| Reads `.env`, keys, credentials | **Denied** |
| `cat` / `type` / `Get-Content` a secrets file, `printenv` | **Denied** |
| Reads a file with card numbers, live keys, honeytokens | **Denied** (Mandatory) |
| Reads a file with a company keyword or an email | Warn: Claude Code / Cursor shell **ask**, Antigravity **asks**, Cursor read / Windsurf show a warning |
| Uploads a file with `curl` that contains sensitive data | **Denied** |
| Writes a live key into code | **Denied** |
| Prompt contains a live key or honeytoken | **Prompt blocked** before it's sent (not Antigravity: no prompt hook) |
| Prompt **attaches a file** (`@notes.txt`, a pasted path, Cursor attachments) | The file is scanned first: key → blocked; password / confidential → held with a `!sendanyway` hint |
| File **uploaded into the Claude Code chat** (paperclip / drag; text, PDF, .docx via the extension's pdf.js / mammoth) | Scanned right after sending: reported as **uploaded anyway** + warning shown (Claude Code gives hooks no earlier access) |
| A file holds a plain-text password (`db password: …`) | Warn (asks / warns); IT can promote it to mandatory on the dashboard |
| Commits a live key, card numbers or a `.env` | **Commit rejected**, with `file:line`, never the value |

One engine (`lib/decide.js`) makes every decision. Each tool has a small
adapter in `adapters/` that only translates that tool's JSON in and out.

## Set it up

```
node agent-guard/cli.js login                              # once per laptop: email, password, join code, department
node agent-guard/cli.js install all  <project folder>      # Claude Code + Cursor + Windsurf + Antigravity
node agent-guard/cli.js install git  <git repo>            # pre-commit hook
node agent-guard/cli.js install all  --global              # …or every project on this laptop (+ `install git --global`)
node agent-guard/cli.js uninstall <tool|all|git> <folder | --global>
node agent-guard/cli.js exempt <folder>                    # keep the guard out of a folder (laptop-wide install)
node agent-guard/cli.js scan <folder>                      # scan a codebase; findings go to the dashboard as "codebase scan"
node agent-guard/cli.js status | flush | off | on | logout
```

`install` merges into existing hook files. It only adds or removes entries
that point at `agent-guard`, and it refuses to install inside this repository,
which is full of test secrets. Restart the AI tool afterwards.

`--global` writes `~/.claude/settings.json`, `~/.cursor/hooks.json`,
`~/.codeium/windsurf/hooks.json`, `~/.gemini/config/hooks.json`, and for git
sets `core.hooksPath` (the repo's own pre-commit still runs after ours). It
exempts this repository automatically. If the same hook runs from both a
project file and the global file, the action is still decided, but the
dashboard gets one event, not two.

`status` lists each AI tool's **last hook call**. If a tool isn't listed after
you've used it, its hooks aren't loaded (restart it / approve the hooks).

For a company-wide rollout, IT puts the same entries in each tool's
system-level file instead, which users can't remove:
`C:\ProgramData\Cursor\hooks.json`, `C:\ProgramData\Devin\hooks.json`, and
Claude Code managed settings.

## CI

`git commit --no-verify` skips a local hook, so the same scan also runs in CI:

```
node agent-guard/git/scan.js --staged          # pre-commit (what the hook runs)
node agent-guard/git/scan.js --diff origin/main  # pull request: changed files
node agent-guard/git/scan.js --all             # whole repo
```

For GitHub Actions, copy `git/github-workflow.example.yml`. Exit code 1 means
Mandatory findings (add `--strict` to fail on Warn too). Test fixtures go in
`.shadow-ai-ignore` (one glob per line).

## Dashboard and privacy

Once you've run `login`, every decision (blocked / warned / sent anyway)
appears on the manager's dashboard next to browser events, with the tool label
above, the employee's anonymous ID and their department. Company policies,
custom keywords and honeytokens set in the dashboard apply here too
(refreshed every minute). Per-project extras go in
`<project>/.shadow-ai-policy.json` (`honeytokens`, `customKeywords`,
`policyOverrides`, `sensitivePaths`).

Prompts, commands, code and file contents are scanned on the laptop and never
sent. Events are built by the extension's own allow-list
(`extension/src/core/event-payload.js`). Reporting runs in the background, and
events made offline are queued and sent later.

## Safety switches

- `cli.js off` or `SHADOW_GUARD_OFF=1`: allow everything on this laptop.
- If the guard itself errors it **fails open** and logs the error, so a bug
  never locks a developer out. `SHADOW_FAIL_CLOSED=1` blocks instead; that's a
  company's choice.
- `SHADOW_DEBUG_KEYS=1` logs the field **names** a tool sends (never values),
  to map a new tool version.
- Antigravity: when the guard allows a tool call it prints nothing, so
  Antigravity's own allow/deny settings still decide. The guard never
  auto-approves.

## Stage demo

```
npm run demo:agent                           # = node agent-guard/demo.js --step (Enter between acts)
node agent-guard/demo.js --dashboard         # after `cli.js login`: events also land on the dashboard
```

Throw-away project with fake secrets: codebase scan, the same agent actions
through all four tools' real hooks side by side, a real rejected commit, and a
privacy check. It needs no AI tool installed and deletes the project afterwards.

## Tests

```
npm run test:agent    # from the repo root: Claude Code (26) + Cursor/Windsurf/Antigravity (33) + git & installer (26) + attachments & laptop-wide (30) + pattern parity (426)
```

All tests run in temp folders under the OS temp dir. Local state lives in
`~/.shadow-ai/` (override with `SHADOW_HOME`).

## Known limits

- Antigravity's hook argument names aren't documented, so the adapter also
  scans every string argument. Some IDE builds have been reported not to fire
  hooks; check that `cat .env` is denied before relying on it.
- Hooks see what the agent does through its tools. The model provider still
  receives files the developer allows; the guard decides **which** ones.
- **Files uploaded into the Claude Code chat** (paperclip / drag-and-drop)
  travel inside the message, not through a tool, and Claude Code saves that
  message only after the prompt hook has run. So an upload usually can't be
  stopped before it is sent: the guard scans it right after (next hook call,
  or the end-of-turn `Stop` hook), reports it as `uploaded_anyway` and warns
  the developer. Files the agent **reads itself** are checked before sending.
  An open editor tab only sends its path; Claude must Read it (hooked).
- Images and other formats the extension can't read (xlsx, pptx) fail open,
  as in the browser.
- In Claude Code's **auto** permission mode an "ask" may be settled without a
  popup; use the default mode to see the warning dialog.
- Antigravity has no prompt hook, so files attached to an Antigravity prompt
  aren't checked; its reads, commands and writes are.
