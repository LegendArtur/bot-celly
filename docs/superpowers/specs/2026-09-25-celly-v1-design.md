# Celly v1 — Design

Date: 2026-09-25
Status: Revised v2 after parallel review (pending final approval)
Author: brainstormed with opencode

Revision v2 incorporates findings from the sbx-platform, Discord, security,
internal-consistency, and feasibility reviews: the supervised in-sandbox server
model, host bootstrap (policy init), enforced security invariants, Discord
correctness fixes, explicit module ownership, and a trimmed v1 command set.

## 1. Summary

`Celly` is a Discord bot that turns Discord into a control surface for
OpenCode coding agents, where every project runs inside an isolated `sbx`
(Docker Sandboxes) microVM on the host machine.

Naming: the bot is **Celly**, a forge for coding agents. Each project's
sandbox is its **forge** (`celly-<slug>`), and the default Discord category is
**Forge**. The theme is generic, public-domain smithing folklore (anvils,
forges, and smiths); it carries no trademarked or copyrighted proper noun.

- **Channel = project** = one `sbx` sandbox + one host directory.
- **Thread = conversation** = one OpenCode session.
- Bot runs **natively on the sbx host** (Windows 11 for v1), because only the
  host can invoke the `sbx` CLI.
- The bot supervises a long-lived `sbx exec ... opencode serve` child per
  project and talks to it over the sandbox's published loopback port using the
  `@opencode-ai/sdk`.
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
3. Sessions are shared between Discord and a terminal attached to the sandbox.
4. Survive sandbox stop/start and bot restarts with no loss of conversation
   continuity.

## 3. Non-goals (v1)

Deferred: worktree-per-thread, `/btw` forks, queue UI (`. queue`),
`/share`, `/diff`, `/undo`, `/redo`, `/context-usage`, `/project restart`,
voice messages, image attachments, tunnels/screenshare, scheduled tasks,
permission approval buttons, `question` UI in Discord, OAuth subscription
login, multi-guild, cloud sandboxes, `--clone` sandbox mode, admin website,
web diff viewer, forum-channel layout, OpenCode web UI.

In scope but hardened: text attachments (sanitized inbox), `!shell`
(argv-only, same privilege as the agent).

## 4. Topology and constraints

```
Discord                        Windows 11 host                        sbx sandbox (per project)
#web-app ── message ──▶ router ──▶ ensureReady() ──▶ sbx create/exec ──▶ opencode serve :4096
   │                        │         supervised child                     │        ▲
   ├─ thread = session      │  SQLite: projects/threads                   │   SDK over
   └─ agent replies ◀── render ◀── EventRouter ◀── SSE ◀─ 127.0.0.1:<hostport>┘  published port
```

Platform facts that shape the design (verified against Docker Sandboxes
docs, CLI reference YAML, and release notes; sbx >= 0.45.0 recommended):

- `sbx` sandboxes cannot reach the host sandboxd/Docker daemon and cannot
  control other sandboxes. The bot must run on the host natively.
- **Sandboxes created with `sbx create` stop automatically when idle.** A
  backgrounded `nohup` child is not a "session" and is not guaranteed to
  survive. Therefore the bot keeps one **long-lived foreground
  `sbx exec <sandbox> bash -lc 'exec opencode serve ...'` child per project**;
  an active exec session holds the sandbox awake and provides continuous logs.
- `sbx exec` has no detached mode. `sbx exec` starts a stopped sandbox first.
- **First run requires a network policy preset**: `sbx policy init
  <open|balanced|locked-down>` must be run before starting a sandbox for the
  first time, otherwise `sbx create` blocks on an interactive prompt.
- Sandbox names: >= 2 chars, start alphanumeric, only `[a-z0-9.-]`, **max 63
  chars**, no trailing `-` or `.`, `default` reserved.
- `sbx ports` binds host ports on loopback by default; the in-sandbox service
  must bind `0.0.0.0` to be reachable. Explicit host ports persist across
  sandbox/daemon restarts.
