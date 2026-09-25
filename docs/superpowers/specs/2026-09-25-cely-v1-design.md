# Cely v1 — Design

Date: 2026-09-25
Status: Approved design (pending final spec review)
Author: brainstormed with opencode

## 1. Summary

`Cely` is a Discord bot that turns Discord into a control surface for
OpenCode coding agents, where every project runs inside an isolated `sbx`
(Docker Sandboxes) microVM on the host machine.

Naming: the bot is **Cely**, short for **Celebrimbor**, the elven smith of
Eregion who forged the Rings of Power. The Discord category is **Eregion**
(the forge-realm), and each sandbox is `cely-<slug>` — one ring, one workshop.
The Tolkien name is for private use; if the project is ever published, the
branding must be renamed.

- **Channel = project** = one `sbx` sandbox + one host directory.
- **Thread = conversation** = one OpenCode session.
- Bot runs **natively on the sbx host** (Windows 11 for v1), because only the
  host can invoke the `sbx` CLI.
- The bot talks to OpenCode inside each sandbox over the sandbox's published
  loopback port using the `@opencode-ai/sdk`.
- Provider credentials are injected by `sbx secret` at the host proxy; they are
  never stored in the bot or the repository.

This is a deliberately lightweight re-implementation of the command surface of
[remorses/kimaki](https://github.com/remorses/kimaki) (MIT), with `sbx`
sandboxes replacing Kimaki's local process management.

## 2. Goals

1. From Discord (including mobile): add a project, send prompts, watch replies
   stream, abort, switch model/agent, resume past conversations.
2. Every project executes in its own sandbox; the host filesystem outside the
   mounted project directory is unreachable by the agent.
3. Sessions are shared between Discord, a terminal attached to the sandbox, and
   the OpenCode web UI for that project.
4. Survive sandbox stop/start and bot restarts with no loss of conversation
   continuity.

## 3. Non-goals (v1)

Queue UI (`. queue`), `/btw` forks, worktree-per-thread, voice messages, image
attachments, tunnels/screenshare, scheduled tasks, permission approval buttons,
OAuth subscription login, multi-guild operation, cloud sandboxes, `--clone`
sandbox mode, admin website, web diff viewer, forum-channel layout.

## 4. Topology and constraints

```
Discord                        Windows 11 host                        sbx sandbox (per project)
#web-app ── message ──▶ router ──▶ ensureReady() ──▶ sbx create/exec ──▶ opencode serve :4096
   │                        │                                             │        ▲
   ├─ thread = session      │  SQLite: projects/threads                   │   SDK over
   └─ agent replies ◀── render ◀── SSE event pump ◀── 127.0.0.1:<hostport>┘   published port
```

Constraints discovered during research:

- `sbx` sandboxes cannot reach the host sandboxd/Docker daemon and cannot
  control other sandboxes. The bot must run on the host natively.
- `sbx exec` has no detached mode; long-running `opencode serve` must be
  launched with `nohup ... &` (or tmux) inside the sandbox.
- `sbx ports` binds host ports on loopback by default; we additionally set
  `OPENCODE_SERVER_PASSWORD` for basic auth.
- `sbx` mounts only paths declared at sandbox creation; anything a conversation
  needs to see on the host must exist under the mounted project directory.
- `sbx` sandbox names: >= 2 chars, start alphanumeric, only letters, numbers,
  hyphens, periods.

Rejected alternative: running the bot in a normal Docker container. A Linux
container cannot execute the Windows `sbx` binary nor reach host sandboxd, and
Docker Sandboxes blocks the host Docker daemon by design. Containerizing would
require a separate host-side bridge service for zero functional gain. Documented
fallback if the bot must ever move off-host: add a small host REST service that
wraps `sbx`, and let the container call it.

## 5. Architecture

Stack: TypeScript, Node 24, discord.js 14.x, `@opencode-ai/sdk`,
`node:sqlite` (fallback `better-sqlite3` if the built-in is unstable),
hand-rolled env validation, vitest for tests, `tsx` for dev, `tsc` for build.

Module responsibilities (one clear purpose each, testable in isolation):

| Module | Responsibility |
|---|---|
| `src/config.ts` | Parse/validate `.env`, expose typed config. |
| `src/db.ts` | SQLite schema + typed queries. No business logic. |
| `src/sbx.ts` | Only module allowed to shell out. Create/wake/stop/remove sandboxes, read `sbx ls --json` / `sbx ports --json`, allocate host ports, run commands via `sbx exec`. |
| `src/opencode.ts` | Boot `opencode serve` in a sandbox, health polling, SDK client registry, basic auth, SSE subscription lifecycle. |
| `src/runner.ts` | Per-thread run state machine: session create/reuse, prompt, queue, abort, event dispatch. Pure-ish; depends on injected clients. |
| `src/render.ts` | Event -> Discord text, chunking, throttled message edits. Pure functions plus a small editor class. |
| `src/discord.ts` | discord.js client, intents, access control, message router, thread lifecycle, slash command registration. |
| `src/commands.ts` | Slash command definitions + handlers, delegating to modules above. |
| `src/shell.ts` | `!cmd` execution via `sbx exec` with output chunking. |
| `src/log.ts` | Structured logging to console + `data/bot.log`. |
| `src/index.ts` | Bootstrap: config -> db -> sbx check -> discord login -> command registration. |

## 6. Data model

SQLite database at `<DATA_DIR>/bot.db`, created with `CREATE TABLE IF NOT
EXISTS` on boot.

```sql
CREATE TABLE IF NOT EXISTS projects (
  channel_id      TEXT PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  directory       TEXT NOT NULL,
  sandbox_name    TEXT NOT NULL,
  host_port       INTEGER NOT NULL,
  server_password TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id      TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES projects(channel_id),
  session_id     TEXT NOT NULL,
  title          TEXT,
  model          TEXT,            -- "provider/model" override, nullable = default
  agent          TEXT,            -- agent name override, nullable = default
  worktree_path  TEXT,            -- reserved for v1.1
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`settings` holds `default_model`, `default_agent`, `projects_root` (editable at
runtime), and similar small values.

## 7. Sandbox lifecycle

Naming: `cely-<slug>` where slug is the lowercased channel/project name with
non `[a-z0-9-]` collapsed to `-`, trimmed, deduplicated against the projects
table.

Ports: host ports allocated from `PORT_RANGE_START..PORT_RANGE_END` (default
4300-4399). A port is considered free if it is not used by any row in
`projects`, not present in `sbx ls --json`, and a host bind test succeeds. The
allocation is persisted in `projects.host_port`, so restarts are stable.

### Create (`/project add`, `/project create`)

1. Validate directory exists (add) or create it under `PROJECTS_ROOT/create` (create).
2. Allocate host port and generate a 32-hex `server_password`.
3. `sbx create opencode <directory> --name cely-<slug> --publish <host_port>:4096 -e OPENCODE_SERVER_PASSWORD=<password> --cpus <n> --memory <mem>`
4. Copy and run the bootstrap script:
   `sbx cp scripts/sandbox-bootstrap.sh cely-<slug>:/tmp/` then
   `sbx exec cely-<slug> bash /tmp/sandbox-bootstrap.sh`.
   The script writes `~/.config/opencode/opencode.json` inside the sandbox (never
   into the host repository) with:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": { "*": "allow", "question": "deny" }
   }
   ```
   `question: deny` prevents headless deadlocks when the agent wants to ask the
   user something; surfacing questions in Discord is backlog. The script does
   not overwrite an existing config.
5. Boot the server (below), wait for health.
6. Create the Discord channel under the `Eregion` category, write the
   `projects` row, post a short "connected" message in the channel. If the
   channel name is taken, append a numeric suffix.

### Boot server

```
sbx exec cely-<slug> bash -lc 'pkill -f "opencode serve" || true; \
  nohup opencode serve --port 4096 --hostname 0.0.0.0 \
  > /tmp/opencode-serve.log 2>&1 & echo started'
```

Then poll `GET /global/health` (basic auth) every 500 ms up to 30 s. On
success, the project is ready.

### Wake, stop, remove

- `wake`: `sbx exec <name> true` starts a stopped sandbox, then verify the port
  mapping via `sbx ports <name> --json` (re-publish and update DB if missing),
  then health-check; boot the server if unhealthy.
- Before every prompt the runner calls `ensureReady()` (wake + health) so a
  stopped sandbox just works on the next message.
- `/project stop`: `sbx stop <name>` (state preserved; project stays registered).
- `/project remove`: `sbx rm --force <name>` + delete DB rows + archive channel.

## 8. OpenCode bridge

- Client per project: `createOpencodeClient({ baseUrl: 'http://127.0.0.1:<port>' })`
  with basic auth (`opencode:<server_password>`). Exact auth mechanism is an
  implementation-time verification item (SDK headers option, custom fetch, or
  URL credentials).
- One SSE subscription per running project server (`client.event.subscribe()`,
  or `/global/event`), reconnecting with 1s..30s backoff. On reconnect, resync
  the affected thread by fetching `session.messages()`.
- Events consumed (names verified at implementation time):
  - `message.part.updated` -> text deltas and tool parts
  - `message.updated` -> assistant metadata (`session.idle` completion)
  - `session.idle` -> run finished; finalize render; drain queue
  - `session.error` -> post error in thread
  - `permission.updated` -> auto-respond `allow` via
    `POST /session/:id/permissions/:permissionID` (defensive; config already
    allows everything)

### Run state machine (per thread)

States: `idle -> running -> idle`, plus `aborting`.

- Prompt: ensure the thread has a session (`session.create`, title from first
  prompt, stored in `threads`); then `session.prompt_async` with text parts and
  optional per-thread model/agent override.
- While `running`, new messages are appended to an in-memory queue (persisted
  nowhere for v1) and sent when the run completes. The thread shows a short
  "queued (n)" notice.
- `/abort` calls `session.abort` and clears the queue.
- Bot restart: queue is lost; sessions resume from SQLite mapping.

## 9. Discord UX

Structure: one `Eregion` category; one text channel per project; threads for
conversations. Thread auto-archive 1 day; mapping persists, so replying to an
archived thread resumes the session.

Gateway intents: Guilds, GuildMessages, MessageContent (privileged; enabled in
the developer portal).

Access control (checked before any handling): guild owner, Manage Server,
Administrator, or member of `ACCESS_ROLE_NAME` if configured. Members of
`BLOCK_ROLE_NAME` are always ignored. Bot messages are ignored.

Routing:

- Message in a registered project channel (not a thread): create a thread named
  after the first 80 chars of the message, add the author, create a session,
  send the prompt.
- Message in a registered thread: continue that session (queue if running).
- Message elsewhere: ignored.

Streaming renderer:

- One live bot message per run, edited with accumulated assistant text.
- Minimum 1200 ms between edits (stays under Discord's 5-edits/5s limit).
- The live message is capped near 1900 chars; overflow continues in a new
  message. Tool parts render as compact quoted status lines, e.g.
  `> [bash] npm test`, updated to `[bash] npm test (done)`.
- A typing indicator is refreshed every 8 s while running.
- On completion the last message is finalized with a duration/token footer when
  available. Errors are posted as plain text in the thread.

Attachments (v1, minimal): text-like files under 100 KB are written into the
project directory and referenced by path in the prompt; all other attachment
types are acknowledged and ignored.

Shell: messages starting with `!` run
`sbx exec <sandbox> bash -lc '<cmd>'` with `--workdir <directory>`; output is
chunked into Discord messages (max ~1900 chars each, first 3 chunks then a
truncation notice).

## 10. Slash commands (v1)

| Command | Behavior |
|---|---|
| `/project add <name> <path>` | Register existing directory; create sandbox + channel. |
| `/project create <name>` | Create directory under `PROJECTS_ROOT` then add. |
| `/project list` | List projects with sandbox + health status. |
| `/project remove <name>` | Remove sandbox, DB rows, archive channel. |
| `/project status <name>` | Sandbox state, port, server health, session count. |
| `/project start <name>` / `/project stop <name>` | Wake / stop sandbox. |
| `/project restart <name>` | Reboot `opencode serve` inside the sandbox. |
| `/new [prompt]` | Start a new thread/session in the current channel. |
| `/resume [session]` | Pick a past session (select menu) and continue it in a new thread. |
| `/abort` | Abort the run in the current thread. |
| `/model` | Select model for this thread (from `GET /config/providers`). |
| `/agent` | Select agent for this thread (from `GET /agent`). |
| `/share` | `session.share` and post the URL. |
| `/diff` | `session.diff` -> summarized file list in a code block. |
| `/undo` / `/redo` | `session.revert` / `session.unrevert` on the last assistant message. |
| `/context-usage` | Token/context summary from the last assistant message. |

Commands are registered guild-scoped for instant updates. Most accept an
optional thread context and reply ephemerally on error.

## 11. Terminal and browser coexistence

- Terminal: `sbx exec -it cely-<slug> bash`, then
  `opencode attach http://127.0.0.1:4096` (verify availability/auth at
  implementation) or `sbx run --name cely-<slug>` to launch the TUI. Sessions
  live in the sandbox's OpenCode storage, so Discord and the terminal share the
  same conversations. The basic-auth password is stored in
  `projects.server_password` in `<DATA_DIR>/bot.db` and is shown by
  `/project status` to authorized users.
- Browser: the published port can serve OpenCode's web UI. Verification item:
  whether `opencode web --port 4096 --hostname 0.0.0.0` exposes the full API
  alongside the UI; if yes, boot `web` instead of `serve`, giving per-project
  browser access at `http://127.0.0.1:<host_port>`.

## 12. Security model

- Access-controlled Discord users can make the agent run arbitrary code inside
  the sandbox and modify the mounted project directory. This is intended
  ("YOLO inside the sandbox").
- The agent cannot read host paths outside the mounted project directory, use
  the host Docker daemon, or reach other sandboxes.
- Provider keys are injected by `sbx secret` at the proxy; the sandbox holds
  placeholders only.
- `OPENCODE_SERVER_PASSWORD` protects the loopback-published port; the port is
  not exposed beyond 127.0.0.1.
- The bot process never executes model output directly; it only shells `sbx`
  and Discord APIs.
- Secrets in `.env` (`DISCORD_TOKEN`) are excluded from git via `.gitignore`.

## 13. Configuration

`.env` (validated at boot, fail fast with a clear message):

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | required | Bot token. |
| `DISCORD_GUILD_ID` | required | Single guild v1. |
| `PROJECTS_ROOT` | required | Root for `/project create`. |
| `ACCESS_ROLE_NAME` | unset | Extra allowed role. |
| `BLOCK_ROLE_NAME` | unset | Always-denied role. |
| `SANDBOX_CPUS` | `2` | Passed to `sbx create --cpus`. |
| `SANDBOX_MEMORY` | `4g` | Passed to `sbx create --memory`. |
| `PORT_RANGE_START` / `PORT_RANGE_END` | `4300` / `4399` | Host port pool. |
| `DATA_DIR` | `./data` | SQLite + logs. |
| `LOG_LEVEL` | `info` | Logging. |

Provider setup is documented in the README:
`sbx secret set anthropic` (or openai/google/etc.), then restart sessions.

## 14. Error handling and recovery

| Failure | Detection | Response |
|---|---|---|
| `sbx` CLI missing/not logged in | boot check / command error | Fail fast at boot with install/login hint. |
| Sandbox missing | `sbx ls --json` | Channel notice; `/project add` to recreate. |
| Sandbox stopped | exec fails / not in `ls` as running | `wake()` on next prompt. |
| Port mapping missing | `sbx ports --json` | Re-publish, update DB. |
| Server unhealthy | `/global/health` | One auto-restart, then `/project restart` hint. |
| SSE disconnect | stream error/close | Backoff reconnect + message resync. |
| OpenCode run error | `session.error` | Post error, mark idle, drain queue. |
| Discord 429 on edit | discord.js error | Increase edit interval temporarily. |
| Bot restart | process start | Clients built lazily; threads from SQLite. |
| Host reboot | process start | Sandboxes stopped; first message wakes them. |

## 15. Testing

- Unit (vitest, runnable inside this development sandbox):
  - slug/sandbox naming and port allocation
  - db CRUD and session mapping
  - `sbx ls --json` / `sbx ports --json` parsers with recorded fixtures
  - renderer: text accumulation, tool lines, chunking, edit throttling logic
  - command handlers with mocked adapters
- Contract: opencode client wrapper against a fake HTTP/SSE server (health,
  session create/prompt, event stream, reconnect).
- Smoke (host only, `SMOKE=1`): create scratch dir -> `sbx create` -> boot ->
  create session -> prompt "say hi" -> assert reply -> stop/rm.
- Manual Discord checklist: thread flow, streaming, abort, queue, model/agent
  switch, `!` shell, sandbox stop/wake, bot restart continuity.

## 16. Deployment (Windows 11 host)

1. Install Node 24 (`winget install OpenJS.NodeJS.LTS`), `sbx` (`winget install
   -h Docker.sbx`), run `sbx login`, set provider secrets.
2. Clone the repo, `npm ci`, `npm run build`, fill `.env`.
3. Run `node dist/index.js` (dev: `npm run dev`).
4. For persistence: Task Scheduler job at logon, or NSSM service; logs in
   `data/bot.log`.
5. Discord developer portal: create app, enable Message Content intent, invite
   with scopes `bot` + `applications.commands` and permissions: Manage Channels,
   Send Messages, Create Public Threads, Send Messages in Threads, Embed Links,
   Read Message History.

## 17. Design decisions log

- **Bot native on host, not in Docker** — only the host can call `sbx`; a
  container would need a host bridge for no benefit. Fallback documented.
- **SDK over published loopback port, not `sbx exec` parsing** — full API
  (streaming, abort, permissions, share/diff) with stable machine formats.
- **Eager sandbox creation at `/project add`** — setup errors surface
  immediately; first message is fast.
- **Thread = session; worktrees deferred to v1.1** — parallel conversations now;
  `worktree_path` column reserved. Channel-per-feature remains possible manually
  because a project is just (channel, directory, sandbox).
- **Auto-allow permissions inside sandbox** — the sandbox is the security
  boundary; approval buttons deferred. `question` tool disabled to avoid
  headless deadlocks.
- **No admin website in v1** — OpenCode's web UI per project covers browsing;
  a bot admin page (projects/sandboxes/logs) is backlog.
- **Native Windows target** — same machine as the current sbx host; Ubuntu/KVM
  supported later.

## 18. Backlog (v1.1+)

Worktree-per-thread (`/worktree new|list|merge`), `/btw` forks, queue UI and
`. queue`, permission approval buttons, `question` -> Discord components,
admin localhost website, idle auto-stop, multi-guild, cloud sandboxes, OAuth
subscription login, image/voice attachments, diff web viewer, forum-channel
layout, Linux/macOS deployment docs.

## 19. Implementation verification items

Resolve these first during implementation, each with a small spike or test:

1. SDK basic-auth support (`headers` option, custom fetch, or URL credentials).
2. `opencode web` vs `serve` API parity; pick the boot command.
3. `node:sqlite` stability on Node 24 on Windows (fallback `better-sqlite3`).
4. Current SSE event names/payload shapes in the installed opencode version.
5. `nohup ... &` persistence after `sbx exec` exits (fallback: tmux/setsid).
6. Exact `sbx ls --json` and `sbx ports --json` output shapes (record fixtures).
7. `opencode attach` availability and auth inside the sandbox.
8. Discord message-edit rate-limit behavior under the 1200 ms throttle.
9. `question` permission deny behavior (no deadlock; graceful fallback).
10. `sbx create -e` variables visible to later `sbx exec` sessions.
