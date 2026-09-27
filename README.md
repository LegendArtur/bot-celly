# Celly

> A Discord forge for coding agents.

[![Docs](https://img.shields.io/badge/docs-celly.agub.dev-7C3AED)](https://celly.agub.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24%20%3C25-brightgreen)](package.json)
[![CI](https://github.com/LegendArtur/bot-celly/actions/workflows/ci.yml/badge.svg)](https://github.com/LegendArtur/bot-celly/actions/workflows/ci.yml)
[![Changelog](https://img.shields.io/badge/changelog-celly.agub.dev%2Fchangelog-7C3AED)](https://celly.agub.dev/changelog)
[![Inspired by Kimaki](https://img.shields.io/badge/inspired%20by-kimaki-7C3AED)](https://github.com/remorses/kimaki)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

Celly turns [Discord](https://discord.com) into a control surface for
[OpenCode](https://opencode.ai) coding agents. Every project gets its own
isolated `sbx` (Docker Sandboxes) microVM on your host, and you drive it from a
Discord channel and thread. Start a session from your phone, watch it work, and
pick it back up later.

Inspired by [Kimaki](https://github.com/remorses/kimaki) — Celly reimplements its
core idea (channels as projects, threads as sessions) and runs each project in a
`sbx` sandbox instead of a local process.

**Documentation:** https://celly.agub.dev

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Security](#security)
- [Development](#development)
- [Status / roadmap](#status--roadmap)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)
- [Credits](#credits)

## Features

- **Per-project sandbox isolation.** Every project owns a microVM; the host
  filesystem outside the mounted project directory is unreachable by the agent.
- **Streaming replies.** Assistant text and tool activity stream into the thread,
  throttled into a single live message.
- **Session resume.** `/resume` reopens a past OpenCode session in a new thread.
- **Model and agent switching.** `/model` and `/agent` pick per-thread settings.
- **Abort.** `/abort` stops the current run, or every active run in the channel.
- **Approvals.** `/mode` picks `auto`, `buttons`, or `plan`; `buttons` posts
  permission requests as Discord buttons and agent questions as
  buttons/selects/modals. Decisions are written to a best-effort audit log.
- **Shell.** A message starting with `!` runs `bash -lc <command>` inside the
  project's sandbox.
- **Text attachments.** Size-capped, written to a validated inbox, referenced in
  the prompt.
- **Terminal coexistence.** The same sessions are reachable from `opencode
  attach` inside the sandbox.
- **Access control.** Guild owner, `Manage Guild`/`Administrator`, an access
  role, and a block role.
- **Hardened permission policy.** A bot-enforced deny list blocks publish, push,
  and env-file inspection, and is re-asserted after every wake.

## Architecture

```
Discord (channel = project, thread = session)
                                   │
                                   ▼
┌──────────────────── host (Node 24, Windows 11) ─────────────────────┐
│  Celly bot                                                          │
│    • gateway + slash commands                                       │
│    • Runner + Renderer: run state and streaming edits               │
│    • EventRouter: SSE /global/event -> thread routing               │
│    • ProjectService: create / wake / stop one sbx per project       │
│    • SQLite: projects, threads                                      │
│                                                                     │
│  127.0.0.1:HOSTPORT   (Basic auth)                                  │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
                         ┌───────────────────┐
                         │  sbx microVM      │   one per project
                         │   opencode serve  │   sandbox port 4096
                         │   mounted project │
                         └───────────────────┘
```

See the [architecture reference](https://celly.agub.dev/reference/architecture)
for the module map, create saga, and boot recovery.

## Requirements

- **Windows 11 host** (or macOS/Linux where `sbx` runs). The bot cannot run
  inside a Linux container: only the host can execute `sbx`.
- **Node 24.x** exactly (pinned by `engines` and `.nvmrc`).
- **Docker Sandboxes `sbx` >= 0.45**.
- A Docker login and an initialized network policy (`sbx policy init balanced`).
- A Discord application with a bot token, the **Message Content** intent, and one
  or more guild IDs.
- An OpenCode provider configured through `sbx secret`.

## Quick start

1. **Bootstrap the host** (once, interactive, as the logged-in user):

   ```powershell
   winget install -h Docker.sbx
   sbx setup
   sbx login
   sbx policy init balanced
   sbx secret set <provider>
   ```

2. **Install and configure:**

   ```powershell
   git clone https://github.com/LegendArtur/bot-celly.git
   cd bot-celly
   npm ci
   npm run build
   copy .env.example .env    # macOS/Linux: cp .env.example .env
   ```

   Set **only** `DISCORD_TOKEN` and the guild list in `DISCORD_GUILD_IDS`
   (comma-separated; `DISCORD_GUILD_ID` still works for one guild).
   `PROJECTS_ROOT` defaults to `~/Celly/projects`.

3. **Run** `node dist/index.js`, then `/project add name:<name> path:<path>` and
   send a message in the new channel.

The full walkthrough is in the
[Quickstart](https://celly.agub.dev/quickstart). Every environment variable
is documented in
[Configuration](https://celly.agub.dev/guides/configuration).

## Commands

| Command | Where | Description |
|---|---|---|
| `/project add <name> <path>` | guild (owner) | Register a directory under `PROJECTS_ROOT`. |
| `/project create <name>` | guild (owner) | Create a project directory under `PROJECTS_ROOT`. |
| `/project list` | guild | List projects with status and health. |
| `/project status <name>` | guild | Status, port, and session count. |
| `/project start <name>` | guild (owner) | Wake the sandbox (recreates it if missing). |
| `/project stop <name>` | guild (owner) | Stop the sandbox. |
| `/project remove <name> <confirm>` | guild (owner) | Remove the sandbox, project, and channel. |
| `/new [prompt]` | project channel | Start a new session. |
| `/resume` | project channel | Resume a past session in a new thread. |
| `/abort` | channel or thread | Abort the current run (or all runs). |
| `/model` | thread | Choose the model for this thread. |
| `/agent` | thread | Choose the agent for this thread. |
| `/attach` | thread | Show the terminal attach command for this thread. |
| `/session-id` | thread | Show this thread's session id and attach command. |
| `/mode <auto\|buttons\|plan>` | project channel or thread (owner) | Set the channel approval mode. |
| `/task add <channel> <prompt> <every_minutes>` | guild (owner) | Schedule a recurring prompt in a project channel. |
| `/task list` | guild | List scheduled tasks. |
| `/task remove <id>` | guild (owner) | Remove a scheduled task. |
| `!<command>` | channel or thread | Run a shell command in the sandbox. |

Full details and the deferred list are in the
[commands reference](https://celly.agub.dev/reference/commands).

## Security

Every `sbx` call is argv-only (`shell: false`), each project runs in its own
microVM, project paths are contained under `PROJECTS_ROOT` and checked against a
sensitive-path denylist, the server is loopback-only with a generated password,
and a bot-enforced permission policy is re-asserted after every wake. Provider
credentials live in `sbx secret` and never touch argv or Discord.

The deny list is defense-in-depth, not a hard boundary — the sandbox is. Read
the [security reference](https://celly.agub.dev/reference/security) for the
full model.

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

Docs live in `docs-site/` (`npm run docs:dev`, `npm run docs:validate`,
`npm run docs:links`).

## Status / roadmap

v1 is the command set above. Deferred to v1.1:

- **Commands:** `/project restart`, `/share`, `/diff`, `/undo`, `/redo`,
  `/context-usage`.
- **Thread/conversation:** worktree-per-thread, `/btw` forks, queue UI.
- **Input:** voice messages and image attachments.
- **Surfaces:** OpenCode web UI, admin website, diff viewer, tunnels/screenshare,
  forum-channel layout.
- **Scale/deploy:** cloud sandboxes, `--clone` sandbox mode, OAuth
  subscription login, and Linux/macOS deployment docs.

## Limitations

- **The message queue is lost on restart.** Queued-but-unsent prompts are
  dropped; active runs re-attach from session history.
- **Role names are not accepted** for role configuration; use role IDs.
- **The finalization token/duration footer is descoped.**
- **Access control is global across guilds.** The same role IDs apply to every
  configured guild; per-guild roles are not supported. A configured guild the bot
  cannot see is skipped at startup with a warning.
- **Per-user command rate limiting, sandbox disk-usage warnings, and `DATA_DIR`
  cloud-sync detection are backlog.** Keep `DATA_DIR` out of synced folders.
- **Host-only items** (the spike, `sbx policy ls` semantics, Windows path
  mapping, live Discord behavior) are exercised on the host, not in the Linux
  test environment.

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm test`,
`npm run typecheck`, and `npm run build`. Keep the **argv-only invariant**, add
tests for behavior changes, add a changeset for behavior changes, and never
commit secrets. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md);
report vulnerabilities via [SECURITY.md](SECURITY.md), not a public issue. See
[Contributing](https://celly.agub.dev/contributing) for details.

## License

MIT. See [LICENSE](LICENSE).

## Credits

- Inspired by [remorses/kimaki](https://github.com/remorses/kimaki) (MIT).
- Built on [Docker Sandboxes](https://www.docker.com/products/docker-sandboxes/)
  (`sbx`) and [OpenCode](https://opencode.ai).
