# Idle Auto-Stop (E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a project's sandbox automatically after a configurable idle window, posting one plain channel notice, and wake it transparently on the next message.

**Architecture:** A new `projects.last_active_at` column is touched by every activity path (message ingest, `!shell`, runner prompt, project ready). A new `src/idle.ts` sweeper polls on an unref'd interval, skips `provisioning` projects and project channels with active runs, then stops the sandbox (runner reset → subscription stop → sandbox stop) and posts a notice. Config `IDLE_STOP_MINUTES` (default `30`, `0` disables) drives the threshold, the sweep interval, and the boot log line.

**Tech Stack:** Node 24 (`node:sqlite`), TypeScript ESM, discord.js 14.27, `@opencode-ai/sdk` 1.18.32, Vitest 3, `sbx` CLI.

**Spec:** docs/superpowers/specs/2026-09-27-vnext-features-design.md (section 4.2 is binding)

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (`test/imports.test.ts` enforces it). Only `src/opencode.ts` and `src/projects.ts` may build `http://127.0.0.1:${...}` URLs. This plan never spawns a process and adds no npm dependencies.
- Migrations are append-only: append `{ version: 5, ... }` at the end of `MIGRATIONS` in `src/db.ts`. Never insert into or reorder existing entries. Version 5 is reserved by the spec for this plan (admin-and-ops uses 6, providers-and-cost uses 7). Tests assert behavior, not `user_version` numbers.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and `../src/*.ts` imports. Local imports inside `src/index.ts` use `./x.js`.
- Fake clocks: `vi.useFakeTimers()` + `vi.setSystemTime()` for Discord-facing code, injected `now` for the sweeper.
- Config changes update `docs-site/guides/configuration.mdx` and `.env.example` (spec §2). No new docs page is added, so `docs-site/docs.json` is not touched.
- Run `npm test`, `npm run typecheck`, and `npm run build` before each commit. One commit per task.

## Worktree

This plan runs in its own worktree off `main`, set up with the `superpowers:using-git-worktrees` skill before Task 1:

1. Detect existing isolation first: compare `git rev-parse --git-dir` with `git rev-parse --git-common-dir` (and run the submodule guard `git rev-parse --show-superproject-working-tree`). If already in a linked worktree, reuse it.
2. Otherwise use the harness's native worktree tool. With no native tool, fall back to:
   `git check-ignore -q .worktrees && git worktree add .worktrees/idle-auto-stop -b idle/idle-auto-stop`
   If `.worktrees/` is not ignored, add it to `.gitignore`, commit that, then create the worktree.
3. Run `npm ci`, then `npm test`, `npm run typecheck`, `npm run build` for a clean baseline before Task 1.
4. The recommended merge order is `terminal-attach` → `idle-auto-stop`; both touch `src/index.ts`, `src/db.ts`, and `src/config.ts`. Rebase on `main` after `terminal-attach` merges before starting, and merge this worktree before starting `admin-and-ops`.

## File Structure

```
src/idle.ts        (new) createIdleSweeper + formatIdleStopNotice
src/types.ts       Project.lastActiveAt
src/db.ts          migration v5; projects.touch/idleSince; rowToProject maps last_active_at
src/handlers.ts    touch project activity on authorized message ingest (covers !shell)
src/runner.ts      touch project activity at the start of Runner.prompt
src/index.ts       onProjectReady touch; sweeper wiring, start, boot log line
src/config.ts      Config.idleStopMinutes
test/idle.test.ts        (new) sweeper fake-clock tests + notice text test
test/db.test.ts          touch/idleSince + v5 migration tests; drop the user_version assertion
test/handlers.test.ts    ingest/shell touch tests
test/runner.test.ts      makeDb gains projects.touch; prompt touch test
test/config.test.ts      IDLE_STOP_MINUTES parsing tests + docs consistency test
.env.example             IDLE_STOP_MINUTES (Task 6)
docs-site/guides/configuration.mdx   table row + Idle auto-stop section (Task 6)
.changeset/idle-auto-stop.md         (new, Task 6)
```

