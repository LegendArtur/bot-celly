# Celly Cleanup & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay down the code-review debt in the Celly bot: remove duplicated/ dead code, secure the diagnostic scripts, add the missing DB index, bound log and secret growth, and align naming/typing with the rest of the codebase — with no behavior change except where explicitly stated.

**Architecture:** This is a remediation plan derived from a full read of `src/`. It does not add features. Tasks are grouped by file ownership so each lands as an independently reviewable commit. Behavior-preserving refactors are verified by the existing suite; behavior changes (DB index, log truncation, secret pruning, script rewrite) get a new failing test first.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Node 24 (`node:sqlite`, `node:child_process`), discord.js 14.27, `@opencode-ai/sdk` 1.18.32, Vitest 3, `sbx` CLI (Docker Sandboxes).

**Spec:** `docs/superpowers/specs/2026-09-25-celly-v1-design.md` is the governing architecture spec. This plan is a post-implementation cleanup pass; where the spec and this plan disagree on module boundaries, the spec wins.

## Global Constraints

- Node engine is `>=24 <25` (`package.json`). The Windows host currently runs Node 25; `npm test`, `npm run typecheck`, and `npm run build` must be green regardless.
- `src/sbx.ts` is the **only** file allowed to import `node:child_process` — `test/imports.test.ts` enforces it.
- Every spawn is argv-only with `shell: false`. Never build a shell string from user input.
- **Never put the server password on a host command line, argv, logs, or Discord.** It moves only via stdin (`sbx exec -i ... bash -s`) or inside a sandbox-owned env file.
- POSIX-style sandbox paths must keep POSIX semantics on Windows (`canon`/`joinPathLike` in `src/sbx.ts`). Do not route them through platform `path` calls.
- Commit with the configured identity (`Artur Gubaidullin <29106800+LegendArtur@users.noreply.github.com>`). One commit per task at the bottom of each task.
- Work on a branch, not directly on `main`: `git switch -c cleanup/code-review-remediation`.
- The baseline suite on this Windows host is **318 passed, 1 skipped**; the 1 skipped test is `test/bootstrap.test.ts` and is expected.

---

### Task 1: Share `basicAuth` and `partToEvent`

**Files:**
- Modify: `src/opencode.ts:6-8`
- Modify: `src/events.ts:1` (new import), `:24-39`, `:79-105`
- Modify: `src/runner.ts:1-3`, delete `:151-156`
- Test: `test/opencode.test.ts`, `test/events.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `basicAuth(password: string): string` (exported), `partToEvent(sessionId: string, messageId: string, part: any): NormalizedEvent | null` (exported from `src/events.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `test/opencode.test.ts` (update the import line to include `basicAuth`):

```ts
import { applyAndAssertCellyPolicy, BASH_DENY, basicAuth, buildCellyConfigJson, buildOpencodeEnv, buildServeArgs, cellyPolicy, createClient, resolveClient, waitForHealth } from "../src/opencode.ts"

test("basicAuth encodes the opencode user and password", () => {
  expect(basicAuth("pw")).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
})
```

Add to `test/events.test.ts` (update the import line to include `partToEvent`):

```ts
test("partToEvent maps a bare text or tool part and ignores others", () => {
  expect(partToEvent("s1", "m1", { id: "p1", type: "text", text: "hi" }))
    .toEqual({ kind: "text", sessionId: "s1", messageId: "m1", partId: "p1", text: "hi" })
  expect(partToEvent("s1", "m1", { id: "p2", type: "tool", tool: "bash", state: { status: "running" } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p2", name: "bash", status: "running" })
  expect(partToEvent("s1", "m1", { id: "p3", type: "step" })).toBeNull()
})

test("the event stream sends the opencode basic auth header", async () => {
  let auth: string | undefined
  const server = createServer((req, res) => {
    auth = req.headers.authorization
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.end()
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const router = new EventRouter({ route: () => undefined, onEvent: () => {}, onResync: async () => {}, knownSessions: () => [] })
    const ac = new AbortController()
    const done = router.subscribe(`http://127.0.0.1:${port}`, "pw", ac.signal)
    await waitFor(() => auth !== undefined)
    ac.abort()
    await done
    expect(auth).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/opencode.test.ts test/events.test.ts`
Expected: FAIL — `basicAuth` and `partToEvent` are not exported (compile/import errors).

- [ ] **Step 3: Implement**

In `src/opencode.ts`, export the helper:

```ts
export function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
}
```

At the top of `src/events.ts` add the import, then add the shared mapper and use it:

```ts
import { basicAuth } from "./opencode.js"