- The host workspace is mounted in the sandbox at a path that is not simply the
  Windows `C:\...` string; the resolved in-sandbox path is a spike item and is
  stored per project.
- Provider credentials are injected by the forward proxy only; a manually
  launched `opencode serve` must inherit the proxy environment. This is a spike
  item.

Rejected alternative: running the bot in a normal Docker container. A Linux
container cannot execute the Windows `sbx` binary nor reach host sandboxd, and
Docker Sandboxes blocks the host Docker daemon by design. Fallback if the bot
must ever move off-host: add a small host REST service that wraps `sbx`.

## 5. Architecture

Stack: TypeScript, Node 24.x (pinned via `engines` + `.nvmrc`), discord.js
14.x, `@opencode-ai/sdk` (exact-pinned), `node:sqlite` (committed; the
`better-sqlite3` fallback is rejected on Windows because it needs a full
build toolchain). Fallback if `node:sqlite` proves unusable: `sql.js`/libsql,
not a native module. vitest for tests, `tsx` for dev, `tsc` for build.

Module responsibilities (one clear purpose each, testable in isolation):

| Module | Responsibility |
|---|---|
| `src/config.ts` | Parse/validate `.env`, expose typed config. Fail fast. |
| `src/log.ts` | Structured logging to console + `data/bot.log`, with redaction of tokens/passwords/headers and correlation ids (project/thread/run). |
| `src/db.ts` | SQLite schema, `PRAGMA user_version` migrations, `foreign_keys=ON`, typed queries. No business logic. |
| `src/sbx.ts` | **The only module that invokes `sbx`.** argv-only (`spawn(cmd,args,{shell:false})`), typed errors, timeouts, JSON parsers, path/name validation, port allocation, sandbox lifecycle, command execution. |
| `src/projects.ts` | Project lifecycle orchestration: create/remove sagas with rollback, `ensureReady()`, per-project single-flight mutex, supervised `opencode serve` child registry, reconcile loop. |
| `src/opencode.ts` | SDK client registry (basic auth), health polling, SSE subscription lifecycle, client factory. |
| `src/events.ts` | `EventRouter`: demultiplexes one project SSE stream by `sessionID` to the owning thread, reconnect/resync, buffer caps. |
| `src/runner.ts` | Per-thread run state machine: session create/reuse, prompt, queue, abort, permission policy evaluation, dispatch to renderer. |
| `src/render.ts` | Pure event→text/chunk functions plus a throttled editor; fence-aware chunking; all output goes through one send/edit chokepoint. |
| `src/discord.ts` | discord.js client, intents/partials, access control, message router, thread lifecycle, slash-command registration. |
| `src/commands.ts` | Slash-command definitions + handlers; delegates to `projects`/`runner`/`sbx`. |
| `src/shell.ts` | `!cmd` handling: calls `sbx.exec()`, owns output chunking only (no direct spawn). |
| `src/index.ts` | Bootstrap: config → db → sbx preflight → single-instance lock → discord login → command registration → graceful shutdown hooks. |

Invariant: only `sbx.ts` spawns processes. `shell.ts` and `projects.ts` call
its API. This is enforced by review and by a unit test that greps for
`child_process` imports.

## 6. Data model

SQLite database at `<DATA_DIR>/bot.db`. Migrations via `PRAGMA user_version`.
`PRAGMA foreign_keys = ON`.