---

### Task 1: Migration and DB activity helpers

**Files:**
- Modify: `src/types.ts:2-7` (`Project`)
- Modify: `src/db.ts:7-17` (`Db.projects`), `:61-66` (`MIGRATIONS`), `:71-75` (`rowToProject`), `:102-115` (projects namespace)
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Project.lastActiveAt: number` (`src/types.ts`)
  - `db.projects.touch(channelId: string, at: number): void`
  - `db.projects.idleSince(at: number): Project[]` — rows with `last_active_at <= at`, ordered by `last_active_at`, then `created_at`
  - `db.projects.insertProvisioning(p: Omit<Project, "status" | "lastActiveAt">): void` (existing callers keep working; the column defaults to `0`)

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.ts` (the file already imports `DatabaseSync`, `mkdtempSync`, `rmSync`, `tmpdir`, `join`, and `openDb`):

```ts
test("touch and idleSince expose per-project activity", () => {
  const db = fresh()
  db.projects.insertProvisioning(proj)
  db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "demo2", sandboxName: "celly-demo-2", hostPort: 4301 })
  expect(db.projects.getByChannel("c1")?.lastActiveAt).toBe(0)
  expect(db.projects.idleSince(0).map((p) => p.channelId).sort()).toEqual(["c1", "c2"])
  db.projects.touch("c2", 500)
  db.projects.touch("c1", 100)
  expect(db.projects.getByChannel("c2")?.lastActiveAt).toBe(500)
  expect(db.projects.getByChannel("c1")?.lastActiveAt).toBe(100)
  expect(db.projects.idleSince(200).map((p) => p.channelId)).toEqual(["c1"])
  expect(db.projects.idleSince(99)).toEqual([])
})

test("a v4 database upgrades with a zeroed projects.last_active_at", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-db-idle-"))
  const file = join(dir, "bot.db")
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE projects (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL, sandbox_path TEXT, sandbox_name TEXT NOT NULL UNIQUE,
        host_port INTEGER NOT NULL UNIQUE, server_password TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version = 4;
      INSERT INTO projects (channel_id,guild_id,name,directory,sandbox_path,sandbox_name,host_port,server_password,status,created_at)
        VALUES ('c1','g','demo','C:\\p',NULL,'celly-demo',4300,'pw','ready',1);
    `)
    legacy.close()

    const db = openDb(file)
    db.migrate()
    expect(db.projects.getByChannel("c1")?.lastActiveAt).toBe(0)
    db.projects.touch("c1", 42)
    expect(db.projects.idleSince(42).map((p) => p.channelId)).toEqual(["c1"])
    expect(db.projects.idleSince(41)).toEqual([])
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — `TypeError: db.projects.touch is not a function`, `TypeError: db.projects.idleSince is not a function`, and `expected undefined to be 0` in the migration test.

- [ ] **Step 3: Implement**

In `src/types.ts`, add the field:

```ts
export interface Project {
  channelId: string; guildId: string; name: string
  directory: string; sandboxPath: string | null
  sandboxName: string; hostPort: number; serverPassword: string
  status: ProjectStatus; createdAt: number; lastActiveAt: number
}
```

In `src/db.ts`, extend the `Db.projects` interface (change `insertProvisioning`, add the last two):

```ts
  projects: {
    insertProvisioning(p: Omit<Project, "status" | "lastActiveAt">): void
    setReady(channelId: string, sandboxPath: string): void
    setStatus(channelId: string, s: ProjectStatus): void
    setHostPort(channelId: string, port: number): void
    setServerPassword(channelId: string, password: string): void
    getByChannel(channelId: string): Project | undefined
    getByName(name: string): Project | undefined
    list(): Project[]
    remove(channelId: string): void
    touch(channelId: string, at: number): void
    idleSince(at: number): Project[]
  }
```