export function partToEvent(sessionId: string, messageId: string, part: any): NormalizedEvent | null {
  if (!part || typeof part !== "object") return null
  if (part.type === "text") return { kind: "text", sessionId, messageId, partId: part.id, text: part.text ?? "" }
  if (part.type === "tool") return { kind: "tool", sessionId, messageId, partId: part.id, name: part.tool ?? "tool", status: part.state?.status ?? "unknown" }
  return null
}
```

Replace the `message.part.updated` case in `normalizeEvent` (currently the two `if (part.type === ...)` branches) with:

```ts
    case "message.part.updated": {
      const part = p.part ?? {}
      return partToEvent(part.sessionID ?? p.sessionID, part.messageID, part)
    }
```

Replace the inline auth in `EventRouter.subscribe`:

```ts
    const auth = basicAuth(password)
```

In `src/runner.ts`, add a value import and delete the local `partToEvent` function (lines 151-156):

```ts
import { partToEvent } from "./events.js"
import type { NormalizedEvent } from "./events.ts"
```

`recover()` already calls `partToEvent(thread.sessionId, messageId, part)` — no call-site change needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/opencode.test.ts test/events.test.ts test/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode.ts src/events.ts src/runner.ts test/opencode.test.ts test/events.test.ts
git commit -m "refactor: share basicAuth and partToEvent across modules"
```

---

### Task 2: Build every loopback client through `resolveClient`

**Files:**
- Modify: `src/index.ts:18, 135-141, 143-149, 225-238, 331-342, 343-357, 358-368`
- Test: `test/imports.test.ts`

**Interfaces:**
- Consumes: `resolveClient(p: Project): OpencodeClient` from `src/opencode.ts` (already exists and is tested at `test/opencode.test.ts:128`).
- Produces: no new API; removes the six hand-built `createClient` URLs from `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/imports.test.ts` (same file, below the existing tests):

```ts
const LOOPBACK_TEMPLATE = /http:\/\/127\.0\.0\.1:\$\{/
const LOOPBACK_ALLOWED = new Set(["src/opencode.ts", "src/projects.ts"])

test("only opencode.ts and projects.ts build loopback opencode URLs", () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith(".ts")) files.push(p)
    }
  }
  walk("src")
  const offenders = files
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !LOOPBACK_ALLOWED.has(f))
    .filter((f) => LOOPBACK_TEMPLATE.test(readFileSync(f, "utf8")))
  expect(offenders).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/imports.test.ts`
Expected: FAIL with `offenders` containing `src/index.ts`.

- [ ] **Step 3: Implement**

Change the import in `src/index.ts`:

```ts
import { resolveClient } from "./opencode.js"
```

Replace every `createClient(...)` call in `src/index.ts`:

- `clientFor` (`:135-141`): `return resolveClient(project)`
- `createSessionFor` (`:143-149`): `const sdk = resolveClient(project)`
- `Runner.sessionFor` (`:225-238`): `const sdk = resolveClient(project)`
- `listSessions` (`:331-342`): `const sdk = resolveClient(project)`
- `listModels` (`:343-357`): `const sdk = resolveClient(project)`
- `listAgents` (`:358-368`): `const sdk = resolveClient(project)`

No other lines change. `src/projects.ts` keeps its own `createClient` calls because it has a `hostPort` + `serverPassword` but not always a `Project`; it is in the allow-list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/imports.test.ts test/opencode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/imports.test.ts
git commit -m "refactor(index): build loopback clients via resolveClient"
```

---

### Task 3: Drive startup boot from `ClientReady` only

**Files:**
- Modify: `src/index.ts:459`

**Interfaces:**
- Consumes: `createReadyHandler` (registered at `src/index.ts:424`), which already calls `subscribeReadyProjects()` then `reconcileThreads()` in order (`test/handlers.test.ts:221`).
- Produces: no API change.

- [ ] **Step 1: Run the existing ready-handler test to establish the invariant**

Run: `npx vitest run test/handlers.test.ts -t "ready handler subscribes then reconciles"`
Expected: PASS. This is the characterization test for the single boot path.

- [ ] **Step 2: Implement**

In `src/index.ts`, delete the explicit boot block at line 459:

```ts
  if (client.isReady()) { subscribeReadyProjects(); void reconcileThreads().catch((err) => log.error("boot reconcile failed", { error: String(err) })) }
```

Replace it with a comment so the intent survives:

```ts
  // Boot subscribe + thread reconcile are driven by the Events.ClientReady
  // handler registered above; running them again here would double-wake every
  // project. ClientReady fires during `client.login()` (the handler is attached
  // before login), so no explicit fallback is needed.
