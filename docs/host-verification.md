# Host verification checklist (Windows)

Explicit, step-by-step checks for the things this Linux test environment cannot
prove. Run each step on the Windows host that runs `sbx`. Record the result —
especially failures — and paste it back. Steps are independent; you can stop
after any failure and report it.

Conventions: `<name>` is a project name (`/project list`), `celly-<slug>` its
sandbox, `<channelId>`/`<threadId>` come from Discord links. Run PowerShell in
the repo root unless a step says otherwise.

## 0. Prerequisites

1. `node --version` → `v24.x`.
2. `npx sbx version` → prints a version; `npx sbx ls` lists sandboxes.
3. Rebuild and restart the bot after the policy fix:
   ```powershell
   npm run build
   npm start
   ```
   Expected: startup banner lists your guild, no "policy was not enforced"
   errors. (Optional: `npm run dev` while iterating.)

## 1. Policy enforcement and project ready

1. In the project channel: `/project status name:<name>` → `status: ready`,
   a host port, session count.
2. In the project channel send `say hi`.
   - Expected: a thread is created and the agent replies.
   - If it fails with "not healthy ... policy was not enforced": capture the
     full error and stop.
3. Inspect the live server config inside the sandbox (PowerShell):
   ```powershell
   npx sbx exec celly-<slug> bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; curl -s -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/config'
   ```
   Expected somewhere in the JSON: `"external_directory":"deny"` and deny
   entries such as `"git push"`, `"opencode.env"`, `"/.config/celly/"`.
   Record whether `"question"` is `"allow"` or `"deny"` and paste the value.

## 2. `/attach` from a terminal

1. In a Discord thread (for an existing session) run `/attach`.
   Expected: an ephemeral code block with
   `sbx exec -it celly-<slug> bash -lc '... exec opencode attach http://127.0.0.1:4096 -s <sessionId>'`.
2. Paste that exact command in PowerShell.
   Expected: "Sandbox ... started successfully" then the OpenCode TUI.
   - If you get `Unable to connect`, stop and report: bot log tail
     (`Get-Content .\data\bot.log -Tail 50`) plus whether step 1 passed.
3. In the TUI type `say hi from the terminal`.
   Expected: the TUI replies, and roughly the same turn appears in the Discord
   thread (streaming).
4. Exit the TUI (Ctrl+C), then run `/session-id` in the thread and
   `... opencode attach http://127.0.0.1:4096 -s <id>` with that id.
   Expected: the TUI resumes that session with history.

## 3. `ATTACH_AUTO_THREAD` (terminal-started sessions)

1. Add to `.env`: `ATTACH_AUTO_THREAD=true`, restart the bot.
2. In PowerShell start a fresh terminal session:
   ```powershell
   npx sbx exec -it celly-<slug> bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096'
   ```
   Start a new session in the TUI and send a prompt.
   Expected: a new Discord thread appears in the project channel, titled after
   the session, and receives the turn.
3. Record: did the thread appear? If not, paste `data/bot.log` tail and say
   whether the session existed beforehand.

## 4. Permission approvals (`/mode`)

1. `/mode buttons` in the project channel → `approval mode set to buttons`.
2. Prompt: `create a file named celly-perm-check.txt containing hello`.
   Expected: an **Approve once / Always allow / Reject** message in the thread;
   click Approve once → the file is created; the message updates.
3. Check the audit log (PowerShell):
   ```powershell
   Get-Content .\data\audit.jsonl -Tail 5
   ```
   Expected: a JSON line with `kind":"permission"`, the tool, and your decision.
4. Timeout check: repeat the prompt and click nothing for 5 minutes.
   Expected: the message edits to a timeout notice and the run continues with a
   rejection (no hang).
5. `/mode plan` then ask to create another file.
   Expected: refusal/deny without an approval message. `/mode auto` restores
   the old behavior.

## 5. Agent questions

1. Keep `/mode buttons`; prompt: `ask me a question with three options`.
2. Expected: buttons or a select plus a Custom answer button; answering lets the
   run continue. A Reject button cancels it.
3. **Record what actually happens.** Step 1's `/config` showed
   `"question":"deny"` on opencode 1.18.32's v1 config surface, so the question
   may be auto-rejected and never reach Discord. If no question UI appears,
   paste the prompt's reply and the bot log tail — this decides whether we move
   the question bridge to the v2 config/event surface.

## 6. OAuth login (`/login`)

1. `/login` with a provider id you use (e.g. `anthropic`).
   Expected: an ephemeral message with an authorization URL and instructions.
2. Open the URL in a browser, complete the flow.
   - Code flow: run `/login-code provider:<id> code:<code>`.
   - Auto flow: finish in the browser.
   Expected: `logged in to <provider>`.
3. `/model` → your provider appears; pick a model; send a prompt.
   Expected: a normal reply **without** any `sbx secret` setup.
4. Record: provider, flow type, success/failure, and the exact error text if it
   fails.

## 7. Cost and budget

1. After a few prompts run `/cost`.
   Expected: session and channel cost/token lines and a budget line
   (`budget: off` by default).
2. Compare the session cost with the provider dashboard for the same period.
   Record both numbers.
3. `/budget set 0.05` (owner-only), then run prompts until the budget trips.
   Expected: a `[budget]` line in the reply and a channel warning; the run
   aborts. `/budget set 0` restores unlimited.

## 8. Idle auto-stop

1. Set `IDLE_STOP_MINUTES=2` in `.env`, restart the bot.
2. Restart the bot while a project is awake (send a message first).
   Expected: the project is **not** stopped immediately after boot (this was a
   bug; the boot wake now counts as activity).
3. Leave it idle for ~2.5 minutes.
   Expected: a channel notice about the stop, and `npx sbx ls` shows the
   sandbox stopped. Record the notice text (minutes must be ≤ the threshold).
4. Send a message in the project channel.
   Expected: the project wakes and replies normally.

## 9. Admin page

1. With `ADMIN_PORT=4560` (default) open `http://127.0.0.1:4560/` in a browser.
   Expected: the status page loads.
2. Click start/stop on a project (or use the API):
   ```powershell
   curl http://127.0.0.1:4560/api/projects
   curl http://127.0.0.1:4560/api/audit?limit=5
   ```
   Expected: JSON; `/api/audit` returns entries after step 4 (no 404).
3. `/api/logs/<channelId>?lines=20` returns recent project log lines.

## 10. Multi-guild (only if you use more than one guild)

1. Set `DISCORD_GUILD_IDS=guild1,guild2` in `.env`, restart.
   Expected: the banner lists both; commands work in both guilds; a message in
   the second guild creates/uses its own project channel.
2. Note: access control (role IDs) is still global across guilds — per-guild
   roles are a follow-up.

## 11. What to send back

For each failed step, paste:

- the exact Discord error or reply,
- `Get-Content .\data\bot.log -Tail 50`,
- the relevant `Get-Content .\data\audit.jsonl -Tail 5` lines,
- the `/config` output from step 1 when relevant.

## Rollback

The bot is a single process: `Ctrl+C`, then `git checkout <previous-commit>` and
rebuild. `data/bot.db` migrations only ever add columns/tables, so an older
binary can still read a newer DB; scheduled backups live in `data/backups/`.