Append a v5 entry (version reserved by the spec for this plan) to the end of `MIGRATIONS` (never insert or reorder):

```ts
const MIGRATIONS: { version: number; up(raw: DatabaseSync): void }[] = [
  { version: 1, up: (raw) => raw.exec(SCHEMA_V1) },
  { version: 2, up: (raw) => raw.exec(SCHEMA_V2) },
  { version: 3, up: (raw) => raw.exec("ALTER TABLE threads ADD COLUMN live_message_ids TEXT") },
  { version: 4, up: (raw) => raw.exec("CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id)") },
  { version: 5, up: (raw) => raw.exec("ALTER TABLE projects ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0") },
]
```

Map the column in `rowToProject`:

```ts
const rowToProject = (r: any): Project => ({
  channelId: r.channel_id, guildId: r.guild_id, name: r.name, directory: r.directory,
  sandboxPath: r.sandbox_path ?? null, sandboxName: r.sandbox_name, hostPort: r.host_port,
  serverPassword: r.server_password, status: r.status, createdAt: r.created_at,
  lastActiveAt: r.last_active_at ?? 0,
})
```

Add the two query methods to the projects namespace (after `remove`):

```ts
      touch(channelId, at) { raw.prepare(`UPDATE projects SET last_active_at=? WHERE channel_id=?`).run(at, channelId) },
      idleSince(at) { return raw.prepare(`SELECT * FROM projects WHERE last_active_at <= ? ORDER BY last_active_at, created_at`).all(at).map(rowToProject) },
```

Finally, fix the pre-existing version-number assertion in `test/db.test.ts` so it asserts behavior only. Delete this line from the `"v4 adds an index on threads.channel_id"` test:

```ts
    expect(Number((raw.prepare("PRAGMA user_version").get() as any).user_version)).toBe(4)
```

The index-name assertion above it is the behavior that matters.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/db.test.ts`
Expected: PASS (all tests green, including the pre-existing v2 migration and v4 index tests).

- [ ] **Step 5: Commit**

Run: `npm test && npm run typecheck && npm run build`

```bash
git add src/types.ts src/db.ts test/db.test.ts
git commit -m "feat(db): track project activity for idle auto-stop"
```

---

### Task 2: Touch activity on ingest, shell, prompt, and ready

**Files:**
- Modify: `src/handlers.ts:46-49` (after the authorization check)
- Modify: `src/runner.ts:255-257` (top of `Runner.prompt`)
- Modify: `src/index.ts:132` (`onProjectReady`)
- Test: `test/handlers.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `db.projects.touch(channelId: string, at: number): void` (Task 1).
- Produces: no new exports. Every authorized message (including `!shell`), every `Runner.prompt`, and every `onProjectReady` refreshes `projects.last_active_at`.

- [ ] **Step 1: Write the failing tests**

Append to `test/handlers.test.ts` (`vi` is already imported):

```ts
test("an authorized message touches the project's activity clock", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db)
  vi.useFakeTimers()
  try {
    vi.setSystemTime(5000)
    const { message } = fakeMessage({ content: "hello" })
    await createMessageHandler(deps)(message)
    expect(db.projects.getByChannel("c")?.lastActiveAt).toBe(5000)
  } finally {
    vi.useRealTimers()
  }
})

test("a !shell command touches the project's activity clock", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { runShell: vi.fn(async () => ["out"]) })
  vi.useFakeTimers()
  try {
    vi.setSystemTime(7000)
    const { message } = fakeMessage({ content: "!echo hi" })
    await createMessageHandler(deps)(message)
    expect(deps.runShell).toHaveBeenCalledWith("c", "echo hi")
    expect(db.projects.getByChannel("c")?.lastActiveAt).toBe(7000)
  } finally {
    vi.useRealTimers()
  }
})

test("an unauthorized message does not touch project activity", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { isAuthorized: () => false })
  const { message } = fakeMessage()
  await createMessageHandler(deps)(message)
  expect(db.projects.getByChannel("c")?.lastActiveAt).toBe(0)
})
```