```

- [ ] **Step 3: Verify by running the bot**

Run from the repo root (sandbox may be stopped or running):

```powershell
node dist/index.js
```

Expected: `Celly ready` banner; no `project not ready at boot` or health-timeout errors; `data/bot.log` shows a single boot transition. Stop with Ctrl+C. (The `ClientReady` handler wakes and subscribes projects.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "refactor(index): boot only from the ClientReady handler"
```

---

### Task 4: Index `threads.channel_id` (migration v4)

**Files:**
- Modify: `src/db.ts:61-65`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `MIGRATIONS` array and `PRAGMA user_version` machinery (`src/db.ts:61-99`).
- Produces: DB `user_version = 4`; index `idx_threads_channel` on `threads(channel_id)`.

- [ ] **Step 1: Write the failing test**

Add to `test/db.test.ts`:

```ts
test("v4 adds an index on threads.channel_id", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-db-index-"))
  const file = join(dir, "bot.db")
  try {
    const db = openDb(file)
    db.migrate()
    db.close()
    const raw = new DatabaseSync(file)
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='threads'").all() as any[]).map((r) => r.name)
    expect(names).toContain("idx_threads_channel")
    expect(Number((raw.prepare("PRAGMA user_version").get() as any).user_version)).toBe(4)
    raw.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/db.test.ts -t "v4 adds an index"`
Expected: FAIL — `idx_threads_channel` missing and `user_version` is 3.

- [ ] **Step 3: Implement**

In `src/db.ts`, append to `MIGRATIONS`:

```ts
  { version: 4, up: (raw) => raw.exec("CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id)") },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/db.test.ts`
Expected: PASS, including the existing `migrate is idempotent` and `v2 migration` tests.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "perf(db): index threads.channel_id for byChannel lookups"
```

---

### Task 5: Truncate `data/bot.log` on boot

**Files:**
- Modify: `src/log.ts:1, 37-49`
- Modify: `src/index.ts:34`
- Test: `test/log.test.ts`

**Interfaces:**
- Consumes: `createLogger(opts)` — extended with `truncate?: boolean`.
- Produces: `createLogger({ ..., truncate: true })` empties `opts.file` at construction. The per-sandbox logs (`data/logs/<sandbox>.log`) keep appending; that is intentional history and is documented in `README.md:172`.

- [ ] **Step 1: Write the failing test**

Update `test/log.test.ts` imports and add a test:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("truncate clears an existing log file at construction", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-log-"))
  const file = join(dir, "bot.log")
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  try {
    writeFileSync(file, "old line\n")
    const log = createLogger({ level: "info", file, truncate: true })
    log.info("first")
    const contents = readFileSync(file, "utf8")
    expect(contents).not.toContain("old line")
    expect(contents).toContain("first")
  } finally {
    info.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/log.test.ts -t "truncate clears"`
Expected: FAIL — contents still contain `old line`.

- [ ] **Step 3: Implement**

In `src/log.ts`:

```ts
import { appendFileSync, writeFileSync } from "node:fs"
```

Change the signature and add the truncation:

```ts
export function createLogger(opts: { level: string; file?: string; secrets?: string[]; truncate?: boolean }): Logger {
  const min = (order[opts.level as Level] ?? 1)
  if (opts.truncate && opts.file) {
    try { writeFileSync(opts.file, "") } catch (err) { console.error(`log truncate failed: ${String(err)}`) }
  }
```

In `src/index.ts`, pass the flag:

```ts
  const log = createLogger({ level: cfg.logLevel, file: `${cfg.dataDir}/bot.log`, secrets, truncate: true })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts src/index.ts test/log.test.ts
git commit -m "fix(log): truncate data/bot.log on each boot"
```

---

### Task 6: Prune redaction secrets when a project is removed

**Files:**
- Modify: `src/projects.ts:14-27` (deps), `:407-413` (`remove`)
- Modify: `src/index.ts:102-133` (ProjectService deps)
- Test: `test/projects.test.ts`, `test/log.test.ts`

**Interfaces:**
- Consumes: `ProjectService` deps gain `onProjectRemoved?(project: Project): void`.
- Produces: `onProjectRemoved` is called exactly once after a project row is removed.

- [ ] **Step 1: Write the failing tests**

Add to `test/projects.test.ts`:

```ts
test("remove notifies onProjectRemoved with the removed project", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const removed: string[] = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {},
    onProjectRemoved: (p: any) => { removed.push(p.name) } } as any)
  await svc.remove("c")
  expect(removed).toEqual(["demo"])
  expect(db.projects.list()).toEqual([])
})
```