```sql
CREATE TABLE IF NOT EXISTS projects (
  channel_id      TEXT PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  name            TEXT NOT NULL UNIQUE,
  directory       TEXT NOT NULL,       -- host path (Windows)
  sandbox_path    TEXT,                -- resolved in-sandbox workspace path
  sandbox_name    TEXT NOT NULL UNIQUE,
  host_port       INTEGER NOT NULL UNIQUE,
  server_password TEXT NOT NULL,
  status          TEXT NOT NULL,       -- provisioning | ready | degraded
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id       TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES projects(channel_id),
  session_id      TEXT NOT NULL,
  title           TEXT,
  model           TEXT,                -- override; null = channel/env default
  agent           TEXT,                -- override; null = built-in default
  worktree_path   TEXT,                -- reserved for v1.1
  live_message_id TEXT,                -- current streaming message
  render_state    TEXT NOT NULL DEFAULT 'idle', -- idle|running|aborting|errored
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);
-- session_id is intentionally NOT unique: /resume creates a new thread that
-- points at an existing session.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`settings` is seeded on first boot from env and holds only
`default_model`/`default_agent`. `.env` is the single source of truth for all
other configuration; `projects_root` is **not** runtime-editable (security).

## 7. Sandbox lifecycle (`src/sbx.ts` + `src/projects.ts`)

### Naming

`celly-<slug>`: slug = lowercased project name, non `[a-z0-9-]` collapsed to
`-`, trimmed. Enforce full name **<= 63 chars**, no trailing `-`/`.`; check
uniqueness against both the `projects` table and `sbx ls --json` (orphans
included). Names >63 are truncated on a word boundary and a numeric suffix is
appended if needed.

### Ports

- Host ports allocated from `PORT_RANGE_START..PORT_RANGE_END` (default
  4300-4399, documented ceiling of 100 projects).
- Allocation is serialized by an in-process mutex and validated against the DB,
  `sbx ls --json`, and a host bind test; the UNIQUE constraints are the backstop.
- After `sbx create`, the bot reads the **actual** mapping from
  `sbx ports <name> --json` and persists that (never trusts the requested port).
- On wake, verify the mapping; re-publish only if missing (best-effort, guarded
  by timeout, because re-publish can prompt on conflict).

### Create saga (`/project add`, `/project create`)

Executed by `projects.createProject()` with a per-name mutex and compensation
at each step:

1. Validate/derive the host directory: `/project add` requires the path to be
   inside `PROJECTS_ROOT` (v1: `PROJECTS_ROOT` only; a configurable allowlist is
   backlog), resolved with `fs.realpath` and case-insensitive containment; deny
   any ancestor/descendant of the bot repo, `DATA_DIR`, the user profile, and
   system directories.
   `/project create` creates it under `PROJECTS_ROOT/<name>` (name sanitized).
2. Allocate port + generate 32-hex password; insert the `projects` row with
   `status = 'provisioning'` (so retries and rollback can find it).
3. `sbx create opencode <directory> --name celly-<slug> --publish <port>:4096
   --cpus <n> --memory <mem>` (all args as argv).
4. `sbx exec <name> true` to ensure the sandbox is running before any copy.
5. `sbx cp <script> celly-<slug>:/tmp/celly-bootstrap.sh` then
   `sbx exec <name> bash /tmp/celly-bootstrap.sh`. The bootstrap (idempotent):
   - writes a celly-managed OpenCode config at `~/.config/celly/opencode.json`
     (not the global template config, so nothing is clobbered) that sets the
     bot-enforced permission policy and `question: deny`;
   - writes `~/.config/celly/opencode.env` (mode 0600) containing
     `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG=<path to the celly config>`,
     so the password is never placed on a host command line and the server
     always loads the celly-managed config;
   - does not overwrite user files in the mounted project.
6. Start the supervised server (below) and wait for health (timeout scaled for
   first boot).
7. Resolve and store `sandbox_path`; set `status = 'ready'`; create the Discord
   channel under the `Forge` category (channel name collisions get a numeric
   suffix); post a connected message.

On failure at any step: kill the child if started, `sbx rm --force <name>`,
release the port, delete the channel/DB row, and report the failing step.
Note: `opencode.json` in the project root can override global config; the bot
therefore enforces its policy at the API layer too (see §8), not only via
config.

### Supervised server

One long-lived child per project, held in a registry keyed by channel:

```
sbx exec <name> bash -lc \
  'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0'