In `test/runner.test.ts`, add the `projects` stub to the shared `makeDb` helper (existing tests will otherwise throw once `prompt` touches projects):

```ts
function makeDb(state = "running", threads: any[] = [], liveMessageId: string | null = null, liveMessageIds: string[] = []) {
  const states: string[] = []
  const ids = liveMessageIds.length ? liveMessageIds : (liveMessageId ? [liveMessageId] : [])
  const db = {
    threads: {
      setRenderState(_t: string, s: string) { states.push(s) },
      touch() {},
      get() { return { renderState: state, liveMessageId } },
      liveMessageIds() { return ids },
      setLiveMessages() {},
      byChannel() { return threads },
    },
    projects: { touch() {} },
  } as any
  return { db, states }
}
```

Then append a new test to `test/runner.test.ts`:

```ts
test("prompt touches the owning project's activity clock", async () => {
  const touched: Array<[string, number]> = []
  const db = {
    threads: { get: () => ({ renderState: "idle", channelId: "c1" }), setRenderState() {}, touch() {} },
    projects: { touch: (channelId: string, at: number) => { touched.push([channelId, at]) } },
  } as any
  vi.useFakeTimers()
  try {
    vi.setSystemTime(5000)
    const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
      createRenderer: async () => makeRenderer() as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "a", "u")
    expect(touched).toEqual([["c1", 5000]])
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/handlers.test.ts test/runner.test.ts`
Expected: FAIL — handlers: `expected 0 to be 5000`; runner: `expected [] to deeply equal [ [ 'c1', 5000 ] ]`.

- [ ] **Step 3: Implement**

In `src/handlers.ts`, touch right after authorization so one call covers both prompts and `!shell`:

```ts
      if (!deps.isAuthorized(message)) return
      deps.db.projects.touch(project.channelId, Date.now())

      const text = message.content ?? ""
```

In `src/runner.ts`, touch at the top of `prompt` before the queue early-returns, so a queued prompt still counts as activity:

```ts
  async prompt(threadId: string, text: string, actor: string): Promise<string | undefined> {
    const db = this.deps.db
    const projectThread = db.threads.get(threadId)
    if (projectThread) db.projects.touch(projectThread.channelId, Date.now())
    if (this.active.has(threadId)) return this.enqueue(threadId, { text, actor })
    if (this.active.size >= this.deps.maxConcurrentRuns) return this.enqueue(threadId, { text, actor })
```

In `src/index.ts`, touch when a project becomes ready (first create and recreate):

```ts
    onProjectReady: (project) => { secrets.push(project.serverPassword); db.projects.touch(project.channelId, Date.now()); subscribeProject(project) },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/handlers.test.ts test/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `npm test && npm run typecheck && npm run build`

```bash
git add src/handlers.ts src/runner.ts src/index.ts test/handlers.test.ts test/runner.test.ts
git commit -m "feat(idle): touch project activity on ingest, shell, prompt, and ready"
```

---

### Task 3: The idle sweeper

**Files:**
- Create: `src/idle.ts`
- Test: `test/idle.test.ts`

**Interfaces:**
- Consumes: `Project.lastActiveAt` (Task 1).
- Produces:
  - `interface IdleSweeperDeps { listProjects(): Project[]; activeThreads(channelId: string): string[]; now(): number; stop(channelId: string): Promise<void> | void; notify(channelId: string, minutes: number): Promise<void> | void; idleMs: number; intervalMs: number }`
  - `interface IdleSweeper { start(): void; stop(): void; tick(): Promise<void> }`
  - `createIdleSweeper(deps: IdleSweeperDeps): IdleSweeper`

Behavior: `tick()` no-ops when `idleMs <= 0`; otherwise it stops and notifies each project that is not `provisioning`, has no active threads, and has `now() - lastActiveAt >= idleMs`. `minutes` passed to `notify` is `Math.round(idleMs / 60_000)`. `start()` sets one unref'd interval (idempotent, no-op when `idleMs <= 0`); `stop()` clears it.

- [ ] **Step 1: Write the failing test file**

Create `test/idle.test.ts`:

```ts
// test/idle.test.ts
import { expect, test, vi } from "vitest"
import { createIdleSweeper } from "../src/idle.ts"
import type { IdleSweeperDeps } from "../src/idle.ts"
import type { Project } from "../src/types.ts"