Add to `test/log.test.ts`:

```ts
test("removing a secret from the array stops redacting it", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const secrets = ["first", "second"]
  const log = createLogger({ level: "info", secrets })
  secrets.splice(secrets.indexOf("second"), 1)
  log.info("later", { note: "second" })
  const line = info.mock.calls[0]?.[0] as string
  expect(line).toContain("second")
  info.mockRestore()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/projects.test.ts -t "onProjectRemoved" test/log.test.ts -t "removing a secret"`
Expected: the projects test FAILS (`removed` is `[]`); the log test passes already (the logger reads the live array). Keep both — the log test locks the contract that removal takes effect.

- [ ] **Step 3: Implement**

In `src/projects.ts` `ProjectDeps`, add:

```ts
  onProjectRemoved?(project: Project): void
```

In `ProjectService.remove`, after the DB row is deleted:

```ts
  async remove(channelId: string): Promise<void> {
    const p = this.deps.db.projects.getByChannel(channelId); if (!p) return
    this.killChild(channelId)
    await this.deps.sbx.remove(p.sandboxName).catch(() => {})
    this.deps.db.projects.remove(channelId)
    await this.deps.deleteChannel(channelId).catch(() => {})
    this.deps.onProjectRemoved?.(p)
  }
```

In `src/index.ts`, add the hook to the `ProjectService` deps (next to `onProjectReady`):

```ts
    onProjectRemoved: (project) => {
      const index = secrets.indexOf(project.serverPassword)
      if (index >= 0) secrets.splice(index, 1)
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/projects.test.ts test/log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/projects.ts src/index.ts test/projects.test.ts test/log.test.ts
git commit -m "fix(log): drop a project's password from the redaction list on removal"
```

---

### Task 7: `loopback4096` helper and options-based `waitForHealth`

**Files:**
- Modify: `src/opencode.ts:139-171`
- Modify: `src/projects.ts:177-260, 429-438`
- Test: `test/opencode.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export interface HealthWaitOptions { intervalMs?: number; attemptTimeoutMs?: number }`
  - `waitForHealth(client, timeoutMs, options?: HealthWaitOptions): Promise<void>` (replaces the 4-positional-argument signature).
  - `loopback4096(mappings): { hostPort: number } | undefined` (module-private in `src/projects.ts`).

- [ ] **Step 1: Update the tests to the new signature (failing)**

In `test/opencode.test.ts`, rewrite every `waitForHealth(...)` call:

| Current | New |
| --- | --- |
| `waitForHealth(client, 2000, 10)` | `waitForHealth(client, 2000, { intervalMs: 10 })` |
| `waitForHealth({ baseUrl: \`...\` } as any, 150, 20)` | `waitForHealth({ baseUrl: \`...\` } as any, 150, { intervalMs: 20 })` |
| `waitForHealth(client, 1000, 10)` | `waitForHealth(client, 1000, { intervalMs: 10 })` |
| `waitForHealth({ baseUrl: \`...\` } as any, 300, 50)` | `waitForHealth({ baseUrl: \`...\` } as any, 300, { intervalMs: 50 })` |
| `waitForHealth({ baseUrl: \`...\` } as any, 2000, 10, 50)` | `waitForHealth({ baseUrl: \`...\` } as any, 2000, { intervalMs: 10, attemptTimeoutMs: 50 })` |

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/opencode.test.ts`
Expected: FAIL — passing an options object where a number is expected makes the attempts use the default 500 ms interval / 3000 ms cap, so the 300 ms-budget test exceeds its 2 s assertion.

- [ ] **Step 3: Implement `waitForHealth`**

In `src/opencode.ts`:

```ts
export interface HealthWaitOptions {
  intervalMs?: number
  attemptTimeoutMs?: number
}

