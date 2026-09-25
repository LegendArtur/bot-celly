# Deploying Cely on Windows 11

This guide covers running Cely as a long-lived service on a Windows 11 host,
including the Task Scheduler setup and the personal-access-token (PAT) flow for
re-authenticating `sbx` without an interactive browser.

The bot **must** run as the logged-in user on the host: the `sbx` daemon and its
credentials are per-user, and only the host can invoke the `sbx` CLI. NSSM or a
LocalSystem service will not work.

## 1. One-time host bootstrap

Run these steps once, in order, as the user who will own the bot. Steps 1-2 need
an elevated PowerShell prompt; the rest run as the normal user.

1. Enable the Windows Hypervisor Platform:
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
5. Initialize the network policy preset. The preset is required before the
   first sandbox, otherwise `sbx create` blocks on an interactive prompt:
   ```powershell
   sbx policy init balanced
   ```
6. Register provider credentials used by the sandboxed agent:
   ```powershell
   sbx secret set <provider>
   ```
7. Record the installed version. Cely targets `sbx` >= 0.45.0:
   ```powershell
   sbx version
   ```

## 2. Build and configure the bot

1. Install the pinned Node version (24.x) and clone the repository.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`,
   `DISCORD_GUILD_ID`, `PROJECTS_ROOT`, and any optional values. See the
   `.env` table in the [README](../README.md).
3. Install dependencies and build:
   ```powershell
   npm ci
   npm run build
   ```
4. Run the bot once in the foreground to confirm it boots:
   ```powershell
   node dist/index.js
   ```
   On boot it performs a preflight (`sbx version`, policy check, single-instance
   lock) and fails fast with an actionable message. Logs are written to
   `data/bot.log`.

## 3. Task Scheduler at logon

The task must run **only when the user is logged on**. Do not choose "Run
whether user is logged on or not": that option requires storing the account
password and can start the task outside the user's `sbx` session.

### Option A: PowerShell (recommended)

Run the following in a normal (non-elevated) PowerShell prompt. It registers a
task that starts Node with the repo as its working directory, never times out,
and restarts on failure.

```powershell
$node    = (Get-Command node).Source
$repo    = "C:\Users\artur\projects\discordAI"
$action  = New-ScheduledTaskAction -Execute $node -Argument "dist\index.js" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Cely" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Cely Discord bot" -Force
```

`-ExecutionTimeLimit ([TimeSpan]::Zero)` clears the default 72-hour limit so the
bot is not killed. Adjust `$repo` to the clone location.

To inspect, run, or remove the task:

```powershell
Get-ScheduledTask -TaskName Cely | Get-ScheduledTaskInfo
Start-ScheduledTask -TaskName Cely
Unregister-ScheduledTask -TaskName Cely -Confirm:$false
```

### Option B: Task Scheduler GUI

1. Open **Task Scheduler** and choose **Create Task** (not "Basic Task").
2. **General:** name it `Cely`; select **Run only when user is logged on**.
3. **Triggers:** add **At log on**, scoped to the user who owns `sbx`.
4. **Actions:** **Start a program** with:
   - Program/script: the full path to `node.exe` (e.g.
     `C:\Program Files\nodejs\node.exe`).
   - Add arguments: `dist\index.js`.
   - Start in: the repository root.
5. **Settings:** uncheck **Stop the task if it runs longer than…**, and enable
   **If the task fails, restart every** 1 minute (up to 3 times).

The bot's single-instance lock prevents a second copy from double-driving
sandboxes, so a logon and a manual start cannot both run.

## 4. PAT headless re-login

`sbx` normally signs in through an interactive browser. On a headless or
re-login scenario (for example, the machine reboots and the user session starts
without a browser, or the stored credential expires), the at-logon task starts
but `sbx` is not authenticated. Re-authenticate non-interactively with a Docker
**personal access token** (PAT).

1. Create a Docker PAT: sign in at https://hub.docker.com, open **Account
   settings → Personal access tokens**, and create a token with at least
   read access.
2. Feed the token to `sbx` over stdin with `--password-stdin`. Never pass the
   token as a command-line argument, where it would be visible in the process
   list and PowerShell history:
   ```powershell
   $pat   = Read-Host "Docker PAT" -AsSecureString
   $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
              [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pat))
   $plain | sbx login --username <docker-username> --password-stdin
   Remove-Variable plain
   ```
3. Verify:
   ```powershell
   sbx diagnose
   ```
4. If the bot is already running, restart the scheduled task so the daemon
   picks up the new credential:
   ```powershell
   Restart-ScheduledTask -TaskName Cely
   ```

Store the PAT the same way you store other host secrets (for example, Windows
Credential Manager) if you need to automate this step; do not commit it or put
it in `.env`.

## 5. Verifying a deployment

- `sbx diagnose` reports a healthy install, daemon, and authentication.
- `sbx policy ls` shows the `balanced` preset as the floor.
- `node scripts/smoke.mjs C:\path\to\a\project\dir` prints `smoke OK` (creates a
  sandbox, runs `opencode --version`, and removes it).
- After an at-logon start, `data/bot.log` shows the preflight passing and the
  Discord client logging in.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Boot fails: `sbx CLI not found` | `sbx` not on the user's PATH | Reinstall with `winget install -h Docker.sbx`; open a new shell. |
| Boot fails: `run sbx login` | Expired/unauthenticated session | Run the PAT flow in section 4. |
| `sbx create` hangs | Policy preset not initialized | Run `sbx policy init balanced`. |
| Bot exits: `already running` | A second instance holds the lock | Stop the other process or the duplicate scheduled task. |
| Task starts but nothing happens | Task configured as LocalSystem / "run whether logged on" | Recreate the task as "Run only when user is logged on". |
| Sandboxes not stopped after reboot | Expected | Sandboxes stop automatically when idle; the next prompt wakes them via `ensureReady`. |