const MINUTE = 60_000

const project = (over: Partial<Project> = {}): Project => ({
  channelId: "c1", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null,
  sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", status: "ready",
  createdAt: 1, lastActiveAt: 0, ...over,
})

function makeSweeper(over: Partial<IdleSweeperDeps> = {}) {
  const stops: string[] = []
  const notices: Array<{ channelId: string; minutes: number }> = []
  const deps: IdleSweeperDeps = {
    listProjects: () => [project()],
    activeThreads: () => [],
    now: () => 31 * MINUTE,
    stop: (channelId) => { stops.push(channelId) },
    notify: (channelId, minutes) => { notices.push({ channelId, minutes }) },
    idleMs: 30 * MINUTE,
    intervalMs: 1000,
    ...over,
  }
  return { sweeper: createIdleSweeper(deps), stops, notices }
}

test("stops and notifies a project idle past the threshold", async () => {
  const { sweeper, stops, notices } = makeSweeper()
  await sweeper.tick()
  expect(stops).toEqual(["c1"])
  expect(notices).toEqual([{ channelId: "c1", minutes: 31 }])
})

test("skips a project with an active run", async () => {
  const { sweeper, stops, notices } = makeSweeper({ activeThreads: () => ["t1"] })
  await sweeper.tick()
  expect(stops).toEqual([])
  expect(notices).toEqual([])
})

test("skips a provisioning project", async () => {
  const { sweeper, stops } = makeSweeper({ listProjects: () => [project({ status: "provisioning" })] })
  await sweeper.tick()
  expect(stops).toEqual([])
})

test("does not stop a project that was active within the window", async () => {
  const { sweeper, stops } = makeSweeper({ listProjects: () => [project({ lastActiveAt: 29 * MINUTE })] })
  await sweeper.tick()
  expect(stops).toEqual([])
})

test("a touch resets the idle clock", async () => {
  let lastActiveAt = 0
  const { sweeper, stops } = makeSweeper({ listProjects: () => [project({ lastActiveAt })] })
  await sweeper.tick()
  expect(stops).toEqual(["c1"])
  lastActiveAt = 31 * MINUTE
  await sweeper.tick()
  expect(stops).toEqual(["c1"])
})