export async function waitForHealth(
  client: { baseUrl: string; auth?: string },
  timeoutMs: number,
  options: HealthWaitOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 500
  const attemptTimeoutMs = options.attemptTimeoutMs ?? HEALTH_ATTEMPT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const attempt = Math.max(1, Math.min(remaining, attemptTimeoutMs))
    try {
      const res = await fetch(`${client.baseUrl}/global/health`, {
        headers: client.auth ? { Authorization: client.auth } : undefined,
        signal: AbortSignal.timeout(attempt),
      })
      if (res.ok) { const body: any = await res.json(); if (body?.healthy) return; last = JSON.stringify(body) }
      else last = `HTTP ${res.status}`
    } catch (e) { last = (e as Error).message }
    const rest = deadline - Date.now()
    if (rest <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, rest)))
  }
  throw new Error(`opencode health check timed out: ${last}`)
}
```

- [ ] **Step 4: Factor `loopback4096` and update call sites**

In `src/projects.ts`, add above the class:

```ts
function loopback4096(mappings: Array<{ hostIp?: string; hostPort: number; sandboxPort: number }>) {
  return mappings.find((m) => m.sandboxPort === 4096 && isLoopbackHost(m.hostIp))
}
```

Use it in `readBackPort` (`:185`), `reconcileHostPort` (`:224` and `:236`), replacing the three copies of `mappings.find((m) => m.sandboxPort === 4096 && isLoopbackHost(m.hostIp))` / `again.find(...)`.

Update the one non-default-interval caller in `health()`:

```ts
      await waitForHealth(client, timeoutMs, { intervalMs: 250 })
```

`probeHealth`, `ensureReady`, and `waitForServer` keep the default options object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/opencode.test.ts test/projects.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/opencode.ts src/projects.ts test/opencode.test.ts
git commit -m "refactor: options-based waitForHealth and a single 4096-mapping helper"
```

---

### Task 8: Deduplicate runner channel teardown

**Files:**
- Modify: `src/runner.ts:1-6` (type import), `:368-399`
- Test: `test/runner.test.ts` (characterization; no new test file)

**Interfaces:**
- Consumes: `Thread` from `src/types.ts`.
- Produces: private `finalizeThread(thread, note?)` and `resetThread(thread)`; public `handleProjectDown`/`resetChannel` signatures unchanged.

- [ ] **Step 1: Run the characterization tests**

Run: `npx vitest run test/runner.test.ts -t "handleProjectDown\|resetChannel"`
Expected: PASS. These tests lock the behavior the refactor must preserve.

- [ ] **Step 2: Implement**

Add the type import at the top of `src/runner.ts`:

```ts
import type { Thread } from "./types.ts"
```

Add two private methods before `handleProjectDown`:

```ts
  private async finalizeThread(thread: Thread, note?: { partId: string; text: string }): Promise<void> {
    const epoch = this.owner.get(thread.threadId)
    try {
      const renderer = await this.rendererFor(thread.threadId)
      if (note) renderer.push({ kind: "text", sessionId: thread.sessionId, messageId: "", partId: note.partId, text: note.text })
      await renderer.finalize()
    } catch {}
    this.idle(thread.threadId, epoch)
  }
  private resetThread(thread: Thread): void {
    this.clearRenderer(thread.threadId)
    try { this.deps.db.threads.setRenderState(thread.threadId, "idle") } catch {}
  }
```

Rewrite the two public methods to use them (preserve the exact notices and part ids):

```ts
  async handleProjectDown(channelId: string): Promise<void> {
    const threads = this.deps.db.threads.byChannel(channelId)
    for (const thread of threads) { this.queue.delete(thread.threadId); this.clearAbortTimer(thread.threadId) }
    for (const thread of threads) {
      if (!this.active.has(thread.threadId)) continue
      await this.finalizeThread(thread, { partId: `down-${thread.threadId}`, text: "[project server stopped]" })
    }
  }
  async resetChannel(channelId: string, opts: { notify?: boolean } = {}): Promise<void> {
    const threads = this.deps.db.threads.byChannel(channelId)
    for (const thread of threads) { this.queue.delete(thread.threadId); this.clearAbortTimer(thread.threadId) }
    for (const thread of threads) {
      if (!this.active.has(thread.threadId)) { this.resetThread(thread); continue }
      await this.finalizeThread(thread, opts.notify ? { partId: `stop-${thread.threadId}`, text: "[project stopped]" } : undefined)
    }
  }
```

- [ ] **Step 3: Run the tests to verify behavior is unchanged**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/runner.ts
git commit -m "refactor(runner): share per-thread teardown between reset paths"
```

---

### Task 9: Precompute the normalized default deny list

**Files:**
- Modify: `src/runner.ts:7, 133-149`
- Test: `test/runner.test.ts` (characterization; no new test)

**Interfaces:**
- Consumes: `DEFAULT_DENY = bashDenyPatterns()` and `normalizeCommand`.
- Produces: module-private `NORMALIZED_DEFAULT_DENY`; `evaluatePermission(req, deny?)` keeps its public signature (the `deny` parameter stays raw patterns).

- [ ] **Step 1: Run the permission tests**

Run: `npx vitest run test/runner.test.ts -t "deny\|wrapper\|normaliz\|bypass"`
Expected: PASS. These lock the behavior.

- [ ] **Step 2: Implement**

In `src/runner.ts`:

```ts
const DEFAULT_DENY = bashDenyPatterns()
const NORMALIZED_DEFAULT_DENY = DEFAULT_DENY.map(normalizeCommand)
```

In `evaluatePermission`, replace:

```ts
  const normalizedDeny = deny.map(normalizeCommand)
