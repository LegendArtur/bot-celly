# Cely

Cely is a Discord bot that turns Discord into a control surface for OpenCode
coding agents, where every project runs inside an isolated `sbx` (Docker
Sandboxes) microVM on the host machine. The name is short for **Celebrimbor**,
the elven smith of Eregion who forged the Rings of Power: the Discord category
is **Eregion** (the forge-realm) and each sandbox is `cely-<slug>` — one ring,
one workshop. This is a deliberately lightweight re-implementation of the
command surface of [remorses/kimaki](https://github.com/remorses/kimaki) (MIT),
with `sbx` sandboxes replacing Kimaki's local process management.

- **Channel = project** = one `sbx` sandbox + one host directory.
- **Thread = conversation** = one OpenCode session.
- The bot runs **natively on the sbx host** (Windows 11 for v1), because only the
  host can invoke the `sbx` CLI. It supervises one long-lived
  `sbx exec ... opencode serve` child per project and talks to it over the
  sandbox's published loopback port using the `@opencode-ai/sdk`.
- Provider credentials are injected by `sbx secret` at the host proxy; they are
  never stored in the bot or the repository.

> **The Tolkien name is for private use.** If this project is ever published,
> the branding must be renamed.

## Prerequisites

- **Windows 11** host (v1). The bot cannot run in a Linux container: only the
  host can execute the Windows `sbx` binary and reach host sandboxd.
- **Docker Sandboxes `sbx` >= 0.45.0**, installed and logged in.
- **Node 24.x** exactly (pinned by `engines` and `.nvmrc`), not "LTS".
- A Discord application with a bot token, and a single Discord guild.
- An OpenCode provider configured through `sbx secret` (see below).

## Host bootstrap checklist (once, interactive, as the logged-in user)

Run these on the Windows host before the first bot start:

1. Enable the Windows Hypervisor Platform (elevated PowerShell):
   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
   ```
2. Install `sbx`:
   ```powershell
   winget install -h Docker.sbx
   ```
3. Run the host prep step:
   ```powershell
   sbx setup
   ```
4. Log in to Docker:
   ```powershell
   sbx login
   ```
5. Initialize the network policy preset. This is **required before the first
   sandbox**, otherwise `sbx create` blocks on an interactive prompt:
   ```powershell
   sbx policy init balanced
   ```
6. Register provider credentials (repeat for each provider). `sbx` injects
   these at the proxy and updates running sandboxes without a restart:
   ```powershell
   sbx secret set <provider>
   ```
7. Pin and record the sbx version (>= 0.45.0): `sbx version`.

## Configure

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored and is the
single source of truth for configuration. All values are validated at boot; the
bot fails fast on a missing or malformed value.

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | required | Bot token. |
| `DISCORD_GUILD_ID` | required | Single guild v1. |
| `PROJECTS_ROOT` | required | Allowed project root. |
| `ACCESS_ROLE_ID` / `BLOCK_ROLE_ID` | unset | Role IDs (names deprecated). |
| `CATEGORY_ID` | auto-create `Eregion` | Discord category. |
| `SANDBOX_TEMPLATE` | `opencode` | `sbx create` agent/template. |
| `SANDBOX_CPUS` / `SANDBOX_MEMORY` | `2` / `4g` | Resource limits. |
| `PORT_RANGE_START` / `PORT_RANGE_END` | `4300` / `4399` | Host port pool. |
| `DEFAULT_MODEL` / `DEFAULT_AGENT` | unset | Seeded into `settings`. |
| `BOOT_TIMEOUT_MS` / `HEALTH_TIMEOUT_MS` | `120000` / `30000` | Create-saga health wait / `ensureReady` health wait. |
| `EDIT_INTERVAL_MS` | `1200` | Render throttle floor. |
| `ATTACHMENT_MAX_BYTES` | `102400` | Attachment cap. |
| `MAX_QUEUE` / `MAX_CONCURRENT_RUNS` | `20` / `4` | Backpressure. |
| `DATA_DIR` | `./data` | SQLite, logs, lock. |
| `LOG_LEVEL` | `info` | Logging. |

`PROJECTS_ROOT` is not runtime-editable (security).

> **Caveat — do not put `PROJECTS_ROOT` under the user profile.** The sensitive
> path denylist includes the user's home directory (`HOME`/`USERPROFILE`) and
> `DATA_DIR`; a project directory that overlaps a forbidden root is rejected by
> `isSensitivePath`. Because the check rejects both ancestors and descendants of
> a forbidden root, a `PROJECTS_ROOT` such as `C:\Users\you\projects` would be
> rejected in full and no project could be mounted. Use a path outside the
> profile (e.g. `D:\projects`), or move `DATA_DIR` out of `PROJECTS_ROOT`. This
> is spec-mandated behavior, not a bug.

## Install, build, run

```powershell
npm ci
npm run build
node dist/index.js
```

For development use `npm run dev` (runs `tsx watch src/index.ts`). On boot the
bot performs a preflight (`sbx version`, policy check, single-instance lock) and
fails fast with an actionable message. Logs are written to `data/bot.log`.

Run the host-only smoke check (creates a sandbox, runs `opencode --version`, and
removes it):

```powershell
node scripts/smoke.mjs C:\path\to\a\project\dir
```

## Run at logon (Task Scheduler)

`sbx` and its credentials are **per-user**, so the bot must run as the
logged-in user. **NSSM / LocalSystem does not work.** Create a Task Scheduler
task that runs at logon:

- **Trigger:** At log on (of the user who owns the `sbx` daemon).
- **Action:** Start a program — `node.exe` (full path), arguments
  `dist\index.js`, "Start in" the repo root.
- **Settings:** uncheck "Stop the task if it runs longer than…"; enable
  "Restart on failure" if desired.

See [`docs/deployment-windows.md`](docs/deployment-windows.md) for the full
walkthrough, including the PAT flow for headless re-login.

## Discord setup

In the Discord Developer Portal, enable the **Message Content** privileged
intent, then invite the bot with scopes `bot` + `applications.commands` and
these permissions:

- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Manage Channels
- Manage Threads
- Read Message History
- Embed Links

## Security warning

**Project directories are untrusted and may contain secrets.** The mounted
project directory (and everything in it, including `git` remotes, `.env` files,
and tokens) is treated as untrusted input by the design. Do not place secrets in
a project directory that you would not expose to the sandboxed agent, and keep
provider credentials in `sbx secret` rather than in project files.