test("idleMs 0 disables both tick and the interval", async () => {
  vi.useFakeTimers()
  try {
    const { sweeper, stops } = makeSweeper({ idleMs: 0 })
    sweeper.start()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    await sweeper.tick()
    expect(stops).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

test("start schedules one unref'd interval and stop clears it", async () => {
  vi.useFakeTimers()
  try {
    let now = 0
    const stops: string[] = []
    const sweeper = createIdleSweeper({
      listProjects: () => [project({ lastActiveAt: 0 })],
      activeThreads: () => [],
      now: () => now,
      stop: (channelId) => { stops.push(channelId) },
      notify: () => {},
      idleMs: MINUTE,
      intervalMs: 1000,
    })
    now = 2 * MINUTE
    sweeper.start()
    sweeper.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(stops).toEqual(["c1"])
    sweeper.stop()
    expect(vi.getTimerCount()).toBe(0)
    now = 5 * MINUTE
    await vi.advanceTimersByTimeAsync(3000)
    expect(stops).toEqual(["c1"])
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/idle.test.ts`
Expected: FAIL — `Failed to resolve import "../src/idle.ts" from "test/idle.test.ts". Does the file exist?`

- [ ] **Step 3: Implement**

Create `src/idle.ts`:

```ts
import type { Project } from "./types.ts"

export interface IdleSweeperDeps {
  listProjects(): Project[]
  activeThreads(channelId: string): string[]
  now(): number
  stop(channelId: string): Promise<void> | void
  notify(channelId: string, minutes: number): Promise<void> | void
  idleMs: number
  intervalMs: number
}

export interface IdleSweeper {
  start(): void
  stop(): void
  tick(): Promise<void>
}

export function createIdleSweeper(deps: IdleSweeperDeps): IdleSweeper {
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  const tick = async (): Promise<void> => {
    if (deps.idleMs <= 0 || running) return
    running = true
    try {
      for (const project of deps.listProjects()) {
        if (project.status === "provisioning") continue
        if (deps.activeThreads(project.channelId).length > 0) continue
        const idleMs = deps.now() - project.lastActiveAt
        if (idleMs < deps.idleMs) continue
        try {
          await deps.stop(project.channelId)
          await deps.notify(project.channelId, Math.round(idleMs / 60_000))
        } catch {
          // stop/notify are wired with their own logging; one failing project
          // must not abort the sweep for the rest.
        }
      }
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (deps.idleMs <= 0 || timer !== undefined) return
      timer = setInterval(() => { void tick() }, deps.intervalMs)
      if (typeof (timer as any).unref === "function") (timer as any).unref()
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    tick,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/idle.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

Run: `npm test && npm run typecheck && npm run build`

```bash
git add src/idle.ts test/idle.test.ts
git commit -m "feat(idle): add the idle sweeper"
```

---

### Task 4: Config `IDLE_STOP_MINUTES`

**Files:**
- Modify: `src/config.ts:12-13` (`Config` interface), `:77` (`loadConfig`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config.idleStopMinutes: number` — integer `>= 0`, default `30`; `0` disables auto-stop.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts`:

```ts
test("parses IDLE_STOP_MINUTES and allows 0 to disable", () => {
  expect(loadConfig(base).idleStopMinutes).toBe(30)
  expect(loadConfig({ ...base, IDLE_STOP_MINUTES: "5" }).idleStopMinutes).toBe(5)
  expect(loadConfig({ ...base, IDLE_STOP_MINUTES: "0" }).idleStopMinutes).toBe(0)
})

test("rejects a negative or fractional IDLE_STOP_MINUTES", () => {
  expect(() => loadConfig({ ...base, IDLE_STOP_MINUTES: "-1" })).toThrow(/IDLE_STOP_MINUTES/)
  expect(() => loadConfig({ ...base, IDLE_STOP_MINUTES: "1.5" })).toThrow(/IDLE_STOP_MINUTES/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `expected undefined to be 30` and `expected [Function] to throw an error` for the negative/fractional cases.

- [ ] **Step 3: Implement**

In `src/config.ts`, add the field to `Config`:

```ts
  attachmentMaxBytes: number; maxQueue: number; maxConcurrentRuns: number
  idleStopMinutes: number
```

In `loadConfig`, add the parse next to the other limits (the existing `int` helper already allows `min = 0`):

```ts
    maxQueue: int(env, "MAX_QUEUE", 20, 1), maxConcurrentRuns: int(env, "MAX_CONCURRENT_RUNS", 4, 1),
    idleStopMinutes: int(env, "IDLE_STOP_MINUTES", 30, 0),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `npm test && npm run typecheck && npm run build`

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add IDLE_STOP_MINUTES"
```

---

### Task 5: Wire the sweeper into `src/index.ts`

**Files:**
- Modify: `src/idle.ts` (add `formatIdleStopNotice`)
- Modify: `src/index.ts` (import; wiring block after `log.info("Celly ready", ...)` at `:468`)
- Test: `test/idle.test.ts`

**Interfaces:**
- Consumes: `createIdleSweeper` and `IdleSweeperDeps` (Task 3), `Config.idleStopMinutes` (Task 4), `db.projects.idleSince`/`touch` (Task 1), `Runner.activeThreadsFor`/`resetChannel` (existing), `ProjectService.stop` (existing).
- Produces: `formatIdleStopNotice(minutes: number): string`; the running sweeper posts `renderPayload(formatIdleStopNotice(minutes))` through the channel bucket and logs the threshold at boot.

- [ ] **Step 1: Write the failing test**

Update the import in `test/idle.test.ts`:

```ts
import { createIdleSweeper, formatIdleStopNotice } from "../src/idle.ts"
```

Append:

```ts
test("formatIdleStopNotice pluralizes the idle window", () => {
  expect(formatIdleStopNotice(1)).toContain("1 minute of inactivity")
  expect(formatIdleStopNotice(31)).toContain("31 minutes of inactivity")
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/idle.test.ts`
Expected: FAIL — `TypeError: formatIdleStopNotice is not a function`.

- [ ] **Step 3: Implement**

Add to `src/idle.ts` (above `createIdleSweeper`):

```ts
export function formatIdleStopNotice(minutes: number): string {
  return `Project stopped after ${minutes} minute${minutes === 1 ? "" : "s"} of inactivity. Send a message to start it again.`
}
```

In `src/index.ts`, add the import next to the other local imports:

```ts
import { createIdleSweeper, formatIdleStopNotice } from "./idle.js"
```

Then, after `log.info("Celly ready", { guild: guild.name })`, add the wiring. It runs after login so startup never stops a project that boot is still waking:

```ts
  const idleSweeper = createIdleSweeper({
    // The DB selector narrows candidates with the same cutoff; the sweeper's
    // injected clock remains the authority for testability.
    listProjects: () => db.projects.idleSince(Date.now() - cfg.idleStopMinutes * 60_000),
    activeThreads: (channelId) => runnerSvc.activeThreadsFor(channelId),
    now: () => Date.now(),
    stop: async (channelId) => {
      await runnerSvc.resetChannel(channelId)
      stopSubscription(channelId)
      await projects.stop(channelId)
      // The sweep itself counts as activity so the next tick does not stop and
      // notify again until another full idle window passes.
      db.projects.touch(channelId, Date.now())
    },
    notify: async (channelId, minutes) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (channel && "send" in channel) {
        await scheduleWithBucket(channelId, () => (channel as any).send(renderPayload(formatIdleStopNotice(minutes)))).catch(() => {})
      }
    },
    idleMs: cfg.idleStopMinutes * 60_000,
    intervalMs: 60_000,
  })
  idleSweeper.start()
  if (cfg.idleStopMinutes > 0) log.info("idle auto-stop enabled", { minutes: cfg.idleStopMinutes })
  else log.info("idle auto-stop disabled", { minutes: cfg.idleStopMinutes })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/idle.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

Run: `npm test && npm run typecheck && npm run build`

```bash
git add src/idle.ts src/index.ts test/idle.test.ts
git commit -m "feat(idle): auto-stop idle project sandboxes"
```

---

### Task 6: Docs, `.env.example`, and the changeset

**Files:**
- Modify: `.env.example:32-35`
- Modify: `docs-site/guides/configuration.mdx:41` (table), after `:88` (new section)
- Create: `.changeset/idle-auto-stop.md`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `Config.idleStopMinutes` (Task 4).
- Produces: documentation and release notes. No code behavior change.

- [ ] **Step 1: Write the failing test**

`test/config.test.ts` already imports from `node:fs`; add `readFileSync`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
```

Append:

```ts
test("the idle auto-stop setting is documented in the env example and the config guide", () => {
  expect(readFileSync(".env.example", "utf8")).toContain("# IDLE_STOP_MINUTES=30")
  expect(readFileSync("docs-site/guides/configuration.mdx", "utf8")).toContain("| `IDLE_STOP_MINUTES` | `30` |")
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `expected '...' to contain '# IDLE_STOP_MINUTES=30'`.

- [ ] **Step 3: Implement**

In `.env.example`, add a block after the `# # Limits.` block:

```dotenv

# # Idle auto-stop. Stop a project after N minutes without activity; 0 disables.
# IDLE_STOP_MINUTES=30
```

In `docs-site/guides/configuration.mdx`, add the row after `MAX_CONCURRENT_RUNS`:

```mdx
| `IDLE_STOP_MINUTES` | `30` | Stop a project after this many minutes without activity. `0` disables. |
```

Append a section at the end of the file:

```mdx
## Idle auto-stop

With `IDLE_STOP_MINUTES` greater than `0` (default `30`), Celly stops a
project's sandbox after that many minutes without message, prompt, or `!shell`
activity. Projects with a run in flight and projects still provisioning are
skipped. Celly posts a plain notice in the project channel; the next message
wakes the project again. Set `IDLE_STOP_MINUTES=0` to keep every started
project running.
```

No `README.md` change is needed: the README links to the configuration guide
instead of tabulating environment variables. No `docs-site/docs.json` change is
needed: no page is added.

Create `.changeset/idle-auto-stop.md`:

```markdown
---
"celly": minor
---

Auto-stop idle project sandboxes. `IDLE_STOP_MINUTES` (default 30, `0`
disables) stops a project after that many minutes without messages, prompts,
or `!shell` activity and posts a notice in its channel. The next message wakes
the project again.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `npm test && npm run typecheck && npm run build`

```bash
git add .env.example docs-site/guides/configuration.mdx .changeset/idle-auto-stop.md test/config.test.ts
git commit -m "docs(idle): document idle auto-stop and add a changeset"
```

---

## Self-Review (author checklist)

**Spec coverage (spec §4.2):**
- Config `IDLE_STOP_MINUTES` int `>= 0`, default `30`, `0` disables → Task 4.
- Migration `projects.last_active_at INTEGER NOT NULL DEFAULT 0`, `db.projects.touch(channelId, at)`, `db.projects.idleSince(at)` → Task 1 (query returns rows with `last_active_at <= at`; index wires the cutoff as `Date.now() - idleMs`).
- Touches on message ingest, shell run, thread prompt start, `onProjectReady` → Task 2 (shell shares the ingest touch).
- `src/idle.ts` `createIdleSweeper({ listProjects, activeThreads, now, stop, notify, idleMs, intervalMs })` with `start`/`stop`/`tick`, provisioning skip, active-run skip, stop-then-notify → Task 3.
- Wiring: unref'd interval, `notify` via `renderPayload` + channel bucket, `stop` via `runner.resetChannel`, `stopSubscription`, `projects.stop`, boot log threshold → Task 5.
- Docs + `.env.example` + changeset → Tasks 4 (`.env.example` is documented in Task 6 per the fold instruction) and 6.

**Placeholder scan:** no TBD/TODO; every step shows the code or the exact command and expected output.

**Identifier consistency:** `lastActiveAt` (types/db/tests), `touch(channelId, at)`, `idleSince(at)`, `IdleSweeperDeps`, `createIdleSweeper`, `formatIdleStopNotice`, `idleStopMinutes`, `activeThreadsFor`, `resetChannel`, `stopSubscription`, `renderPayload` are used consistently across tasks.

**Known ripples called out inline:** the pre-existing `user_version === 4` assertion is removed in Task 1; `test/runner.test.ts`'s shared `makeDb` gains a `projects.touch` stub in Task 2.