```

with:

```ts
  const normalizedDeny = deny === DEFAULT_DENY ? NORMALIZED_DEFAULT_DENY : deny.map(normalizeCommand)
```

`normalizeCommand` is a hoisted function declaration, so the module-level call is safe.

- [ ] **Step 3: Run the tests to verify behavior is unchanged**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/runner.ts
git commit -m "perf(runner): normalize the default deny list once"
```

---

### Task 10: Use Discord option/component type constants

**Files:**
- Modify: `src/commands.ts:1-3` (import), `:5-27` (`commandData`), `:96-98` (`selectRow`)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `ApplicationCommandOptionType`, `ComponentType` from `discord.js`.
- Produces: identical runtime JSON; the numeric literals become named constants.

- [ ] **Step 1: Write the failing test**

Add to `test/commands.test.ts` (add `import { readFileSync } from "node:fs"` and extend the discord.js import):

```ts
import { readFileSync } from "node:fs"
import { ApplicationCommandOptionType, ComponentType } from "discord.js"

test("command data and select rows use named Discord type constants", () => {
  const source = readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8")
  expect(source).not.toMatch(/type:\s*[13]\b/)

  const project = commandData().find((c) => c.name === "project")!
  const create = project.options.find((o: any) => o.name === "create")!
  expect(create.type).toBe(ApplicationCommandOptionType.Subcommand)
  expect(create.options[0].type).toBe(ApplicationCommandOptionType.String)

  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "resume", channelId: "c" })
  return handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    listSessions: async () => [{ id: "s1", title: "First" }] }).then(() => {
    expect(editOf(i).components[0].type).toBe(ComponentType.ActionRow)
    expect(editOf(i).components[0].components[0].type).toBe(ComponentType.StringSelect)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/commands.test.ts -t "named Discord type constants"`
Expected: FAIL on the source assertion (`type: 1` / `type: 3` literals still present in `src/commands.ts`).

- [ ] **Step 3: Implement**

In `src/commands.ts`:

```ts
import { ApplicationCommandOptionType, ComponentType } from "discord.js"
```

In `commandData()`, replace every `type: 1` with `type: ApplicationCommandOptionType.Subcommand` and every `type: 3` with `type: ApplicationCommandOptionType.String`.

In `selectRow`, replace the literals:

```ts
function selectRow(customId: string, placeholder: string, options: { label: string; value: string }[]): any {
  return { type: ComponentType.ActionRow, components: [{ type: ComponentType.StringSelect, custom_id: customId, placeholder, min_values: 1, max_values: 1, options: sanitizeSelectOptions(options) }] }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS, including the existing command-declaration tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "refactor(commands): name Discord option and component types"
```

---

### Task 11: Replace the hand-rolled abortable sleep

**Files:**
- Modify: `src/events.ts:1` (import), `:61-69` (`sleep`)
- Test: `test/events.test.ts` (characterization)

**Interfaces:**
- Consumes: `setTimeout` from `node:timers/promises`.
- Produces: identical behavior — `sleep(ms, signal)` resolves early (without throwing) when the signal aborts.

- [ ] **Step 1: Run the SSE abort tests**

Run: `npx vitest run test/events.test.ts -t "reconnect\|abort\|alive"`
Expected: PASS. These lock the behavior.

- [ ] **Step 2: Implement**

Add the import and replace the function in `src/events.ts`:

```ts
import { setTimeout as delay } from "node:timers/promises"

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  // `delay` rejects with AbortError when the signal fires; the caller checks
  // signal.aborted itself, so swallow the rejection.
  return delay(ms, undefined, { signal }).then(() => undefined, () => undefined)
}
```

- [ ] **Step 3: Run the tests to verify behavior is unchanged**

Run: `npx vitest run test/events.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/events.ts
git commit -m "refactor(events): use node:timers/promises for abortable sleep"
```

---

### Task 12: Secure and synchronize the diagnostic scripts

**Files:**
- Modify: `scripts/smoke.mjs` (full rewrite)
- Modify: `scripts/probe-serve.mjs` (full rewrite)
- Modify: `docs/spikes/2026-09-25-full-chain.md`
- Test: host run (no vitest harness for scripts)