```

- Because an exec session is active, the sandbox is not idle-stopped.
- `exec` makes the server the direct child; the bot captures the child's
  stdout/stderr to `data/logs/<project>.log`. A sandbox-side persistent log is
  not required in v1.
- Idempotent boot: if `/global/health` succeeds, do not start another child. If
  a child is tracked and alive, do not start another. `ensureReady()` is
  single-flighted per project.
- On child exit, mark project `degraded`, notify the channel once, and let the
  next prompt / `/project start` re-establish.

### Wake / stop / remove

- `ensureReady()` (used before every prompt): if sandbox stopped → `sbx exec
  <name> true`; verify health; start/restart the supervised child if needed.
- `/project stop` (owner): stop the child explicitly, then `sbx stop <name>`.
- `/project remove` (owner-only, typed confirmation): stop child,
  `sbx rm --force <name>`, delete DB rows, and **delete the Discord channel**
  (Discord text channels cannot be archived); alternatively move it to an
  `Forge-Archive` category. Choice is by config flag; default delete.

## 8. OpenCode bridge (`src/opencode.ts`, `src/events.ts`, `src/runner.ts`)

- Client per project: `createOpencodeClient({ baseUrl:
  'http://127.0.0.1:<port>' })` with basic auth (`opencode:<password>`). Exact
  auth mechanism (headers option / custom fetch) is a spike item.
- One SSE subscription per project, owned by `EventRouter`, started when the
  project becomes `ready` and stopped on `/project stop`/remove. Reconnect with
  1s..30s backoff and resync.

### EventRouter

- Demultiplexes project events by `sessionID` → owning thread (looked up in
  `threads`; same session may map to multiple threads after `/resume`, so route
  to the thread that owns the current run, else the most recently active).
- Resync is **idempotent by part id**: the renderer tracks assistant message id
  and part ids and replaces rather than appends, so reconnects do not duplicate.
- Per-run buffers are capped; overflow flushes to a new Discord message.
- Terminal-originated turns (a user typing in `opencode attach` in the same
  sandbox) arrive with no Discord run; they are rendered into the owning
  session's most recent thread if one exists, else ignored.

### Run state machine (per thread)

States: `idle`, `running`, `aborting`, `errored`.

| From | Trigger | To | Action |
|---|---|---|---|
| idle | prompt | running | ensure session, `prompt_async`, start renderer |
| running | `session.idle` | idle | finalize render, drain queue |
| running | `session.error` | idle | post error, drain queue |
| running | `/abort` | aborting | `session.abort`, start 10s timer |
| running | new message | running | enqueue (bounded), post "queued (n)" |
| aborting | `session.idle`/ack | idle | clear queue |
| aborting | 10s timeout | idle | force-finalize, clear queue |
| aborting | new message | aborting | enqueue (sent after idle) |
| any | server/sandbox death | errored | notify; `ensureReady` on next prompt |
| errored | `ensureReady` ok | idle | resume session |

- Queue is in-memory and bounded (`MAX_QUEUE`, default 20); loss on restart is
  accepted in v1 and documented. A per-thread async lock prevents two rapid
  messages racing `session.create`.
- Global cap `MAX_CONCURRENT_RUNS`; excess runs queue with a "busy" notice.
- Bot restart: for threads with a recent `last_active_at`, fetch
  `session.messages()`, reconcile the last assistant message, and either
  finalize the persisted `live_message_id` or attach a new renderer.

### Permission policy (bot-enforced)

The bootstrap config expresses the policy (last-match-wins patterns):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "allow",
    "bash": {
      "*": "allow",
      "git push*": "deny",
      "git clean -fdx*": "deny",
      "npm publish*": "deny",
      "pnpm publish*": "deny",
      "yarn publish*": "deny"
    },
    "external_directory": "deny",
    "question": "deny"
  }
}
```

- Any permission request that still surfaces is answered by the bot with
  `{ response: "once" | "always" | "reject" }` (the documented values) based on
  the policy — **no catch-all auto-allow**.
- `question: deny` prevents headless deadlocks. Surfacing questions in Discord
  is backlog.
- `external_directory: deny` keeps tools inside the mounted project.
- Plan/read-only default and an owner-only "unsafe mode" toggle are backlog.

## 9. Discord UX

Intents: Guilds, GuildMessages, MessageContent (privileged, enabled in the
portal), and `Partials.Channel` (so replies in uncached archived threads are
received). `GuildMembers` is not required (message/interaction payloads carry
the member); it can be enabled later for thread member sync.

