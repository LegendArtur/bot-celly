# Spike: full chain (`sbx` + `opencode serve` + health)

Date: 2026-09-25
Task: Task 2 — Host spikes and recorded fixtures
Script: `scripts/probe-serve.mjs` (serve spawn) and `scripts/smoke.mjs` (full chain)

## Status: HOST-VERIFIED

The maintained host diagnostics are `scripts/probe-serve.mjs` (exact serve
spawn) and `scripts/smoke.mjs` (full chain). Both import the real spawn and
bootstrap builders from `dist/opencode.js`, so run `npm run build` first.

This spike was run on the Windows host. `scripts/probe-serve.mjs` printed
`opencode server listening on http://0.0.0.0:4096`, and the `scripts/smoke.mjs`
run reached `health OK`, session creation, and prompt dispatch; the `reply OK`
step is blocked only by missing provider credentials in the scratch sandbox.
The fixtures in `test/fixtures/` remain the brief's **expected shapes**: the run
did not capture the raw `sbx ls --json` / `sbx ports --json` output.

## Prerequisites

- `sbx` on `PATH` (`sbx version` succeeds) and logged in (`sbx login`).
- The `opencode` image/template available locally for `sbx create opencode`.
- Network policy initialized (`sbx policy init balanced`), otherwise `sbx
  create` blocks on an interactive prompt.
- Port `4399` free on the host loopback.

## Command (run on the Windows host)

From the repo root, in PowerShell (after `npm run build`):

```powershell
node scripts/probe-serve.mjs <sandbox>
node scripts/smoke.mjs <project-dir> [hostPort]
```

`probe-serve.mjs` spawns the exact supervised serve command inside `<sandbox>`
and kills it after 10 s. `smoke.mjs` creates a scratch `celly-smoke-*` sandbox,
bootstraps it over stdin, serves it, and force-removes the sandbox on every exit
path (idempotently, so a failed run does not leave it behind). The legacy
`scripts/spike-full-chain.mjs` is superseded by these two scripts.

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

> Captured on the Windows host. Results the host run did not observe are marked
> unobserved; none are inferred.

### 1. Sandbox kept alive by supervised serve child

Verified. `scripts/probe-serve.mjs` printed
`opencode server listening on http://0.0.0.0:4096`, and the `scripts/smoke.mjs`
serve child printed the same line before answering `GET /global/health`. The
`sbx exec` running the serve child stays alive while the child runs.

### 2. Health result

Verified: `scripts/smoke.mjs` reached `health OK`. The exact response body was
not captured, so it is not recorded here.

### 3. Real `sbx ls --json` / `sbx ports --json` field names

Unobserved (environment-blocked): the host run did not capture these outputs,
so `test/fixtures/sbx-ls.json` and `test/fixtures/sbx-ports.json` keep the
brief's expected shapes.

### 4. `sbx exec` default cwd

Unobserved (environment-blocked) in the host run.

### 5. In-sandbox path of mounted workspace

Unobserved (environment-blocked) in the host run.

### 6. Full-chain smoke result

Reached: create, stdin bootstrap, verify bootstrap, supervised serve,
`health OK`, session creation, prompt dispatch. `reply OK` is
environment-blocked — the scratch sandbox warned `no OpenAI credentials
available. opencode will start logged-out`, so no assistant reply could arrive
within the wait. The steps after it (`abort OK`, `stop`) were not reached;
teardown still ran and `sbx rm --force` removed the sandbox.

## Expected fixture shapes (not yet corrected)

These are the brief's expected shapes, used by unit tests (Tasks 6, 8, 9). The
host run did not capture the raw output, so they are unchanged; correct them
once section 3 above is filled in.

`test/fixtures/sbx-ls.json`:

```json
[
  { "name": "celly-spike", "agent": "opencode", "status": "running",
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

Still open after the host run:

1. Capture `sbx ls --json` and `sbx ports <name> --json` on the host and paste
   them into section 3 above.
2. If those shapes differ from the expected fixtures, correct
   `test/fixtures/sbx-ls.json`, `test/fixtures/sbx-ports.json`, and
   `test/fixtures/opencode-events.jsonl`, then re-run the relevant unit tests
   (Tasks 6, 8, 9).
3. Re-run `scripts/smoke.mjs` with provider credentials to verify `reply OK`,
   `abort OK`, `stop`, and the success-path `smoke OK`.