**Interfaces:**
- Consumes: `BOOTSTRAP_PREPARE`, `BOOTSTRAP_VERIFY`, `buildBootstrapInstallScript`, `buildServeArgs` from `dist/opencode.js` (built output of `src/opencode.ts`).
- Produces: `scripts/smoke.mjs` and `scripts/probe-serve.mjs` both require `npm run build` first and both pass the bootstrap script via stdin.

- [ ] **Step 1: Replace `scripts/probe-serve.mjs`**

```js
// Host-only probe that mirrors the bot's supervised serve spawn.
//
// Build first so dist/opencode.js exists: `npm run build`
// Then: `node scripts/probe-serve.mjs <sandbox>`
import { spawn } from "node:child_process"
import { buildServeArgs } from "../dist/opencode.js"

const name = process.argv[2]
if (!name) { console.error("usage: node scripts/probe-serve.mjs <sandbox>"); process.exit(2) }

const args = ["exec", name, ...buildServeArgs()]
console.log("spawn: sbx", args.join(" "))

const child = spawn("sbx", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
child.on("error", (e) => console.error("ERROR", e))
child.stdout.on("data", (d) => process.stdout.write("OUT " + String(d)))
child.stderr.on("data", (d) => process.stdout.write("ERR " + String(d)))
child.on("exit", (code, signal) => console.log("EXIT", code, signal))

setTimeout(() => { console.log("-- killing probe after 10s --"); child.kill(); process.exit(0) }, 10_000)
```

- [ ] **Step 2: Replace `scripts/smoke.mjs`**

```js
// Host-only full-chain smoke: create -> bootstrap -> serve -> health ->
// create session -> prompt "say hi" -> abort -> stop -> remove.
//
// argv-only: every `sbx` call is spawn/spawnSync("sbx", [...args]) with
// shell:false; the bootstrap script is delivered on stdin to `sbx exec -i`,
// never via a host temp file or `sbx cp`.
//
// Build first so dist/opencode.js exists:
//   npm run build
// Then, on the host with sbx logged in:
//   node scripts/smoke.mjs <project-dir> [hostPort]
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { BOOTSTRAP_PREPARE, BOOTSTRAP_VERIFY, buildBootstrapInstallScript, buildServeArgs } from "../dist/opencode.js"

const dir = process.argv[2]
if (!dir) { console.error("usage: node scripts/smoke.mjs <project-dir> [hostPort]"); process.exit(2) }
const name = `celly-smoke-${Date.now()}`
const hostPort = Number(process.argv[3] ?? 4399)
const password = randomBytes(16).toString("hex")
const baseUrl = `http://127.0.0.1:${hostPort}`
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

let server
let failed = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (message) => { failed = true; console.error("smoke step failed:", message) }

const run = (args, input) => {
  const r = spawnSync("sbx", args, { encoding: "utf8", shell: false, input })
  console.log("$ sbx", args.join(" "), "=>", r.status)
  if (r.stdout) console.log(r.stdout)
  if (r.stderr) console.error(r.stderr)
  return r
}
const step = (label, args, input) => {
  const r = run(args, input)
  if (r.status !== 0) fail(`${label}: sbx ${args[0]} exited ${r.status}`)
  return r
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: auth, "content-type": "application/json", ...(options.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} -> HTTP ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}
const sessionIdOf = (body) => body?.id ?? body?.data?.id ?? body?.info?.id

async function waitForHealth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    try {
      const body = await request("/global/health")
      if (body?.healthy) return
      last = JSON.stringify(body)
    } catch (e) { last = e.message }
    await sleep(500)
  }
  throw new Error(`health never passed: ${last}`)
}

async function waitForReply(sessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await request(`/session/${sessionId}/message`)
    const list = Array.isArray(messages) ? messages : messages?.data ?? []
    for (const m of list) {
      if (m?.info?.role === "assistant" && (m.parts ?? []).some((p) => p?.type === "text" && p.text)) return
    }
    await sleep(500)
  }
  throw new Error("no assistant reply arrived")
}

const teardown = () => {
  try { server?.kill() } catch {}
  run(["rm", "--force", name])
}