Access control: a single `isAuthorized(member)` gate applied to **every** entry
point — `messageCreate`, chat-input interactions, autocomplete, and component
interactions. Rule: BLOCK first (deny), else allow if guild owner OR
Administrator OR Manage Server OR has `ACCESS_ROLE_ID`. Role **IDs** are used
(config accepts names as a deprecated fallback with a boot warning). Failures
get an ephemeral "not authorized".

Routing:

- Message in a registered project channel (non-thread, non-system, non-webhook,
  non-bot, non-empty): create a thread named after the sanitized first 80 chars
  of the prompt (fallback `session <timestamp>`), add the author, create a
  session, send the prompt.
- Message in a registered thread: continue that session (queue if running).
- Everything else ignored.

Streaming renderer:

- One live message per run, driven by the single send/edit chokepoint which
  always sets `allowedMentions: { parse: [] }` and suppresses link previews
  (`MessageFlags.SuppressEmbeds` where supported, else wraps bare URLs in `<>`).
- A **shared per-channel token bucket** governs all sends/edits (typing,
  status, overflow, shell output), so live-message edits do not compete with
  the bot's other messages. The 1200 ms floor is a safety net; discord.js's
  REST queue honoring `X-RateLimit-*` headers is the primary limiter. On 429,
  back off; 429s count toward Discord's invalid-request ban threshold.
- Tool parts are coalesced into the throttled edit as compact quoted status
  lines. Chunking is fence-aware: it closes/reopens fences across boundaries,
  picks a fence longer than any backtick run, hard-splits lines >1900, and caps
  every message (including footer) at <= 2000.
- Typing indicator refreshed every 8s while running.
- Finalization adds duration/token footer when available; errors post as plain
  text.

Attachments (in scope, hardened): text-like files <= `ATTACHMENT_MAX_BYTES`
(default 100 KB) are written to `.celly/inbox/<uuid>-<basename>` under the
project directory. `path.basename`, reject `/\:`, `..`, control chars, reserved
Windows device names, and trailing dots/spaces; `realpath` containment check
after resolution. Other attachment types are acknowledged and ignored.

Shell (`!cmd`): `shell.ts` calls `sbx.exec()` with argv only (`bash -lc` receives
the user command as exactly one argv element; no host shell). Output is chunked
with the same bucket and `allowedMentions` rules; truncation hides side effects
and this is stated in the reply.

Interaction lifecycle: every command that touches `sbx`/opencode calls
`deferReply` (ephemeral by default) and then edits with staged progress
("creating sandbox… installing… waiting for server…"). Long first-boot results
are posted via follow-up. Select menus (`/model`, `/agent`, `/resume`) are
ephemeral and handled with `deferUpdate`/`update`. Any reply containing a
secret (password in `/project status`) is ephemeral and masked.

## 10. Slash commands (v1)

| Command | Access | Behavior |
|---|---|---|
| `/project add <name> <path>` | owner | Register a directory under `PROJECTS_ROOT`; run create saga. |
| `/project create <name>` | owner | Create directory under `PROJECTS_ROOT`, then add. |
| `/project list` | authorized | Projects with sandbox status + health. |
| `/project status <name>` | authorized | Status, port, health, session count (ephemeral; password masked). |
| `/project start <name>` | owner | Wake sandbox + supervised server. |
| `/project stop <name>` | owner | Stop supervised server + `sbx stop`. |
| `/project remove <name>` | owner | Typed confirmation; remove sandbox/rows/channel. |
| `/new [prompt]` | authorized | New thread/session in this channel. |
| `/resume [session]` | authorized | Pick a past session (ephemeral select) in a new thread. |
| `/abort` | authorized | Abort the current run. |
| `/model` | authorized | Select model for this thread (ephemeral select). |
| `/agent` | authorized | Select agent for this thread (ephemeral select). |
| `!<command>` | authorized | Shell in the sandbox (hardened). |

