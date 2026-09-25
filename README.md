# Celly

> A Discord forge for coding agents.

Celly turns Discord into a control surface for [OpenCode](https://opencode.ai)
coding agents. Each project gets its own isolated `sbx` (Docker Sandboxes)
microVM on your host, and you drive it from a Discord channel and thread. Start
a session from your phone, watch it work, and pick it back up later.

## Why

Coding agents are long-running and personal, but they are usually tied to one
terminal on one machine. Celly moves the control surface somewhere you already
are: Discord. Projects become channels, conversations become threads, and every
project runs inside its own disposable sandbox — so an agent can work freely
without touching the rest of your machine.

## Contents

- [What it is](#what-it-is)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Security model](#security-model)
- [How it works](#how-it-works)
- [Development](#development)
- [Project layout](#project-layout)
- [Status / roadmap](#status--roadmap)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Credits / Acknowledgements](#credits--acknowledgements)

## What it is

- **Channel = project** — one `sbx` sandbox and one host directory.
- **Thread = session** — one OpenCode conversation.
- The bot runs **on the `sbx` host** (Windows 11 for v1), because only the host
  can invoke the `sbx` CLI. It supervises one long-lived
  `sbx exec ... opencode serve` child per project and talks to it over the
  sandbox's published loopback port using the `@opencode-ai/sdk`.
- Provider credentials are injected by `sbx secret` at the host proxy. They are
  never stored in the bot or the repository.

Celly is a deliberately lightweight re-implementation of the command surface of
[remorses/kimaki](https://github.com/remorses/kimaki) (MIT), with `sbx`
sandboxes replacing Kimaki's local process management.

## Features

- **Per-project sandbox isolation.** Every project owns a microVM; the host
  filesystem outside the mounted project directory is unreachable by the agent.
- **Streaming replies.** Assistant text and tool activity are streamed into the
  thread and throttled into a single live message.
- **Session resume.** `/resume` reopens a past OpenCode session in a new thread.
- **Model and agent switching.** `/model` and `/agent` pick per-thread settings.
- **Abort.** `/abort` stops the current run (in a thread) or every active run in
  the project channel.
- **Shell.** A message starting with `!` runs `bash -lc <command>` inside the
  project's sandbox and posts the output.
- **Text attachments.** Text-like attachments are size-capped, written to a
  validated `.celly/inbox`, and referenced in the prompt.
- **Shell-output truncation.** Long shell output is chunked and truncated to
  three messages with a total-length footer.
- **Access control.** Guild owner, `Manage Guild`/`Administrator`, an access
  role, and a block role (role IDs).
- **Approval-free agent with a hardened permission policy.** The agent runs
  without prompting; a bot-enforced bash/read deny list blocks publish, push,
  and env-file inspection, and the policy is re-asserted after every wake.

## Architecture

```
 Discord (channel = project, thread = session)
        │
        ▼
 ┌──────────────────── host (Node 24, Windows 11) ────────────────────┐
 │  Celly bot                                                          │
 │    • Discord gateway + slash commands                              │
 │    • ProjectService: create / wake / stop one sbx per project      │
 │    • Runner + Renderer: queue prompts, stream and throttle replies │
 │    • EventRouter: SSE /global/event  →  thread / session routing   │
 │                                                                     │
 │  127.0.0.1:<port>   (Authorization: Basic opencode:<password>)     │
 └───────────────────────────────┬─────────────────────────────────────┘
                                 ▼
                       ┌───────────────────┐
                       │  sbx microVM      │   one per project
                       │   opencode serve  │   (sandbox port 4096)
                       │   mounted project │
                       └───────────────────┘
```

### Module map

| Module | Responsibility |
|---|---|
| `src/index.ts` | Composition root: config, preflight, Discord wiring, services. |
| `src/config.ts` | Env parsing/validation, defaults, first-boot settings seed. |
| `src/discord.ts` | Discord client, authorization, message gating. |
| `src/commands.ts` | Slash-command definitions, interaction/select handlers. |
| `src/handlers.ts` | `messageCreate`, project down/missing, shutdown, reconcile. |
| `src/projects.ts` | Project lifecycle: create saga, wake, recreate, stop, remove. |
| `src/sbx.ts` | `sbx` CLI runner, JSON parsing, path/name validation, port allocation. |
| `src/opencode.ts` | OpenCode client, config/env policy, bootstrap, health check. |
| `src/runner.ts` | Per-thread prompt queue, run lifecycle, permission policy checks. |
| `src/render.ts` | Live-message rendering, chunking, payload sanitization. |
| `src/events.ts` | SSE event normalization, session routing, reconnect/resync. |
| `src/routing.ts` | Session ↔ thread route table. |
| `src/attachments.ts` | Text-attachment download, inbox containment, safe writes. |
| `src/shell.ts` | `!cmd` execution and output truncation. |
| `src/bucket.ts` | Per-channel token bucket for Discord rate limits. |
| `src/db.ts` | SQLite persistence for projects and threads. |
| `src/lock.ts` | Single-instance lock. |
| `src/log.ts` | Structured logger with secret redaction. |
| `src/helpers.ts` | Shared helpers (category, channel names, prompt text). |
| `src/types.ts` | Shared domain types. |

## Requirements

- **Windows 11 host** (or macOS/Linux where `sbx` runs). The bot cannot run
  inside a Linux container: only the host can execute the `sbx` binary and reach
  the host sandbox daemon.
- **Node 24.x** exactly (pinned by `engines` and `.nvmrc`).
- **Docker Sandboxes `sbx` >= 0.45**.
- A Docker login and an initialized network policy (`sbx policy init balanced`).
- A Discord application with a bot token and the **Message Content** intent, and
  a single Discord guild.
- An OpenCode provider configured through `sbx secret`.

## Quick start

### 1. Host bootstrap (once, interactive, as the logged-in user)

```powershell
winget install -h Docker.sbx     # install sbx
sbx setup                        # host prep
sbx login                        # log in to Docker
sbx policy init balanced         # required before the first sandbox
sbx secret set <provider>        # repeat per provider
```

`sbx` injects provider credentials at the proxy and updates running sandboxes
without a restart. Pin and record the version with `sbx version`.

### 2. Install and configure

```powershell
git clone https://github.com/<your-username>/celly.git
cd celly
npm ci
npm run build
copy .env.example .env    # macOS/Linux: cp .env.example .env
```

Set **only** `DISCORD_TOKEN` and `DISCORD_GUILD_ID` in `.env`. Every other
setting has a working default. `PROJECTS_ROOT` defaults to
`~/Celly/projects` (`%USERPROFILE%\Celly\projects` on Windows).

### 3. Run

```powershell
node dist/index.js
```

On boot the bot performs a preflight (`sbx version`, policy check, single
instance lock) and fails fast with an actionable message. Logs are written to
`data/bot.log`. See [`docs/deployment-windows.md`](docs/deployment-windows.md)
for running it at logon with Task Scheduler.

## Configuration

`.env` is the single source of truth. It is loaded automatically at startup
(`process.loadEnvFile`), is gitignored, and is validated at boot.

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | **required** | Bot token. |
| `DISCORD_GUILD_ID` | **required** | Single guild for v1. |
| `PROJECTS_ROOT` | `~/Celly/projects` | Allowed project root; created on boot. |
| `ACCESS_ROLE_ID` / `BLOCK_ROLE_ID` | unset | Role **IDs** only. |
| `OWNER_ROLE_ID` | unset | Owner-only role ID for `/project` mutations (guild owner always allowed). |
| `CATEGORY_ID` | auto-create `Forge` | Discord category. |
| `SANDBOX_TEMPLATE` | `opencode` | `sbx create` agent/template. |
| `SANDBOX_CPUS` / `SANDBOX_MEMORY` | `2` / `4g` | Resource limits. |
| `PORT_RANGE_START` / `PORT_RANGE_END` | `4300` / `4399` | Host loopback port pool. |
| `DEFAULT_MODEL` / `DEFAULT_AGENT` | unset | Seeded into `settings` on first boot. |
| `BOOT_TIMEOUT_MS` / `HEALTH_TIMEOUT_MS` | `120000` / `30000` | Create-saga health wait / wake health wait. |
| `EDIT_INTERVAL_MS` | `1200` | Render throttle floor. |
| `ATTACHMENT_MAX_BYTES` | `102400` | Text-attachment cap. |
| `MAX_QUEUE` / `MAX_CONCURRENT_RUNS` | `20` / `4` | Backpressure. |
| `DATA_DIR` | `./data` | SQLite, logs, lock file. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |

## Commands

| Command | Where | Description |
|---|---|---|
| `/project add <name> <path>` | guild | Register an existing directory under `PROJECTS_ROOT`. |
| `/project create <name>` | guild | Create a project directory under `PROJECTS_ROOT`. |
| `/project list` | guild | List projects with status and health. |
| `/project status <name>` | guild | Project status, host port, and session count. |
| `/project start <name>` | guild | Wake the sandbox (recreates it if missing). |
| `/project stop <name>` | guild | Stop the sandbox. |
| `/project remove <name> <confirm>` | guild | Remove the sandbox, project, and channel. |
| `/new [prompt]` | project channel | Start a new session (optionally with a first prompt). |
| `/resume` | project channel | Pick a past session to resume in a new thread. |
| `/abort` | channel or thread | Abort the current run (or all runs in the channel). |
| `/model` | thread | Choose the model for this thread. |
| `/agent` | thread | Choose the agent for this thread. |
| `!<command>` | channel or thread | Run a shell command in the sandbox. |

Sending a plain message in a project channel creates a thread; sending one in a
thread continues that session.

## Security model

- **argv-only spawns.** Every `sbx` invocation uses `spawn(bin, args, { shell:
  false })`; no command is ever passed through a shell.
- **Per-project microVM.** Each project runs in its own `sbx` sandbox with only
  its project directory mounted.
- **Path containment.** Project paths must resolve inside `PROJECTS_ROOT`, and a
  denylist rejects sensitive subtrees (`.ssh`, `.aws`, `.gnupg`, `.config`,
  `.docker`, `.kube`, `.azure`, `.npmrc`, `.netrc`, `.celly`, `AppData`),
  `DATA_DIR`, the bot repo, and system directories.
- **Loopback + password.** The generated sandbox config enables password auth
  (`OPENCODE_SERVER_PASSWORD`) and the server is published only on loopback.
- **Bot-enforced permission policy.** `opencode serve` runs with `share:
  disabled`, `*` allowed, a bash deny list (`git push`, publish/clean, and any
  command or path touching `opencode.env` or `~/.config/celly/`), and
  `external_directory`/`question` denied. The policy is PATCHed and asserted
  after every wake so a project-level `opencode.json` cannot weaken it.
- **Secrets never in argv or Discord.** Provider credentials live in `sbx
  secret`; the per-project server password lives in SQLite and is redacted from
  logs.

The deny list is defense-in-depth, not a hard isolation boundary: an agent
allowed to run bash can still run arbitrary *allowed* commands. The blast radius
is contained by the microVM — `OPENCODE_SERVER_PASSWORD` only guards a
loopback-published port reachable from inside the sandbox and the host's
`127.0.0.1`, and provider credentials are injected by the `sbx` proxy rather
than stored in the sandbox.

## How it works

1. **Create saga.** `ProjectService.addProject` serializes all creates, picks a
   sandbox name (`celly-<slug>`) and a free host port, creates the channel,
   inserts a `provisioning` row, runs `sbx create`, bootstraps the OpenCode
   config/env, starts the serve child, waits for health, and asserts the policy.
   Failures roll back the sandbox, row, and channel.
2. **Supervised serve child.** One `sbx exec ... opencode serve` child per
   project, adopted on wake if a healthy orphan is found, killed and restarted
   if it exits unexpectedly.
3. **SSE event router.** One subscription per project reads
   `/global/event` over SSE, normalizes frames, routes them to a thread by
   session id, and resyncs known sessions after a reconnect.
4. **Thread/session mapping.** Threads store their OpenCode session id in
   SQLite; a route table maps session ids back to the active thread.
5. **Restart recovery.** On boot, `ready` projects are re-subscribed and threads
   left `running`/`aborting` are recovered from session history.

## Development

```powershell
npm run dev          # tsx watch src/index.ts
npm test             # full vitest suite
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.json
```

Two host-only scripts exercise the real chain and are not run by the Linux test
suite:

```powershell
node scripts/spike-full-chain.mjs            # sbx + serve + health spike
node scripts/smoke.mjs C:\path\to\project    # create → prompt → abort → remove
```

See [`docs/spikes/2026-09-25-full-chain.md`](docs/spikes/2026-09-25-full-chain.md).

## Project layout

```
src/            bot source (see the module map)
test/           vitest suites and recorded fixtures
scripts/        host-only spike and smoke helpers
docs/           deployment guide, spike notes, spec, and plan
  superpowers/
    specs/      v1 design spec
    plans/      v1 implementation plan
data/           runtime SQLite, logs, lock (gitignored)
dist/           build output (gitignored)
```

## Status / roadmap

v1 is the command set above. Deferred backlog items:

- **Commands:** `/project restart`, `/share`, `/diff`, `/undo`, `/redo`,
  `/context-usage`.
- **Thread/conversation:** worktree-per-thread, `/btw` forks, queue UI
  (`. queue`), permission-approval buttons, and `question` rendered as Discord
  components.
- **Input:** voice messages and image attachments (text-like attachments and
  `!shell` are in scope).
- **Surfaces:** OpenCode web UI, admin website, diff web viewer, tunnels /
  screenshare, forum-channel layout.
- **Scale/deploy:** multi-guild, cloud sandboxes, `--clone` sandbox mode, OAuth
  subscription login, Linux/macOS deployment docs.

## Limitations

- **The message queue is lost on restart.** Queued prompts are held in memory
  only. A restart mid-run re-attaches the active renderer from session history,
  but queued-but-unsent messages are dropped.
- **Role names are not accepted** for `ACCESS_ROLE_ID` / `BLOCK_ROLE_ID` /
  `OWNER_ROLE_ID`; configure role IDs.
- **The finalization token/duration footer is descoped.** Replies do not append
  a token or duration footer in v1.
- **Per-user command rate limiting is backlog.** Discord's own REST limits are
  honored through the shared per-channel token bucket, but there is no
  additional per-user command budget.
- **Per-run correlation ids are backlog.** Logs carry project/thread context but
  not a distinct run id.
- **Sandbox disk-usage warnings are backlog.** Disk use is not monitored.
- **`DATA_DIR` cloud-sync detection is backlog.** Keep `DATA_DIR` outside
  OneDrive/Dropbox yourself.
- **Host-only items** (the spike, `sbx policy ls` semantics, Windows path
  mapping, and live Discord behavior) are exercised manually on the host, not in
  the Linux dev/test environment.

## Troubleshooting

- **`Error: Used disallowed intents` on startup** — enable the **Message
  Content Intent**: Developer Portal → your app → **Bot** → **Privileged Gateway
  Intents** → toggle it on → Save, then restart.
- **`Celly is already running`** — another instance holds the single-instance
  lock. Stop it before starting a new one.
- **A project stops responding** — run `/project start <name>` to wake or
  recreate its sandbox, then check `data/bot.log`.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

- Run `npm test`, `npm run typecheck`, and `npm run build`.
- Keep the **argv-only invariant**: never pass user input through a shell.
- Add tests for behavior changes; the suite is the contract.

## License

MIT. See [LICENSE](LICENSE).

## Credits / Acknowledgements

- Inspired by [remorses/kimaki](https://github.com/remorses/kimaki) (MIT).
- Built on [Docker Sandboxes](https://www.docker.com/products/docker-sandboxes/)
  (`sbx`) and [OpenCode](https://opencode.ai).