async function main() {
  step("create", ["create", "opencode", dir, "--name", name, "--publish", `${hostPort}:4096`])
  step("prepare", ["exec", name, "bash", "-lc", BOOTSTRAP_PREPARE])
  step("bootstrap", ["exec", "-i", name, "bash", "-s"], buildBootstrapInstallScript(password))
  step("verify bootstrap", ["exec", name, "bash", "-lc", BOOTSTRAP_VERIFY])

  server = spawn("sbx", ["exec", name, ...buildServeArgs()], { stdio: ["ignore", "pipe", "pipe"], shell: false })
  server.stdout.on("data", (d) => process.stdout.write(d))
  server.stderr.on("data", (d) => process.stderr.write(d))

  await waitForHealth()
  console.log("health OK")

  const created = await request("/session", { method: "POST", body: JSON.stringify({ title: "smoke" }) })
  const sessionId = sessionIdOf(created)
  if (!sessionId) throw new Error("session.create returned no id")
  console.log("session", sessionId)

  await request(`/session/${sessionId}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "say hi" }] }) })
  await waitForReply(sessionId)
  console.log("reply OK")

  await request(`/session/${sessionId}/abort`, { method: "POST" })
  console.log("abort OK")

  step("stop", ["stop", name])
  step("remove", ["rm", "--force", name])
}

main().catch((e) => { fail(e.message) }).finally(() => {
  if (failed) { teardown(); console.error("smoke FAILED"); process.exit(1) }
  teardown()
  console.log("smoke OK")
})
```

- [ ] **Step 3: Update the spike doc status**

In `docs/spikes/2026-09-25-full-chain.md`, change the `## Status: PENDING host run` line to:

```markdown
## Status: HOST-VERIFIED

The maintained host diagnostics are `scripts/probe-serve.mjs` (exact serve
spawn) and `scripts/smoke.mjs` (full chain). Both import the real spawn and
bootstrap builders from `dist/opencode.js`, so run `npm run build` first.
```

- [ ] **Step 4: Verify on the host**

```powershell
npm run build
node scripts/probe-serve.mjs celly-testing
```

Expected: `opencode server listening on http://0.0.0.0:4096`, then `-- killing probe after 10s --`.

Then clean any stray serve and run the full smoke against a scratch directory (this creates and removes a `celly-smoke-*` sandbox and needs provider credentials):

```powershell
sbx exec celly-testing bash -lc 'pkill -f "opencode serve" || true'
node scripts/smoke.mjs C:\Users\artur\Documents\projects\testing 4398
```

Expected: `health OK`, `session ...`, `reply OK`, `abort OK`, `smoke OK`.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS (scripts are not imported by tests).

```bash
git add scripts/smoke.mjs scripts/probe-serve.mjs docs/spikes/2026-09-25-full-chain.md
git commit -m "chore(scripts): bootstrap diagnostics over stdin and share spawn args"
```

---

## Deliberately Excluded (reviewed — do not "fix" these)

These came up in the code review but are working as intended; changing them would break tests or add churn without value:

| Item | Why it stays |
| --- | --- |
| Typing every `interaction: any` (`src/commands.ts`, `src/handlers.ts`, `src/index.ts`) | The interaction surface is large and partially discord.js-specific; the tests use structural fakes. A partial type would add casts without safety. Revisit only alongside a discord.js-builder test harness. |
| `ChannelBuckets.evict` dropping buckets with queued work (`src/bucket.ts:71`) | Eviction only happens after 30 idle minutes; in-flight jobs keep their bucket reference, so resetting the token budget then is harmless. `test/bucket.test.ts:89` documents the behavior. |
| `recover()` idling with an unset owner epoch (`src/runner.ts:352-366`) | Boot reconcile intentionally resets a non-active `running`/`aborting` thread to idle; `test/runner.test.ts:436` asserts `states === ["idle"]`. |
| `posix.basename` in `attachmentSandboxPath` (`src/attachments.ts:171`) | `hostDestination` is always host-style (built by `joinPathLike`/`realpathSync`), so platform `basename` is the correct call. |
| A secrets getter on the logger | A mutable array plus removal on project delete is sufficient; redaction over a handful of secrets is negligible. Task 6 bounds the growth. |

## Self-Review Checklist

- **Spec coverage:** No spec section changes. Every task maps to a numbered code-review finding; the 20 findings are covered by Tasks 1–12 plus the exclusion table.
- **Placeholder scan:** every code step contains the full code; no TBD/TODO.
- **Type consistency:** `HealthWaitOptions` is defined in Task 7 and used only there; `basicAuth`/`partToEvent` names match between Task 1's producers and consumers; `onProjectRemoved` matches Task 6's deps and index wiring; `loopback4096` is private to `src/projects.ts`.
- **Order:** Task 7 changes `waitForHealth`, which Task 12's scripts import indirectly only through `buildServeArgs` (unaffected). Tasks 2–3 and 5–6 all touch `src/index.ts` and must run in the order listed to minimize merge friction.