Deferred to v1.1: `/project restart` (fold into stop/start), `/share`, `/diff`,
`/undo`, `/redo`, `/context-usage`. Commands are registered guild-scoped for
instant updates; `/project` uses subcommands.

## 11. Terminal coexistence

- Terminal: `sbx exec -it celly-<slug> bash`, then `opencode attach
  http://127.0.0.1:4096` (verify at spike) or `sbx run --name celly-<slug>`.
  Sessions live in the sandbox's OpenCode storage, so Discord and the terminal
  share conversations.
- The server password is stored in the DB (`projects.server_password`) and in
  `~/.config/celly/opencode.env` inside the sandbox; `/project status` shows it
  masked and ephemerally.
- OpenCode's browser UI (`opencode web`) is deferred: it raises CSRF/DNS-
  rebinding risk for a localhost control plane, and the same sessions are
  reachable via the terminal.

## 12. Security model (enforced, not assumed)

Trust boundary: the sandbox is the boundary; the bot and host are trusted; the
mounted project directory and all content inside it are untrusted.

- **No host shell interpolation.** `sbx.ts` is argv-only (`shell:false`);
  sandbox names validated by regex; project paths and `!cmd` passed as single
  argv elements. Unit tests include adversarial names/paths.
- **Path containment.** Project directories must resolve inside
  `PROJECTS_ROOT`; deny bot repo, `DATA_DIR`, user profile, and system
  directories (realpath + case-insensitive). Attachments
  live in `.celly/inbox` with the sanitization above. A single helper owns this
  logic; call sites do not hand-roll it.
- **Egress.** The sandbox policy is defined and verified (spike): provider
  hosts + package registries only, `balanced` preset as the floor, per-sandbox
  denies where useful. Because the mounted repo may contain secrets (`git`
  remotes, `.env`, tokens), it is treated as untrusted; README warns against
  secrets in project dirs.
- **Agent policy** is default-deny for the dangerous actions in §8, enforced by
  config and re-checked at the API layer. No catch-all auto-allow.
- **Secrets.** `DISCORD_TOKEN` only in `.env` (gitignored). Server password
  never on a host command line (sandbox env file, 0600), never logged, masked in
  status. Log redaction covers tokens/passwords/Authorization headers.
- **`/share` deferred** (it publishes session content publicly).
- **Resource and cost caps.** `--cpus`/`--memory` per sandbox, bounded queue,
  `MAX_CONCURRENT_RUNS`, per-user command rate limit, and a documented cost
  note; hard token-budget stop is backlog. Sandbox disk usage is monitored and
  warned.
- **Single instance.** A loopback lock listener (or Windows named mutex)
  prevents two bots from double-driving sandboxes; boot fails with a clear
  message if held.
- **Local exposure.** Ports bind loopback only and require basic auth; the
  password rotates on sandbox recreate; DB lives under an ACL-restricted
  `DATA_DIR`, with a warning if `DATA_DIR` is inside a cloud-sync folder.

## 13. Configuration

`.env` (validated at boot, fail fast):

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | required | Bot token. |
| `DISCORD_GUILD_ID` | required | Single guild v1. |
| `PROJECTS_ROOT` | required | Allowed project root. |
| `ACCESS_ROLE_ID` / `BLOCK_ROLE_ID` | unset | Role IDs (names deprecated). |
| `CATEGORY_ID` | auto-create `Forge` | Discord category. |
| `SANDBOX_TEMPLATE` | `opencode` | `sbx create` agent/template. |
| `SANDBOX_CPUS` / `SANDBOX_MEMORY` | `2` / `4g` | Resource limits. |
| `PORT_RANGE_START` / `PORT_RANGE_END` | `4300` / `4399` | Host port pool. |
| `DEFAULT_MODEL` / `DEFAULT_AGENT` | unset | Seeded into `settings`. |
| `BOOT_TIMEOUT_MS` / `HEALTH_TIMEOUT_MS` | `120000` / `30000` | Boot/health waits. |
| `EDIT_INTERVAL_MS` | `1200` | Render throttle floor. |
| `ATTACHMENT_MAX_BYTES` | `102400` | Attachment cap. |
| `MAX_QUEUE` / `MAX_CONCURRENT_RUNS` | `20` / `4` | Backpressure. |
| `DATA_DIR` | `./data` | SQLite, logs, lock. |
| `LOG_LEVEL` | `info` | Logging. |

