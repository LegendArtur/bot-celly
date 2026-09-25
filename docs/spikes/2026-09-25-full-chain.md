# Spike: full chain (`sbx` + `opencode serve` + health)

Date: 2026-09-25
Task: Task 2 — Host spikes and recorded fixtures
Script: `scripts/spike-full-chain.mjs`

## Status: PENDING host run

This spike **must run on the Windows host**. The dev sandbox has no `sbx` CLI
(and the host is Windows), so this step could not be executed in the sandbox.
The fixtures in `test/fixtures/` are the brief's **expected shapes**; the host
run is expected to correct the real field names and event stream.

## Command (run on the Windows host)

From the repo root, in PowerShell:

```powershell
node scripts/spike-full-chain.mjs
```

## Questions the run must answer

1. Does the supervised `serve` child keep the sandbox awake (i.e. does
   `sbx exec <name> bash -lc "exec opencode serve ..."` stay alive, or does the
   sandbox/exec terminate when the parent command returns)?
2. What is the health result? Exact `status` and response body from
   `GET http://127.0.0.1:4399/global/health`.
3. What are the **real** field names/shapes returned by `sbx ls --json` and
   `sbx ports <name> --json`? (paste both verbatim)
4. Is `sbx exec`'s default working directory the mounted project directory?
5. What is the **in-sandbox path** of the mounted workspace?

## Recorded results

> Not yet run in the sandbox. Paste host output below after running the
> command above, and update the fixtures to match.

### 1. Sandbox kept alive by supervised serve child

_PENDING_

### 2. Health result

_PENDING_

### 3. Real `sbx ls --json` / `sbx ports --json` field names

_PENDING — paste verbatim outputs._

### 4. `sbx exec` default cwd

_PENDING_

### 5. In-sandbox path of mounted workspace

_PENDING_

## Expected fixture shapes (pre-host-run)

These are the brief's expected shapes, used by unit tests (Tasks 6, 8, 9)
before the host run; correct them from the real output.

`test/fixtures/sbx-ls.json`:

```json
[
  { "name": "cely-spike", "agent": "opencode", "status": "running",
    "ports": [ { "host_ip": "127.0.0.1", "host_port": 4399, "sandbox_port": 4096, "protocol": "tcp4" } ],
    "workspace": "C:\\Users\\artur\\projects\\spike" }
]
```

`test/fixtures/sbx-ports.json`:

```json
[ { "host_ip": "127.0.0.1", "host_port": 4399, "sandbox_port": 4096, "protocol": "tcp4" } ]
```

`test/fixtures/opencode-events.jsonl`:

```jsonl
{"type":"server.connected","properties":{}}
{"type":"message.updated","properties":{"info":{"id":"msg_1","sessionID":"ses_1","role":"assistant"}}}
{"type":"message.part.updated","properties":{"part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_1","type":"text","text":"hi"}}}
{"type":"session.idle","properties":{"sessionID":"ses_1"}}
```

## Follow-up

After the host run:

1. Paste the outputs into the "Recorded results" section above.
2. Correct `test/fixtures/sbx-ls.json`, `test/fixtures/sbx-ports.json`, and
   `test/fixtures/opencode-events.jsonl` to the real shapes.
3. Re-run the relevant unit tests (Tasks 6, 8, 9).