Provider setup is documented in the README (`sbx secret set <provider>`); sbx
injects credentials at the proxy and updates running sandboxes without restart.

## 14. Error handling and recovery

| Failure | Detection | Response |
|---|---|---|
| `sbx` missing/not logged in | boot preflight | Fail fast with install/login hint. |
| Policy preset not initialized | boot preflight / create prompt timeout | Fail fast; run `sbx policy init balanced`. |
| Sandbox missing / name collision | `sbx ls --json` | Degrade + notice; recreate via create saga. |
| Sandbox stopped | exec/health fails | `ensureReady` on next prompt. |
| Port exhausted (pool full) | allocation scan | Fail the add with a clear message. |
| Create step fails | saga | Rollback: rm sandbox, free port, delete channel/row. |
| `sbx cp`/bootstrap fails | step check | Retry once, then rollback. |
| Server child exits | child `exit` | Mark degraded, notify once, re-establish on demand. |
| Port mapping drift | `sbx ports --json` at wake | Verify; best-effort re-publish (timeout-guarded). |
| SSE disconnect | stream error/close | Backoff reconnect + idempotent part-id resync. |
| OpenCode run error | `session.error` | Post error, mark idle, drain queue. |
| Abort hangs | 10s timer | Force-idle, clear queue. |
| Sandbox dies mid-run | health/child exit | Mark errored, notify, resume on next prompt. |
| Bot restart mid-run | boot reconcile | Rebuild renderer from `session.messages`; queue lost (documented). |
| Discord 429 | REST error | Back off; header-driven limiting avoids repeat. |
| Host reboot | process start | Single-instance lock; sandboxes stopped; first prompt wakes. |

## 15. Testing

- Unit (vitest, runnable in the Linux dev sandbox): config validation; slug/
  name rules (length/trailing/Unicode); port allocation; argv builders with
  adversarial inputs; `sbx ls/ports --json` parsers (recorded fixtures);
  path-containment helper (Windows/UNC/`..`/symlink cases); permission-policy
  evaluation; render chunker (fences, hard splits, 2000 cap); EventRouter
  demux/resync by part id; run state-machine transition table; DB migrations +
  FK enforcement; `sbx`-import isolation test.
- Contract: `opencode.ts`/`EventRouter` against a fake HTTP/SSE server that can
  replay recorded frames including disconnect/reconnect and terminal-originated
  turns.
- Integration (host only, `SMOKE=1`): create scratch dir → create saga → health
  → prompt "say hi" → assert streamed reply → abort → stop → remove.
- Manual Discord checklist: first-boot progress, thread flow, archived-thread
  reply after 24h, abort, queue, model/agent switch, `!` shell, sandbox
  stop/wake, bot restart mid-run, rate-limit header behavior.

## 16. Deployment (Windows 11 host)

1. **Host bootstrap (once, interactive, as the logged-in user):**
   - Enable Windows Hypervisor Platform (`Enable-WindowsOptionalFeature
     -Online -FeatureName HypervisorPlatform -All`).
   - Install `sbx` (`winget install -h Docker.sbx`).
   - Run `sbx setup`.
   - `sbx login`.
   - `sbx policy init balanced` (required before the first sandbox).
   - `sbx secret set <provider>` for each provider.
   - Pin sbx >= 0.45.0; document the version in the README.
2. Install Node 24.x (pinned version, not "LTS"), clone the repo, `npm ci`,
   `npm run build`, fill `.env`.
3. Run `node dist/index.js` (dev: `npm run dev`). Bot performs a preflight
   (`sbx version`, policy check, single-instance lock) and fails fast.
4. Persistence: **Task Scheduler at logon, running as the logged-in user** (the
   sbx daemon and credentials are per-user; NSSM/LocalSystem does **not** work).
   For headless re-login use the sbx PAT flow. Logs in `data/bot.log`.
5. Discord developer portal: create app, enable Message Content intent, invite
   with scopes `bot` + `applications.commands` and permissions: View Channels,
   Send Messages, Send Messages in Threads, Create Public Threads, Manage
   Channels, Manage Threads, Read Message History, Embed Links.

## 17. Decisions log

- **Native host, not Docker** — only the host can call `sbx`. Fallback bridge
  documented.
- **Supervised long-lived `sbx exec ... opencode serve` child, not `nohup`** —
  `sbx create` sandboxes idle-stop and exec has no detach; an active exec is a
  session, gives logs, and removes the `pkill`/`nohup` footgun.
- **SDK over published loopback port** — full API with stable formats; ports
  serialized, actual mapping read back from `sbx ports --json`.
- **Eager create at `/project add`** — with a rollback saga and staged progress.
- **Thread = session; worktrees deferred** — `worktree_path` reserved; dynamic
  mounts (sbx 0.45+) may make per-thread worktrees cheaper later.
- **Bot-enforced permission policy, not blanket auto-allow** — default-deny for
  push/publish/`external_directory`; `question` disabled.
- **`serve`, not `web`** — avoids localhost CSRF/DNS-rebinding surface.
- **`node:sqlite` + migrations** — avoids native build tools on Windows.
- **`sbx.ts` argv-only** — hard invariant against host command injection.
- **Task Scheduler at logon** — sbx is per-user.
- **v1 command set trimmed** — shell + attachments in, share/diff/undo/redo/
  context-usage/restart deferred.

## 18. Backlog (v1.1+)

Deferred commands (`/project restart`, `/share` (owner-gated), `/diff`,
`/undo`, `/redo`, `/context-usage`), worktree-per-thread, `/btw` forks, queue UI
(`. queue`), permission approval buttons, `question` -> Discord components,
admin localhost website, OpenCode web UI with Origin/Host validation, idle
auto-stop, audit log, token/cost budget with hard stop, plan/read-only default
with owner "unsafe mode", multi-guild, cloud sandboxes, OAuth subscription
login, image/voice attachments, diff web viewer, forum-channel layout,
Linux/macOS deployment docs.

## 19. Spikes / verification items

Ordered by risk; items 1-3 gate the implementation plan.

1. **Full-chain spike (day one).** `sbx create` → supervised `sbx exec` serve
   child → survives and keeps the sandbox awake → port reachable on loopback →
   basic auth works → SDK SSE yields usable text-delta/idle events. If this
   breaks, the design changes materially.
2. **First-run policy behavior.** Confirm `sbx policy init` requirement and
   that a non-TTY `sbx create` without it fails clearly rather than hanging.
3. **sbx CLI contract.** `sbx ls --json` / `sbx ports --json` shapes (save
   fixtures); name length/trailing rules; whether create-time `-e` persists
   into later `sbx exec` (we avoid relying on it via the sandbox env file).
4. **Credential injection + egress.** Manually launched `opencode serve`
   inherits proxy env and gets `sbx secret` injection; define the egress
   allowlist and verify per-sandbox denies.
5. **Windows host→sandbox path mapping.** Resolve the in-sandbox workspace path
   once; verify `sbx exec` default cwd; record in `projects.sandbox_path`.
6. **`node:sqlite` on Node 24 Windows** (`ExperimentalWarning` acceptable) plus
   `user_version` migration and FK behavior.
7. **Discord details.** Edit-bucket headers under the shared token bucket;
   `Partials.Channel` behavior for archived-thread replies; `startThread` on
   non-system messages.
8. **Permission enforcement precedence.** Verify `OPENCODE_CONFIG` is honored
   for the celly config file, that project-level `opencode.json` cannot loosen
   the celly policy, or that the API-layer enforcement reliably overrides it.
9. **SDK auth + event names/payloads.** Basic-auth mechanism; exact SSE event
   names and part shapes; record fixtures for the fake server.
10. **Single-instance lock** behavior on Windows (port listener vs named mutex).
