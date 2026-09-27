# Admin and Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a loopback-only admin HTTP server, size-based log rotation, scheduled SQLite backups, and recurring `/task` prompts to Celly.

**Architecture:** Four small, dependency-free modules (`src/rotate.ts`, `src/backup.ts`, `src/tasks.ts`, `src/admin.ts`) built from injected dependencies and wired into `src/index.ts`: rotation rides inside `createLogger` and the project server log writer, backups run on an unref'd interval over `db.backupTo` (`VACUUM INTO`), and the task runner ticks on an interval and enqueues prompts through the existing `Runner`. Data lives in one append-only `scheduled_tasks` migration and five new env vars.

**Tech Stack:** Node >=24 (`node:sqlite` DatabaseSync, `node:http`, `node:fs`), ESM TypeScript strict, vitest, Discord.js command registration.

**Spec:** docs/superpowers/specs/2026-09-27-vnext-features-design.md

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (`test/imports.test.ts`). `src/admin.ts`, `src/tasks.ts`, `src/backup.ts`, and `src/rotate.ts` must not import it; no new npm dependencies.
- Only `src/opencode.ts` and `src/projects.ts` may build `http://127.0.0.1:${...}` URLs.
- Secrets (Discord token, server passwords, provider keys) never in argv, logs, or HTTP responses; redact through `src/log.ts` (`redact`).
- Migrations are append-only: never insert into or reorder `MIGRATIONS` in `src/db.ts`; append a new entry at the end.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and `../src/x.ts` imports.
- Temp dirs: `mkdtempSync(join(tmpdir(), "celly-...-"))` with `try { } finally { rmSync(dir, { recursive: true, force: true }) }`.
- Command changes update `docs-site/reference/commands.mdx` and the README commands table; config changes update `docs-site/guides/configuration.mdx` and `.env.example`; security-relevant changes update `docs-site/reference/security.mdx`; new docs pages register in `docs-site/docs.json`.
- Run `npm test`, `npm run typecheck`, `npm run build` before each commit.
- Conventional commits: `feat(ops): ...`, `feat(tasks): ...`, `feat(admin): ...`, `docs(admin): ...`.

## Worktree

Use `superpowers:using-git-worktrees` before Task 1. This plan runs in its own worktree branched from `main`.

1. Detect existing isolation first: `GIT_DIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)`, `GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)`, and `git rev-parse --show-superproject-working-tree`. If `GIT_DIR != GIT_COMMON` and not a submodule, you are already in a linked worktree — keep it.
2. Otherwise, if a native worktree tool is available, use it. Fallback: verify `.worktrees` is ignored (`git check-ignore -q .worktrees`; if not ignored, add `.worktrees/` to `.gitignore` and commit that first), then `git worktree add .worktrees/admin-and-ops -b admin-and-ops`.
3. Setup and baseline in the worktree: `npm ci`, then `npm test && npm run typecheck && npm run build`. Expected: green. If red, stop and report before changing code.
4. The local `main` checkout currently has an uncommitted merge conflict in `docs-site/docs.json`. A fresh worktree from the committed `main` gets the clean file; if yours shows `<<<<<<<` markers, resolve them to the committed values (`"name": "Celly"`, `"theme": "mint"`) before Task 9.

## File Structure

- `src/rotate.ts` (new) — `rotateIfNeeded`: pure filesystem log rotation, no state.
- `src/log.ts` (modify) — `createLogger` accepts `maxBytes`/`maxFiles` and throttles rotation per append.
- `src/projects.ts` (modify) — project server log writer rotates with the same helper.
- `src/backup.ts` (new) — `createBackupScheduler`: `VACUUM INTO` backups plus pruning.
- `src/db.ts` (modify) — `db.backupTo` and the append-only `scheduled_tasks` migration plus `db.tasks` CRUD.
- `src/types.ts` (modify) — `ScheduledTask` row type.
- `src/tasks.ts` (new) — `createTaskRunner`: interval tick that enqueues due prompts.
- `src/commands.ts` (modify) — `/task add|list|remove` and owner gating.
- `src/admin.ts` (new) — `createAdminServer`: loopback HTTP status page and JSON API.
- `src/config.ts` (modify) — `ADMIN_PORT`, `LOG_MAX_BYTES`, `LOG_MAX_FILES`, `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`.
- `src/index.ts` (modify) — wire rotation opts, backup scheduler, task runner, admin server, shutdown.
- Tests: `test/rotate.test.ts`, `test/backup.test.ts`, `test/tasks.test.ts`, `test/admin.test.ts` (new); `test/log.test.ts`, `test/config.test.ts`, `test/projects.test.ts`, `test/db.test.ts`, `test/commands.test.ts`, `test/wiring.test.ts` (modify).
- Docs: `docs-site/guides/deployment-linux.mdx` (new); `docs-site/docs.json`, `docs-site/guides/deployment.mdx`, `docs-site/guides/configuration.mdx`, `docs-site/reference/commands.mdx`, `docs-site/reference/security.mdx`, `.env.example`, `README.md` (modify); `.changeset/admin-and-ops.md` (new).

---

### Task 1: `rotateIfNeeded` helper

**Files:**
- Create: `src/rotate.ts`
- Test: `test/rotate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface RotateOptions { maxBytes: number; maxFiles: number; now?: () => number }` and `rotateIfNeeded(file: string, opts: RotateOptions): boolean`. Returns `true` only when it shifted at least one file. `now` is accepted for signature compatibility with the spec and is not used: rotation is size-based only.

- [ ] **Step 1: Write the failing test**

Create `test/rotate.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { rotateIfNeeded } from "../src/rotate.ts"

test("does nothing when the file is missing or under maxBytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-rotate-"))
  const file = join(dir, "bot.log")
  try {
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    writeFileSync(file, "small")
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    expect(existsSync(`${file}.1`)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("shifts the file to .1 and older copies upward", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-rotate-"))
  const file = join(dir, "bot.log")
  try {
    writeFileSync(file, "first")
    expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 3 })).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("first")
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, "second")
    expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 3 })).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("second")
    expect(readFileSync(`${file}.2`, "utf8")).toBe("first")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("drops copies beyond maxFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-rotate-"))
  const file = join(dir, "bot.log")
  try {
    for (const content of ["one", "two", "three"]) {
      writeFileSync(file, content)
      expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 2 })).toBe(true)
    }
    expect(readFileSync(`${file}.1`, "utf8")).toBe("three")
    expect(readFileSync(`${file}.2`, "utf8")).toBe("two")
    expect(existsSync(`${file}.3`)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rotate.test.ts`
Expected: FAIL — `Failed to resolve import "../src/rotate.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/rotate.ts`:

```ts
import { existsSync, renameSync, rmSync, statSync } from "node:fs"

export interface RotateOptions {
  maxBytes: number
  maxFiles: number
  now?: () => number
}

export function rotateIfNeeded(file: string, opts: RotateOptions): boolean {
  if (!existsSync(file)) return false
  if (statSync(file).size < opts.maxBytes) return false
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles))
  for (let i = maxFiles; i >= 1; i--) {
    const target = `${file}.${i}`
    const source = i === 1 ? file : `${file}.${i - 1}`
    if (existsSync(target)) rmSync(target, { force: true })
    if (existsSync(source)) renameSync(source, target)
  }
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rotate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/rotate.ts test/rotate.test.ts
git commit -m "feat(ops): add log rotation helper"
```

### Task 2: Logger and project-log rotation

**Files:**
- Modify: `src/log.ts` (add import; replace `createLogger` at lines 37-61)
- Modify: `src/projects.ts:330-333`
- Modify: `src/config.ts:5-14` and `src/config.ts:56-80`
- Test: `test/log.test.ts`, `test/config.test.ts`, `test/projects.test.ts`

**Interfaces:**
- Consumes: `rotateIfNeeded(file, opts)` from Task 1.
- Produces: `createLogger(opts: { level: string; file?: string; secrets?: string[]; truncate?: boolean; maxBytes?: number; maxFiles?: number })`; `Config.logMaxBytes: number`, `Config.logMaxFiles: number`.

- [ ] **Step 1: Write the failing logger test**

Append to `test/log.test.ts`:

```ts
test("logger rotates the file once appends pass maxBytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-log-rotate-"))
  const file = join(dir, "bot.log")
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  try {
    const log = createLogger({ level: "info", file, maxBytes: 200, maxFiles: 2 })
    for (let i = 0; i < 12; i++) log.info("line", { i })
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toContain('"msg":"line"')
  } finally {
    info.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})
```

Add `existsSync` to the existing `node:fs` import on line 2 of `test/log.test.ts` so it reads `import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/log.test.ts`
Expected: FAIL — `${file}.1` does not exist.

- [ ] **Step 3: Implement rotation in the logger**

In `src/log.ts`, add below the existing imports:

```ts
import { rotateIfNeeded } from "./rotate.js"
```

Replace the whole `createLogger` function (currently lines 37-61) with:

```ts
export function createLogger(opts: { level: string; file?: string; secrets?: string[]; truncate?: boolean; maxBytes?: number; maxFiles?: number }): Logger {
  const min = (order[opts.level as Level] ?? 1)
  if (opts.truncate && opts.file) {
    try { writeFileSync(opts.file, "") } catch (err) { console.error(`log truncate failed: ${String(err)}`) }
  }
  let writtenSinceRotate = 0
  const rotateForAppend = (bytes: number): void => {
    if (!opts.file || !opts.maxBytes || !opts.maxFiles) return
    writtenSinceRotate += bytes
    if (writtenSinceRotate < opts.maxBytes) return
    writtenSinceRotate = 0
    try { rotateIfNeeded(opts.file, { maxBytes: opts.maxBytes, maxFiles: opts.maxFiles }) } catch (err) { console.error(`log rotate failed: ${String(err)}`) }
  }
  const build = (bound: Record<string, unknown>): Logger => {
    const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
      if (order[level] < min) return
      let line: string
      try {
        line = redact(safeStringify({ ts: new Date().toISOString(), level, msg, ...bound, ...fields }), opts.secrets ?? [])
      } catch {
        line = redact(JSON.stringify({ ts: new Date().toISOString(), level, msg, error: "unserializable fields" }), opts.secrets ?? [])
      }
      console[level === "debug" ? "log" : level](line)
      if (opts.file) {
        rotateForAppend(Buffer.byteLength(line) + 1)
        try { appendFileSync(opts.file, line + "\n") } catch (err) { console.error(`log append failed: ${String(err)}`) }
      }
    }
    return {
      debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f),
      child: (f) => build({ ...bound, ...f }),
    }
  }
  return build({})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/log.test.ts`
Expected: PASS (all existing tests plus the new one).

- [ ] **Step 5: Write the failing config tests**

Append to `test/config.test.ts`:

```ts
test("parses log rotation settings and defaults", () => {
  const c = loadConfig({ ...base, LOG_MAX_BYTES: "1024", LOG_MAX_FILES: "2" })
  expect(c.logMaxBytes).toBe(1024)
  expect(c.logMaxFiles).toBe(2)
  const d = loadConfig(base)
  expect(d.logMaxBytes).toBe(5_000_000)
  expect(d.logMaxFiles).toBe(3)
})

test("rejects invalid log rotation settings", () => {
  expect(() => loadConfig({ ...base, LOG_MAX_BYTES: "0" })).toThrow(/LOG_MAX_BYTES/)
  expect(() => loadConfig({ ...base, LOG_MAX_FILES: "0" })).toThrow(/LOG_MAX_FILES/)
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `c.logMaxBytes` is `undefined`.

- [ ] **Step 7: Implement the config fields**

In `src/config.ts`, change the `Config` interface lines to:

```ts
  dataDir: string; logLevel: "debug" | "info" | "warn" | "error"
  logMaxBytes: number; logMaxFiles: number
```

Then in `loadConfig`'s returned object, after the `dataDir` line, add:

```ts
    logMaxBytes: int(env, "LOG_MAX_BYTES", 5000000, 1),
    logMaxFiles: int(env, "LOG_MAX_FILES", 3, 1),
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing project-log rotation test**

Append to `test/projects.test.ts` (it already imports `createServer`, `existsSync`, `mkdtempSync`, `readFileSync`, `rmSync`, `statSync`, `join`, `openDb`, and has `makeCfg`, `logger`, `healthServer`, `fakes`):

```ts
test("project server logs rotate when they exceed logMaxBytes", async () => {
  const db = openDb(":memory:"); db.migrate()
  const { sbx, runner, children } = fakes()
  const server = await healthServer(true)
  const cfg = makeCfg(server.port, server.port)
  cfg.logMaxBytes = 200
  cfg.logMaxFiles = 1
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: cfg, log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    for (let i = 0; i < 5; i++) children[0].emitStdout("x".repeat(100))
    expect(existsSync(join(cfg.dataDir, "logs", "celly-demo.log.1"))).toBe(true)
  } finally {
    await server.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run test/projects.test.ts`
Expected: FAIL — `logs/celly-demo.log.1` does not exist.

- [ ] **Step 11: Implement rotation in the project log writer**

In `src/projects.ts`, add the import after the existing `./log.js` import:

```ts
import { rotateIfNeeded } from "./rotate.js"
```

Replace the `appendLog` block at lines 330-333:

```ts
    const logSecrets = [project.serverPassword]
    const appendLog = (prefix: string, data: unknown): void => {
      try { appendFileSync(logFile, redact(`[${prefix}] ${String(data)}`, logSecrets), { mode: 0o600 }) } catch {}
    }
```

with:

```ts
    const logSecrets = [project.serverPassword]
    let writtenSinceRotate = 0
    const appendLog = (prefix: string, data: unknown): void => {
      try {
        const line = redact(`[${prefix}] ${String(data)}`, logSecrets)
        writtenSinceRotate += Buffer.byteLength(line)
        if (this.deps.config.logMaxBytes && this.deps.config.logMaxFiles && writtenSinceRotate >= this.deps.config.logMaxBytes) {
          writtenSinceRotate = 0
          rotateIfNeeded(logFile, { maxBytes: this.deps.config.logMaxBytes, maxFiles: this.deps.config.logMaxFiles })
        }
        appendFileSync(logFile, line, { mode: 0o600 })
      } catch {}
    }
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run test/projects.test.ts test/log.test.ts test/config.test.ts`
Expected: PASS.

- [ ] **Step 13: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/log.ts src/projects.ts src/config.ts test/log.test.ts test/config.test.ts test/projects.test.ts
git commit -m "feat(ops): rotate bot and project server logs"
```

### Task 3: SQLite backup scheduler

**Files:**
- Create: `src/backup.ts`
- Modify: `src/db.ts` (add `backupTo` to the `Db` interface and implementation)
- Modify: `src/config.ts` (add `backupIntervalHours`, `backupKeep`)
- Test: `test/backup.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db.ts`; `Config` from `src/config.ts`.
- Produces: `Db.backupTo(dest: string): void`; `createBackupScheduler(deps: { db: Pick<Db, "backupTo">; dir: string; intervalMs: number; keep: number; now(): number }): { start(): void; stop(): void; tick(): Promise<string | undefined> }`; `Config.backupIntervalHours: number`, `Config.backupKeep: number`.

- [ ] **Step 1: Write the failing backup test**

Create `test/backup.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createBackupScheduler } from "../src/backup.ts"
import { openDb } from "../src/db.ts"

const proj = { channelId: "c1", guildId: "g1", name: "demo", directory: "C:\\p\\demo",
  sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 }

test("tick writes a VACUUM INTO backup that opens as SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-backup-"))
  const db = openDb(join(dir, "bot.db"))
  db.migrate()
  db.projects.insertProvisioning(proj)
  try {
    const out = join(dir, "backups")
    const scheduler = createBackupScheduler({ db, dir: out, intervalMs: 0, keep: 3, now: () => 1_700_000_000_000 })
    const file = await scheduler.tick()
    expect(file).toBe(join(out, "bot-2023-11-14T22-13-20-000Z.db"))
    const backup = new DatabaseSync(file!)
    expect((backup.prepare("SELECT name FROM projects").get() as any).name).toBe("demo")
    backup.close()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a quote in the backup directory path is escaped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-back'up-"))
  const db = openDb(join(dir, "bot.db"))
  db.migrate()
  try {
    const out = join(dir, "back'ups")
    const scheduler = createBackupScheduler({ db, dir: out, intervalMs: 0, keep: 1, now: () => 0 })
    const file = await scheduler.tick()
    const backup = new DatabaseSync(file!)
    expect((backup.prepare("SELECT count(*) AS n FROM projects").get() as any).n).toBe(0)
    backup.close()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prune keeps only the newest backups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-backup-"))
  const db = openDb(join(dir, "bot.db"))
  db.migrate()
  try {
    const out = join(dir, "backups")
    let clock = 1_700_000_000_000
    const scheduler = createBackupScheduler({ db, dir: out, intervalMs: 0, keep: 2, now: () => clock })
    clock += 1000; await scheduler.tick()
    clock += 1000; await scheduler.tick()
    clock += 1000; await scheduler.tick()
    const names = readdirSync(out).sort()
    expect(names).toHaveLength(2)
    expect(names[0]).toContain("2023-11-14T22-13-21")
    expect(names[1]).toContain("2023-11-14T22-13-22")
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/backup.test.ts`
Expected: FAIL — `Failed to resolve import "../src/backup.ts"`.

- [ ] **Step 3: Add `backupTo` to the database wrapper**

In `src/db.ts`, add to the `Db` interface after `close(): void`:

```ts
  backupTo(dest: string): void
```

In the `openDb` returned object, after `close() { raw.close() },`, add:

```ts
    backupTo(dest) {
      if (!dest || dest.includes("\0")) throw new Error("invalid backup path")
      raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
    },
```

- [ ] **Step 4: Write the backup scheduler implementation**

Create `src/backup.ts`:

```ts
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { Db } from "./db.ts"

export interface BackupSchedulerDeps {
  db: Pick<Db, "backupTo">
  dir: string
  intervalMs: number
  keep: number
  now(): number
}

export interface BackupScheduler {
  start(): void
  stop(): void
  tick(): Promise<string | undefined>
}

function prune(dir: string, keep: number): void {
  const names = readdirSync(dir).filter((name) => name.startsWith("bot-") && name.endsWith(".db")).sort()
  while (names.length > Math.max(1, Math.floor(keep))) {
    const oldest = names.shift()
    if (oldest) rmSync(join(dir, oldest), { force: true })
  }
}

export function createBackupScheduler(deps: BackupSchedulerDeps): BackupScheduler {
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = async (): Promise<string | undefined> => {
    mkdirSync(deps.dir, { recursive: true })
    const file = join(deps.dir, `bot-${new Date(deps.now()).toISOString().replace(/[:.]/g, "-")}.db`)
    if (!isAbsolute(file) || file.includes("\0")) throw new Error(`invalid backup path: ${file}`)
    deps.db.backupTo(file)
    prune(deps.dir, deps.keep)
    return file
  }
  return {
    tick,
    start() {
      if (timer !== undefined || deps.intervalMs <= 0) return
      timer = setInterval(() => { void tick().catch(() => {}) }, deps.intervalMs)
      if (typeof (timer as any).unref === "function") (timer as any).unref()
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/backup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing config tests**

Append to `test/config.test.ts`:

```ts
test("parses backup settings and defaults", () => {
  const c = loadConfig({ ...base, BACKUP_INTERVAL_HOURS: "0", BACKUP_KEEP: "3" })
  expect(c.backupIntervalHours).toBe(0)
  expect(c.backupKeep).toBe(3)
  const d = loadConfig(base)
  expect(d.backupIntervalHours).toBe(24)
  expect(d.backupKeep).toBe(7)
})

test("rejects invalid backup settings", () => {
  expect(() => loadConfig({ ...base, BACKUP_INTERVAL_HOURS: "-1" })).toThrow(/BACKUP_INTERVAL_HOURS/)
  expect(() => loadConfig({ ...base, BACKUP_KEEP: "0" })).toThrow(/BACKUP_KEEP/)
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `c.backupIntervalHours` is `undefined`.

- [ ] **Step 8: Implement the config fields**

In `src/config.ts`, add this helper after the `int` helper:

```ts
const nonNegative = (e: NodeJS.ProcessEnv, k: string, d: number) => {
  const n = num(e, k, d)
  if (n < 0) throw new Error(`${k} must be >= 0, got "${e[k]}"`)
  return n
}
```

Add to the `Config` interface after the log fields:

```ts
  backupIntervalHours: number; backupKeep: number
```

Add to the `loadConfig` return object after the log fields:

```ts
    backupIntervalHours: nonNegative(env, "BACKUP_INTERVAL_HOURS", 24),
    backupKeep: int(env, "BACKUP_KEEP", 7, 1),
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/backup.ts src/db.ts src/config.ts test/backup.test.ts test/config.test.ts
git commit -m "feat(ops): add SQLite backup scheduler"
```

### Task 4: `scheduled_tasks` migration and `db.tasks` CRUD

**Files:**
- Modify: `src/types.ts` (append `ScheduledTask`)
- Modify: `src/db.ts` (append migration 6 — version reserved by the spec; idle-auto-stop uses 5, providers-and-cost uses 7 — and add the `tasks` namespace)
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ScheduledTask { id: number; channelId: string; prompt: string; everyMinutes: number; nextRunAt: number; enabled: boolean; createdAt: number }` and `Db["tasks"]` with `add(input: { channelId: string; prompt: string; everyMinutes: number; nextRunAt: number; createdAt: number }): number`, `list(): ScheduledTask[]`, `remove(id: number): boolean`, `due(now: number): ScheduledTask[]`, `markRun(id: number, nextRunAt: number): void`, `setEnabled(id: number, enabled: boolean): void`.

- [ ] **Step 1: Write the failing database tests**

Append to `test/db.test.ts`:

```ts
test("scheduled_tasks CRUD round-trips and filters due tasks", () => {
  const db = fresh()
  const id = db.tasks.add({ channelId: "c1", prompt: "standup", everyMinutes: 60, nextRunAt: 1000, createdAt: 1 })
  expect(id).toBeGreaterThan(0)
  expect(db.tasks.list()).toMatchObject([{ id, channelId: "c1", prompt: "standup", everyMinutes: 60, nextRunAt: 1000, enabled: true, createdAt: 1 }])
  expect(db.tasks.due(999)).toEqual([])
  expect(db.tasks.due(1000).map((t) => t.id)).toEqual([id])
  db.tasks.setEnabled(id, false)
  expect(db.tasks.due(2000)).toEqual([])
  db.tasks.setEnabled(id, true)
  db.tasks.markRun(id, 5000)
  expect(db.tasks.due(4000)).toEqual([])
  expect(db.tasks.due(5000).map((t) => t.id)).toEqual([id])
  expect(db.tasks.remove(id)).toBe(true)
  expect(db.tasks.remove(id)).toBe(false)
  expect(db.tasks.list()).toEqual([])
})

test("the appended migration adds scheduled_tasks to an older database", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-db-tasks-"))
  const file = join(dir, "bot.db")
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec("PRAGMA user_version = 4")
    legacy.close()
    const db = openDb(file)
    db.migrate()
    const id = db.tasks.add({ channelId: "c1", prompt: "p", everyMinutes: 1, nextRunAt: 0, createdAt: 0 })
    expect(db.tasks.list().map((t) => t.id)).toEqual([id])
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'add')` because `db.tasks` does not exist.

- [ ] **Step 3: Add the type and migration**

In `src/types.ts`, append:

```ts
export interface ScheduledTask {
  id: number; channelId: string; prompt: string; everyMinutes: number
  nextRunAt: number; enabled: boolean; createdAt: number
}
```

In `src/db.ts`, extend the type import on line 2 to include `ScheduledTask`:

```ts
import type { Project, ProjectStatus, RenderState, ScheduledTask, Thread } from "./types.ts"
```

Add the schema constant after `SCHEMA_V2`:

```ts
const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, prompt TEXT NOT NULL,
  every_minutes INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
`
```

Append to the end of `MIGRATIONS` (never reorder existing entries):

```ts
  { version: 6, up: (raw) => raw.exec(SCHEMA_V6) },
```

Add the row mapper after `rowToThread`:

```ts
const rowToTask = (r: any): ScheduledTask => ({
  id: Number(r.id), channelId: r.channel_id, prompt: r.prompt, everyMinutes: r.every_minutes,
  nextRunAt: r.next_run_at, enabled: Number(r.enabled) === 1, createdAt: r.created_at,
})
```

- [ ] **Step 4: Add the `tasks` namespace**

In the `Db` interface, after the `threads` block and before `settings`, add:

```ts
  tasks: {
    add(input: { channelId: string; prompt: string; everyMinutes: number; nextRunAt: number; createdAt: number }): number
    list(): ScheduledTask[]
    remove(id: number): boolean
    due(now: number): ScheduledTask[]
    markRun(id: number, nextRunAt: number): void
    setEnabled(id: number, enabled: boolean): void
  }
```

In the `openDb` returned object, after the `threads` block and before `settings`, add:

```ts
    tasks: {
      add(input) {
        const info = raw.prepare(`INSERT INTO scheduled_tasks (channel_id,prompt,every_minutes,next_run_at,enabled,created_at)
          VALUES (?,?,?,?,1,?)`).run(input.channelId, input.prompt, input.everyMinutes, input.nextRunAt, input.createdAt)
        return Number(info.lastInsertRowid)
      },
      list() { return raw.prepare(`SELECT * FROM scheduled_tasks ORDER BY id`).all().map(rowToTask) },
      remove(id) { return Number(raw.prepare(`DELETE FROM scheduled_tasks WHERE id=?`).run(id).changes) > 0 },
      due(now) { return raw.prepare(`SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at`).all(now).map(rowToTask) },
      markRun(id, nextRunAt) { raw.prepare(`UPDATE scheduled_tasks SET next_run_at=? WHERE id=?`).run(nextRunAt, id) },
      setEnabled(id, enabled) { raw.prepare(`UPDATE scheduled_tasks SET enabled=? WHERE id=?`).run(enabled ? 1 : 0, id) },
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/db.test.ts`
Expected: PASS (all existing tests plus the 2 new ones).

- [ ] **Step 6: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/types.ts src/db.ts test/db.test.ts
git commit -m "feat(tasks): add scheduled_tasks storage"
```

### Task 5: Task runner

**Files:**
- Create: `src/tasks.ts`
- Test: `test/tasks.test.ts`

**Interfaces:**
- Consumes: `Db["tasks"]` and `Db["threads"]` from Task 4; `ScheduledTask` from `src/types.ts`.
- Produces: `createTaskRunner(deps: { db: Pick<Db, "tasks" | "threads">; now(): number; everyMs: number; prompt(threadId: string, text: string, actor: string): Promise<string | undefined>; ensureThread(channelId: string): Promise<string>; log?: { warn(message: string, fields?: Record<string, unknown>): void } }): { start(): void; stop(): void; tick(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

Create `test/tasks.test.ts`:

```ts
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"
import { createTaskRunner } from "../src/tasks.ts"

function setup() {
  const db = openDb(":memory:"); db.migrate()
  db.projects.insertProvisioning({ channelId: "c1", guildId: "g", name: "demo", directory: "C:\\p",
    sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 })
  return db
}

function threadRow(threadId: string, lastActiveAt: number) {
  return { threadId, channelId: "c1", sessionId: `s-${threadId}`, title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle" as const, createdAt: 1, lastActiveAt }
}

test("tick prompts the most recent thread for each due task and advances next_run_at", async () => {
  const db = setup()
  db.threads.upsert(threadRow("t-old", 10))
  db.threads.upsert(threadRow("t-new", 20))
  const id = db.tasks.add({ channelId: "c1", prompt: "standup", everyMinutes: 60, nextRunAt: 1_000, createdAt: 1 })
  const prompts: Array<[string, string, string]> = []
  const now = 1_500
  const runner = createTaskRunner({ db, now: () => now, everyMs: 0,
    prompt: async (threadId, text, actor) => { prompts.push([threadId, text, actor]); return undefined },
    ensureThread: async () => { throw new Error("ensureThread should not be called") } })
  await runner.tick()
  expect(prompts).toEqual([["t-new", "standup", "task"]])
  expect(db.tasks.list()[0]?.nextRunAt).toBe(now + 60 * 60_000)
  expect(db.tasks.list()[0]?.id).toBe(id)
})

test("tick skips disabled and not-yet-due tasks", async () => {
  const db = setup()
  const id = db.tasks.add({ channelId: "c1", prompt: "later", everyMinutes: 5, nextRunAt: 10_000, createdAt: 1 })
  db.tasks.setEnabled(id, false)
  const prompts: string[] = []
  const runner = createTaskRunner({ db, now: () => 20_000, everyMs: 0,
    prompt: async () => { prompts.push("x"); return undefined },
    ensureThread: async () => "t1" })
  await runner.tick()
  expect(prompts).toEqual([])
})

test("tick creates a thread when the channel has none", async () => {
  const db = setup()
  db.tasks.add({ channelId: "c1", prompt: "kickoff", everyMinutes: 1, nextRunAt: 0, createdAt: 1 })
  const prompts: string[] = []
  const runner = createTaskRunner({ db, now: () => 1, everyMs: 0,
    prompt: async (threadId) => { prompts.push(threadId); return undefined },
    ensureThread: async (channelId) => `new-${channelId}` })
  await runner.tick()
  expect(prompts).toEqual(["new-c1"])
})

test("a failing prompt is logged and leaves next_run_at unchanged for retry", async () => {
  const db = setup()
  const id = db.tasks.add({ channelId: "c1", prompt: "flaky", everyMinutes: 5, nextRunAt: 0, createdAt: 1 })
  const warnings: string[] = []
  const runner = createTaskRunner({ db, now: () => 100, everyMs: 0,
    prompt: async () => { throw new Error("boom") },
    ensureThread: async () => "t1",
    log: { warn: (message) => { warnings.push(message) } } })
  await runner.tick()
  expect(warnings).toEqual(["scheduled task failed"])
  expect(db.tasks.list()[0]?.id).toBe(id)
  expect(db.tasks.list()[0]?.nextRunAt).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tasks.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tasks.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/tasks.ts`:

```ts
import type { Db } from "./db.ts"
import type { ScheduledTask } from "./types.ts"

export interface TaskRunnerDeps {
  db: Pick<Db, "tasks" | "threads">
  now(): number
  everyMs: number
  prompt(threadId: string, text: string, actor: string): Promise<string | undefined>
  ensureThread(channelId: string): Promise<string>
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
}

export interface TaskRunner {
  start(): void
  stop(): void
  tick(): Promise<void>
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const tick = async (): Promise<void> => {
    let due: ScheduledTask[]
    try {
      due = deps.db.tasks.due(deps.now())
    } catch (e) {
      deps.log?.warn("task tick failed", { error: String(e) })
      return
    }
    for (const task of due) {
      try {
        const threadId = deps.db.threads.byChannel(task.channelId)[0]?.threadId ?? await deps.ensureThread(task.channelId)
        await deps.prompt(threadId, task.prompt, "task")
        deps.db.tasks.markRun(task.id, deps.now() + task.everyMinutes * 60_000)
      } catch (e) {
        deps.log?.warn("scheduled task failed", { id: task.id, channelId: task.channelId, error: String(e) })
      }
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    tick,
    start() {
      if (timer !== undefined || deps.everyMs <= 0) return
      timer = setInterval(() => { void tick() }, deps.everyMs)
      if (typeof (timer as any).unref === "function") (timer as any).unref()
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tasks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/tasks.ts test/tasks.test.ts
git commit -m "feat(tasks): add scheduled task runner"
```

### Task 6: `/task add|list|remove` commands

**Files:**
- Modify: `src/commands.ts` (imports, `commandData`, `requiresOwner`, `handleCommand`)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `Db["tasks"]` from Task 4.
- Produces: `/task` command registration with subcommands `add` (`channel` channel option, `prompt` string, `every_minutes` integer), `list`, `remove` (`id` integer); `requiresOwner("task", "add" | "remove") === true`.

- [ ] **Step 1: Update the command-set test and add the failing tests**

In `test/commands.test.ts`, change the existing `"declares the v1 command set"` test to:

```ts
test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "model", "new", "project", "resume", "task"])
})
```

Append to `test/commands.test.ts`:

```ts
function taskInteraction(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    commandName: "task",
    guildId: "g",
    channelId: over.channelId ?? "c",
    user: over.user ?? { id: "u1" },
    calls,
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => (over.strings ?? {})[n],
      getInteger: (n: string) => (over.integers ?? {})[n],
      getChannel: (n: string) => (over.channels ?? {})[n],
    },
    deferReply: async (o: any) => { calls.push({ kind: "defer", o }) },
    editReply: async (c: any) => { calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}

test("task declares add, list, and remove subcommands", () => {
  const task = commandData().find((c) => c.name === "task")!
  expect(task.options.map((o: any) => o.name).sort()).toEqual(["add", "list", "remove"])
  const add = task.options.find((o: any) => o.name === "add")!
  expect(add.options.map((o: any) => o.name)).toEqual(["channel", "prompt", "every_minutes"])
})

test("task add schedules a prompt in a project channel", async () => {
  const db = fresh()
  db.projects.insertProvisioning({ ...proj, channelId: "c", name: "demo" })
  const i = taskInteraction({ sub: "add", channels: { channel: { id: "c" } }, strings: { prompt: "standup" }, integers: { every_minutes: 60 } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true })
  const tasks = db.tasks.list()
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ channelId: "c", prompt: "standup", everyMinutes: 60, enabled: true })
  expect(editOf(i)).toContain("scheduled task")
  expect(editOf(i)).toContain("every 60m")
})

test("task add rejects a channel that is not a project", async () => {
  const i = taskInteraction({ sub: "add", channels: { channel: { id: "other" } }, strings: { prompt: "p" }, integers: { every_minutes: 5 } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(db.tasks.list()).toEqual([])
  expect(editOf(i)).toBe("channel is not a project")
})

test("task list renders tasks and remove deletes by id", async () => {
  const db = fresh()
  const id = db.tasks.add({ channelId: "c", prompt: "standup", everyMinutes: 60, nextRunAt: 1000, createdAt: 1 })
  const list = taskInteraction({ sub: "list" })
  await handleCommand(list, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(list)).toContain(`#${id}`)
  const remove = taskInteraction({ sub: "remove", integers: { id } })
  await handleCommand(remove, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true })
  expect(editOf(remove)).toBe(`removed task ${id}`)
  expect(db.tasks.list()).toEqual([])
  const missing = taskInteraction({ sub: "remove", integers: { id } })
  await handleCommand(missing, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true })
  expect(editOf(missing)).toBe(`task ${id} not found`)
})

test("requiresOwner covers task add and remove only", () => {
  expect(requiresOwner("task", "add")).toBe(true)
  expect(requiresOwner("task", "remove")).toBe(true)
  expect(requiresOwner("task", "list")).toBe(false)
})

test("authorized non-owners are denied task add and remove before defer", async () => {
  for (const sub of ["add", "remove"]) {
    const i = taskInteraction({ sub, channels: { channel: { id: "c" } }, strings: { prompt: "p" }, integers: { every_minutes: 1, id: 1 } })
    await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
    expect(i.calls).toHaveLength(1)
    expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64, allowedMentions: { parse: [] } } })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — the command list is missing `"task"` and the new handler branches reply `not implemented in this build`.

- [ ] **Step 3: Register the command and owner gate**

In `src/commands.ts`, change the `discord.js` import to include `ChannelType`:

```ts
import { ApplicationCommandOptionType, ChannelType, ComponentType } from "discord.js"
```

In `commandData`, add this entry to the returned array (after the `project` entry):

```ts
    { name: "task", description: "Manage scheduled prompts", options: [
      { type: ApplicationCommandOptionType.Subcommand, name: "add", description: "Schedule a recurring prompt in a project channel", options: [
        { type: ApplicationCommandOptionType.Channel, name: "channel", description: "Project channel", required: true, channel_types: [ChannelType.GuildText] },
        { type: ApplicationCommandOptionType.String, name: "prompt", description: "Prompt text", required: true },
        { type: ApplicationCommandOptionType.Integer, name: "every_minutes", description: "Repeat interval in minutes", required: true, min_value: 1 } ] },
      { type: ApplicationCommandOptionType.Subcommand, name: "list", description: "List scheduled prompts" },
      { type: ApplicationCommandOptionType.Subcommand, name: "remove", description: "Remove a scheduled prompt", options: [
        { type: ApplicationCommandOptionType.Integer, name: "id", description: "Task id from /task list", required: true, min_value: 1 } ] },
    ] },
```

Replace `OWNER_ONLY_PROJECT_SUBS` and `requiresOwner` with:

```ts
const OWNER_ONLY_PROJECT_SUBS = new Set(["add", "create", "start", "stop", "remove"])
const OWNER_ONLY_TASK_SUBS = new Set(["add", "remove"])
export function requiresOwner(commandName: string, sub: string | null | undefined): boolean {
  if (commandName === "project") return !!sub && OWNER_ONLY_PROJECT_SUBS.has(sub)
  if (commandName === "task") return !!sub && OWNER_ONLY_TASK_SUBS.has(sub)
  return false
}
```

- [ ] **Step 4: Add the handler branch**

In `handleCommand`, change the subcommand lookup near the top to:

```ts
  const sub = interaction.commandName === "project" || interaction.commandName === "task"
    ? interaction.options.getSubcommand(false)
    : null
```

Insert this branch after the `project` block (before the `new` block):

```ts
    if (interaction.commandName === "task") {
      if (sub === "add") {
        const channelId = interaction.options.getChannel("channel", true)?.id
        const project = channelId ? deps.db.projects.getByChannel(channelId) : undefined
        if (!project) return void await interaction.editReply(noMentions("channel is not a project"))
        const prompt = interaction.options.getString("prompt", true)
        const everyMinutes = interaction.options.getInteger("every_minutes", true)
        const now = Date.now()
        const id = deps.db.tasks.add({ channelId: project.channelId, prompt, everyMinutes, nextRunAt: now + everyMinutes * 60_000, createdAt: now })
        return void await interaction.editReply(noMentions(`scheduled task ${id} every ${everyMinutes}m in <#${project.channelId}>`))
      }
      if (sub === "list") {
        const lines = deps.db.tasks.list().map((t) => `#${t.id} <#${t.channelId}> every ${t.everyMinutes}m next ${new Date(t.nextRunAt).toISOString()}${t.enabled ? "" : " (disabled)"}`)
        return void await interaction.editReply(noMentions(lines.join("\n") || "no scheduled tasks"))
      }
      if (sub === "remove") {
        const id = interaction.options.getInteger("id", true)
        const removed = deps.db.tasks.remove(id)
        return void await interaction.editReply(noMentions(removed ? `removed task ${id}` : `task ${id} not found`))
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS (all existing tests plus the 6 new ones).

- [ ] **Step 6: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/commands.ts test/commands.test.ts
git commit -m "feat(tasks): add /task commands"
```

### Task 7: Loopback admin server

**Files:**
- Create: `src/admin.ts`
- Modify: `src/config.ts` (add `adminPort`)
- Test: `test/admin.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `Db["projects"]`; `redact` from `src/log.ts`.
- Produces: `ADMIN_HOST = "127.0.0.1"`; `createAdminServer(deps: { port: number; db: Pick<Db, "projects">; secrets: string[]; logFileFor(channelId: string): string | undefined; start(channelId: string): Promise<void>; stop(channelId: string): Promise<void>; auditTail?(limit: number): unknown[]; now?(): number }): Promise<{ port: number; address: string; close(): void }>`; `Config.adminPort: number`.

- [ ] **Step 1: Write the failing config test**

Append to `test/config.test.ts`:

```ts
test("admin port defaults to 4560 and accepts 0 to disable", () => {
  expect(loadConfig(base).adminPort).toBe(4560)
  expect(loadConfig({ ...base, ADMIN_PORT: "0" }).adminPort).toBe(0)
  expect(() => loadConfig({ ...base, ADMIN_PORT: "-1" })).toThrow(/ADMIN_PORT/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `loadConfig(base).adminPort` is `undefined`.

- [ ] **Step 3: Implement the config field**

In `src/config.ts`, add to the `Config` interface after the backup fields:

```ts
  adminPort: number
```

Add to the `loadConfig` return object after the backup fields:

```ts
    adminPort: int(env, "ADMIN_PORT", 4560, 0),
```

- [ ] **Step 4: Write the failing admin tests**

Create `test/admin.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createAdminServer } from "../src/admin.ts"
import { openDb } from "../src/db.ts"

const proj = { channelId: "c1", guildId: "g", name: "demo", directory: "C:\\p",
  sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 }

function fresh() { const db = openDb(":memory:"); db.migrate(); return db }

async function admin(over: any = {}) {
  const db = over.db ?? fresh()
  if (!over.skipProject) { db.projects.insertProvisioning(proj); db.projects.setReady("c1", "C:\\p") }
  const calls: string[] = []
  const svr = await createAdminServer({
    port: 0,
    db,
    secrets: over.secrets ?? [],
    logFileFor: over.logFileFor ?? (() => undefined),
    start: async (channelId: string) => { calls.push(`start:${channelId}`) },
    stop: async (channelId: string) => { calls.push(`stop:${channelId}`) },
    auditTail: over.auditTail,
    now: over.now,
  })
  return { svr, db, calls, base: `http://127.0.0.1:${svr.port}` }
}

test("the admin server binds loopback and renders the HTML status page", async () => {
  const { svr, db, base } = await admin()
  db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "<b>bold</b>", sandboxName: "celly-bold", hostPort: 4301 })
  try {
    expect(svr.address).toBe("127.0.0.1")
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("demo")
    expect(body).toContain("&lt;b&gt;bold&lt;/b&gt;")
  } finally {
    svr.close()
  }
})

test("GET /api/projects returns the registered projects", async () => {
  const { svr, base } = await admin()
  try {
    const res = await fetch(`${base}/api/projects`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ channelId: "c1", name: "demo", status: "ready", hostPort: 4300 }])
  } finally {
    svr.close()
  }
})

test("GET /api/health reports project counts and uptime", async () => {
  const { svr, base } = await admin({ now: () => 10_000 })
  try {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, projects: 1, ready: 1, uptimeMs: 0 })
  } finally {
    svr.close()
  }
})

test("POST start and stop call the injected actions and 404 unknown projects", async () => {
  const { svr, base, calls } = await admin()
  try {
    expect((await fetch(`${base}/api/projects/c1/start`, { method: "POST" })).status).toBe(200)
    expect((await fetch(`${base}/api/projects/c1/stop`, { method: "POST" })).status).toBe(200)
    expect(calls).toEqual(["start:c1", "stop:c1"])
    const missing = await fetch(`${base}/api/projects/nope/start`, { method: "POST" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "unknown project" })
    expect((await fetch(`${base}/api/projects/c1/start`)).status).toBe(405)
  } finally {
    svr.close()
  }
})

test("a failing project action returns a JSON 500", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const svr = await createAdminServer({ port: 0, db, secrets: [], logFileFor: () => undefined,
    start: async () => { throw new Error("boom") }, stop: async () => {} })
  try {
    const res = await fetch(`http://127.0.0.1:${svr.port}/api/projects/c1/start`, { method: "POST" })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "boom" })
  } finally {
    svr.close()
  }
})

test("GET /api/logs tails and redacts the project log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-admin-"))
  const file = join(dir, "celly-demo.log")
  writeFileSync(file, ["one", "two", "pw-secret", "four", "five"].join("\n") + "\n")
  const { svr, base } = await admin({ secrets: ["pw-secret"], logFileFor: () => file })
  try {
    const res = await fetch(`${base}/api/logs/c1?lines=4`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.channelId).toBe("c1")
    expect(body.file).toBe(file)
    expect(body.lines).toHaveLength(4)
    expect(body.lines.join("\n")).toContain("[redacted]")
    expect(body.lines.join("\n")).not.toContain("pw-secret")
    expect(body.lines.join("\n")).not.toContain("one")
    const all = await (await fetch(`${base}/api/logs/c1`)).json()
    expect(all.lines).toHaveLength(5)
  } finally {
    svr.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("GET /api/logs 404s when there is no log file", async () => {
  const { svr, base } = await admin({ logFileFor: () => undefined })
  try {
    const res = await fetch(`${base}/api/logs/c1`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "log not found" })
  } finally {
    svr.close()
  }
})

test("GET /api/audit returns injected entries and 404s when unavailable", async () => {
  const withAudit = await admin({ auditTail: (limit: number) => [{ kind: "mode", limit }] })
  try {
    const res = await fetch(`${withAudit.base}/api/audit?limit=5`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [{ kind: "mode", limit: 5 }] })
  } finally {
    withAudit.svr.close()
  }
  const without = await admin()
  try {
    const res = await fetch(`${without.base}/api/audit`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "audit log unavailable" })
  } finally {
    without.svr.close()
  }
})

test("unknown routes and methods return JSON errors", async () => {
  const { svr, base } = await admin()
  try {
    const notFound = await fetch(`${base}/api/nope`)
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ error: "not found" })
    const wrongMethod = await fetch(`${base}/api/health`, { method: "POST" })
    expect(wrongMethod.status).toBe(405)
    expect(await wrongMethod.json()).toEqual({ error: "method not allowed" })
  } finally {
    svr.close()
  }
})
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run test/admin.test.ts`
Expected: FAIL — `Failed to resolve import "../src/admin.ts"`.

- [ ] **Step 6: Write the implementation**

Create `src/admin.ts`:

```ts
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import type { Db } from "./db.ts"
import { redact } from "./log.js"

export const ADMIN_HOST = "127.0.0.1"

export interface AdminDeps {
  port: number
  db: Pick<Db, "projects">
  secrets: string[]
  logFileFor(channelId: string): string | undefined
  start(channelId: string): Promise<void>
  stop(channelId: string): Promise<void>
  auditTail?(limit: number): unknown[]
  now?(): number
}

export interface AdminServer {
  port: number
  address: string
  close(): void
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function tailLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-count)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" })
  res.end(body)
}

export async function createAdminServer(deps: AdminDeps): Promise<AdminServer> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${ADMIN_HOST}`)
        const parts = url.pathname.split("/").filter(Boolean)
        const method = req.method ?? "GET"
        if (parts.length === 0 && method === "GET") {
          const rows = deps.db.projects.list()
            .map((p) => `<li>${escapeHtml(p.name)} — ${escapeHtml(p.status)} (${p.hostPort})</li>`).join("")
          sendHtml(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Celly admin</title></head><body><h1>Celly</h1><ul>${rows}</ul></body></html>`)
          return
        }
        if (parts[0] === "api" && parts[1] === "projects" && parts.length === 2 && method === "GET") {
          sendJson(res, 200, deps.db.projects.list().map((p) => ({ channelId: p.channelId, name: p.name, status: p.status, hostPort: p.hostPort })))
          return
        }
        if (parts[0] === "api" && parts[1] === "health" && parts.length === 2) {
          if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
          const projects = deps.db.projects.list()
          sendJson(res, 200, { ok: true, projects: projects.length, ready: projects.filter((p) => p.status === "ready").length, uptimeMs: Math.max(0, now() - startedAt) })
          return
        }
        if (parts[0] === "api" && parts[1] === "projects" && parts.length === 4 && (parts[3] === "start" || parts[3] === "stop")) {
          if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
          const channelId = parts[2]!
          if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
          const action = parts[3]
          try {
            await (action === "start" ? deps.start(channelId) : deps.stop(channelId))
            sendJson(res, 200, { ok: true, action, channelId })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }
        if (parts[0] === "api" && parts[1] === "logs" && parts.length === 3 && method === "GET") {
          const channelId = parts[2]!
          const file = deps.logFileFor(channelId)
          if (!file || !existsSync(file)) return sendJson(res, 404, { error: "log not found" })
          const requested = Number(url.searchParams.get("lines") ?? "200")
          const count = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 2000) : 200
          const lines = tailLines(redact(readFileSync(file, "utf8"), deps.secrets), count)
          sendJson(res, 200, { channelId, file, lines })
          return
        }
        if (parts[0] === "api" && parts[1] === "audit" && parts.length === 2) {
          if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
          if (!deps.auditTail) return sendJson(res, 404, { error: "audit log unavailable" })
          const requested = Number(url.searchParams.get("limit") ?? "100")
          const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 1000) : 100
          sendJson(res, 200, { entries: deps.auditTail(limit) })
          return
        }
        sendJson(res, 404, { error: "not found" })
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(deps.port, ADMIN_HOST, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const bound = server.address()
  const boundPort = typeof bound === "object" && bound ? bound.port : deps.port
  const boundAddress = typeof bound === "object" && bound ? bound.address : ADMIN_HOST
  return {
    port: boundPort,
    address: boundAddress,
    close() {
      server.closeAllConnections()
      server.close()
    },
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/admin.test.ts test/config.test.ts`
Expected: PASS (10 admin tests plus config tests).

- [ ] **Step 8: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/admin.ts src/config.ts test/admin.test.ts test/config.test.ts
git commit -m "feat(admin): add loopback admin server"
```

### Task 8: Wire ops into boot and shutdown

**Files:**
- Modify: `src/index.ts` (imports, logger, backup, admin, task runner, shutdown)
- Test: `test/wiring.test.ts`

**Interfaces:**
- Consumes: `createLogger` rotation opts (Task 2); `createBackupScheduler` (Task 3); `createTaskRunner` (Task 5); `createAdminServer` and `AdminServer` (Task 7); `cfg.adminPort`, `cfg.logMaxBytes`, `cfg.logMaxFiles`, `cfg.backupIntervalHours`, `cfg.backupKeep`.
- Produces: boot wiring where the admin server closes before the DB, and ops timers stop before projects are torn down.

- [ ] **Step 1: Write the failing wiring test**

In `test/wiring.test.ts`, add `import { readFileSync } from "node:fs"` at the top, then append:

```ts
test("index wires log rotation, backups, tasks, and the admin server into boot", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  expect(source).toContain("maxBytes: cfg.logMaxBytes")
  expect(source).toContain("maxFiles: cfg.logMaxFiles")
  expect(source).toContain("createBackupScheduler({")
  expect(source).toContain("createTaskRunner({")
  expect(source).toContain("createAdminServer({")
  expect(source).toContain("taskRunner.stop()")
  expect(source).toContain("backups?.stop()")
  expect(source).toContain("admin?.close()")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wiring.test.ts`
Expected: FAIL — `createBackupScheduler({` is not found in `src/index.ts`.

- [ ] **Step 3: Add imports and logger rotation options**

In `src/index.ts`, add to the top import block:

```ts
import { join } from "node:path"
import { createAdminServer } from "./admin.js"
import type { AdminServer } from "./admin.js"
import { createBackupScheduler } from "./backup.js"
import { createTaskRunner } from "./tasks.js"
```

Change the logger construction (line 35) to:

```ts
  const log = createLogger({ level: cfg.logLevel, file: `${cfg.dataDir}/bot.log`, secrets, truncate: true, maxBytes: cfg.logMaxBytes, maxFiles: cfg.logMaxFiles })
```

- [ ] **Step 4: Start the backup scheduler**

In `src/index.ts`, after `seedSettings(db, cfg)` (line 39), add:

```ts
  const backups = cfg.backupIntervalHours > 0
    ? createBackupScheduler({
        db, dir: join(cfg.dataDir, "backups"),
        intervalMs: cfg.backupIntervalHours * 3_600_000,
        keep: cfg.backupKeep, now: () => Date.now(),
      })
    : undefined
  backups?.start()
```

- [ ] **Step 5: Start the admin server after subscriptions are defined**

In `src/index.ts`, after the `startSubscription` function (currently ends line 313), add:

```ts
  let admin: AdminServer | undefined
  if (cfg.adminPort > 0) {
    try {
      admin = await createAdminServer({
        port: cfg.adminPort,
        db,
        secrets,
        logFileFor: (channelId) => {
          const project = db.projects.getByChannel(channelId)
          return project ? join(cfg.dataDir, "logs", `${project.sandboxName}.log`) : undefined
        },
        start: async (channelId) => { startSubscription(channelId); await projects.start(channelId) },
        stop: async (channelId) => {
          await runnerSvc.resetChannel(channelId, { notify: true })
          stopSubscription(channelId)
          await projects.stop(channelId)
        },
      })
      log.info("admin server listening", { port: admin.port })
    } catch (e) {
      log.warn("admin server failed to start", { port: cfg.adminPort, error: String(e) })
    }
  }
```

- [ ] **Step 6: Start the task runner after `createThreadForProject` is defined**

In `src/index.ts`, after `createThreadForProject` (currently ends line 333), add:

```ts
  const taskRunner = createTaskRunner({
    db,
    now: () => Date.now(),
    everyMs: 30_000,
    prompt: (threadId, text, actor) => runnerSvc.prompt(threadId, text, actor),
    ensureThread: async (channelId) => (await createThreadForProject({ channelId, title: "scheduled task" })).threadId,
    log: { warn: (message, fields) => log.warn(message, fields) },
  })
  taskRunner.start()
```

- [ ] **Step 7: Stop ops on shutdown**

Replace the `shutdown` construction (currently lines 430-438) with:

```ts
  const shutdown = createShutdown({
    log,
    abortControllers: () => controllers.values(),
    stopProjects: async () => {
      taskRunner.stop()
      backups?.stop()
      for (const project of db.projects.list()) await projects.stop(project.channelId).catch(() => {})
    },
    destroyClient: () => client.destroy(),
    closeDb: () => { admin?.close(); db.close() },
    releaseLock: () => lock.release(),
    exit: (code) => process.exit(code),
  })
```

- [ ] **Step 8: Run tests and typecheck to verify**

Run: `npx vitest run test/wiring.test.ts && npm run typecheck`
Expected: PASS and no type errors.

- [ ] **Step 9: Run the full gate and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/index.ts test/wiring.test.ts
git commit -m "feat(admin): wire admin, backups, and task runner into boot"
```

### Task 9: Documentation, env example, and changeset

**Files:**
- Create: `docs-site/guides/deployment-linux.mdx`
- Create: `.changeset/admin-and-ops.md`
- Modify: `docs-site/docs.json`, `docs-site/guides/deployment.mdx`, `docs-site/guides/configuration.mdx`, `docs-site/reference/commands.mdx`, `docs-site/reference/security.mdx`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: all finished behavior from Tasks 1-8.
- Produces: no code interfaces; docs must match the shipped env vars, commands, and routes exactly.

- [ ] **Step 1: Create the Linux deployment guide**

Create `docs-site/guides/deployment-linux.mdx`:

````mdx
---
title: Deployment on Linux
description: Run Celly as a long-lived systemd user service on a Linux host, with Node 24, sbx, loopback admin, backups, and log rotation.
---

This guide covers running Celly as a long-lived service on a Linux host with
`systemd --user`. As on Windows, the bot **must** run as the user who owns the
`sbx` daemon and its credentials.

## 1. Host bootstrap

1. Install `sbx` (Docker Sandboxes), then log in and initialize the network
   policy:
   ```bash
   sbx login
   sbx policy init balanced
   sbx version
   ```
   Celly targets `sbx` >= 0.45.0.
2. Install Node 24 with `fnm` (or `nvm`):
   ```bash
   curl -fsSL https://fnm.vercel.app/install | bash
   fnm install 24
   fnm default 24
   ```
3. Register provider credentials used by the sandboxed agent (see
   [Providers](/guides/providers)):
   ```bash
   sbx secret set <provider>
   ```

## 2. Build and configure

```bash
git clone https://github.com/LegendArtur/bot-celly.git ~/discordAI
cd ~/discordAI
npm ci
npm run build
cp .env.example .env   # fill in DISCORD_TOKEN and DISCORD_GUILD_ID
node dist/index.js     # first foreground boot; Ctrl-C once it is ready
```

## 3. systemd user service

Create `~/.config/systemd/user/celly.service`:

```ini
[Unit]
Description=Celly Discord bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/discordAI
ExecStart=/bin/bash -lc 'exec node dist/index.js'
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

`bash -lc` loads your shell profile so `fnm`/`nvm` and `sbx` are on `PATH`;
`exec` keeps Node as the main process so `SIGTERM` reaches Celly's shutdown
handler. Enable it and keep it running after logout:

```bash
systemctl --user daemon-reload
systemctl --user enable --now celly
loginctl enable-linger "$USER"
journalctl --user -u celly -f
```

## 4. Backups and log rotation

Celly backs up `DATA_DIR/bot.db` with SQLite `VACUUM INTO` on an interval and
prunes old copies. It also rotates `bot.log` and every per-project server log.

| Variable | Default | Behavior |
| --- | --- | --- |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between backups; `0` disables backups. |
| `BACKUP_KEEP` | `7` | Backup files kept before the oldest is pruned. |
| `LOG_MAX_BYTES` | `5000000` | Rotate a log after this many bytes. |
| `LOG_MAX_FILES` | `3` | Rotated copies kept (`.1`…`.N`). |

Backups are named `data/backups/bot-<ISO>.db`. To restore one, stop the service,
replace the database, and start it again:

```bash
systemctl --user stop celly
cp data/backups/bot-2026-09-27T00-00-00-000Z.db data/bot.db
systemctl --user start celly
```

## 5. Admin page (optional)

Set `ADMIN_PORT` (default `4560`, `0` disables) to serve a loopback-only status
page and JSON API:

- `GET /` — HTML status page
- `GET /api/projects`, `GET /api/health`
- `POST /api/projects/<channelId>/start|stop`
- `GET /api/logs/<channelId>?lines=200` — redacted log tail
- `GET /api/audit?limit=100` — when the audit log is enabled

It binds `127.0.0.1` only and has no authentication: reach it through an SSH
tunnel (`ssh -L 4560:127.0.0.1:4560 host`) and never expose the port.

## 6. Verifying a deployment

- `sbx diagnose` reports a healthy daemon and authentication.
- `systemctl --user status celly` is `active (running)`.
- `curl -s http://127.0.0.1:4560/api/health` returns `{"ok":true,...}`.
- `data/bot.log` shows the preflight passing and the Discord client logging in.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `sbx CLI not found` | PATH does not include `sbx` in the unit | Keep `ExecStart=/bin/bash -lc …`. |
| Boot fails with an `sbx login` error | Expired credentials | Re-run `sbx login` as the service user, then `systemctl --user restart celly`. |
| Service stops at logout | No lingering user session | `loginctl enable-linger "$USER"`. |
| Admin port unreachable | It listens on loopback by design | Use an SSH tunnel; do not expose it publicly. |
````

- [ ] **Step 2: Register the page in the docs nav**

In `docs-site/docs.json`, change the Guides pages array from:

```json
        "pages": [
          "guides/configuration",
          "guides/providers",
          "guides/terminal-attach",
          "guides/deployment"
        ]
```

to:

```json
        "pages": [
          "guides/configuration",
          "guides/providers",
          "guides/terminal-attach",
          "guides/deployment",
          "guides/deployment-linux"
        ]
```

If the file contains merge-conflict markers, resolve them first to the committed `main` values (`"name": "Celly"`, `"theme": "mint"`).

- [ ] **Step 3: Add the Windows backup section**

In `docs-site/guides/deployment.mdx`, insert this section immediately before `## 5. Verifying a deployment`, and renumber that heading to `## 6.`, `## 6. Troubleshooting` to `## 7.`, `## 7. Sensitive paths` to `## 8.`, and `## 8. Limitations to plan around` to `## 9.`:

````mdx
## 5. Backups and log rotation

Celly writes a full SQLite backup of `DATA_DIR/bot.db` with `VACUUM INTO` and
prunes old copies. It also rotates `bot.log` and each project server log.

| Variable | Default | Behavior |
| --- | --- | --- |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between backups; `0` disables. |
| `BACKUP_KEEP` | `7` | Backups kept before the oldest is pruned. |
| `LOG_MAX_BYTES` | `5000000` | Rotate a log after this many bytes. |
| `LOG_MAX_FILES` | `3` | Rotated copies kept (`.1`…`.N`). |

Backups land in `data\backups\bot-<ISO>.db` (for example
`bot-2026-09-27T00-00-00-000Z.db`). To restore, stop the task, replace
`data\bot.db`, and start the task again:

```powershell
Stop-ScheduledTask -TaskName Celly
Copy-Item data\backups\bot-2026-09-27T00-00-00-000Z.db data\bot.db -Force
Start-ScheduledTask -TaskName Celly
```

`ADMIN_PORT` (default `4560`, `0` disables) serves a loopback-only status page
and JSON API. Reach it from the host at `http://127.0.0.1:4560`; never
port-forward it.
````

- [ ] **Step 4: Document the config variables**

In `docs-site/guides/configuration.mdx`, add these rows to the variables table after the `LOG_LEVEL` row:

```mdx
| `ADMIN_PORT` | `4560` | Loopback-only admin page; `0` disables. |
| `LOG_MAX_BYTES` | `5000000` | Rotate a log file after this many bytes. |
| `LOG_MAX_FILES` | `3` | Rotated log copies kept (`.1`…`.N`). |
| `BACKUP_INTERVAL_HOURS` | `24` | SQLite backup cadence; `0` disables. |
| `BACKUP_KEEP` | `7` | Backup files kept before pruning. |
```

Then append after the `DATA_DIR` section:

```mdx
## Admin page, backups, and log rotation

`ADMIN_PORT` starts a loopback-only HTTP status page and JSON API on
`127.0.0.1`. It has no authentication; reach it locally or through an SSH
tunnel, never through a public interface.

Backups run every `BACKUP_INTERVAL_HOURS` hours into `DATA_DIR/backups` and keep
`BACKUP_KEEP` files. Logs rotate at `LOG_MAX_BYTES` and keep `LOG_MAX_FILES`
numbered copies.
```

- [ ] **Step 5: Document the commands**

In `docs-site/reference/commands.mdx`, add this section after the Sessions table:

```mdx
## Scheduled tasks

| Command | Access | Behavior |
| --- | --- | --- |
| `/task add channel:<#channel> prompt:<text> every_minutes:<n>` | owner | Schedule a recurring prompt in a project channel (minimum 1 minute). |
| `/task list` | authorized | List scheduled tasks with their next run. |
| `/task remove id:<n>` | owner | Remove a scheduled task by id. |
```

In the same file, change the deferred list sentence from `OAuth subscription login, and Linux/macOS deployment docs.` to `OAuth subscription login.`

In `README.md`, add these rows to the commands table after the `/agent` row:

```markdown
| `/task add <channel> <prompt> <every_minutes>` | guild (owner) | Schedule a recurring prompt in a project channel. |
| `/task list` | guild | List scheduled tasks. |
| `/task remove <id>` | guild (owner) | Remove a scheduled task. |
```

In the same file, change the Scale/deploy roadmap bullet from `multi-guild, cloud sandboxes, \`--clone\` sandbox mode, OAuth subscription login, Linux/macOS deployment docs.` to `multi-guild, cloud sandboxes, \`--clone\` sandbox mode, and OAuth subscription login.` (Linux deployment is now documented; macOS still is not).

- [ ] **Step 6: Document the security posture**

In `docs-site/reference/security.mdx`, append this section after the "Loopback and password" section:

```mdx
## Admin and backup surfaces

- The admin page binds `127.0.0.1:ADMIN_PORT` only and has no authentication. It
  must never be exposed through a tunnel or port-forward.
- It exposes project names/status, start/stop actions, and redacted log tails.
  Log redaction reuses the same `redact` path as `bot.log`.
- Backups are written under `DATA_DIR/backups` (`VACUUM INTO` output) and stay
  in the host trust domain, alongside `bot.db`.
```

- [ ] **Step 7: Update `.env.example`**

In `.env.example`, add after the storage/logging block:

```
# # Ops: loopback admin page, log rotation, and SQLite backups.
# ADMIN_PORT=4560
# LOG_MAX_BYTES=5000000
# LOG_MAX_FILES=3
# BACKUP_INTERVAL_HOURS=24
# BACKUP_KEEP=7
```

- [ ] **Step 8: Add the changeset**

Create `.changeset/admin-and-ops.md`:

```markdown
---
"celly": minor
---

Add the loopback admin page (`ADMIN_PORT`), size-based log rotation
(`LOG_MAX_BYTES`/`LOG_MAX_FILES`), scheduled SQLite backups
(`BACKUP_INTERVAL_HOURS`/`BACKUP_KEEP`), and recurring `/task` prompts.
```

- [ ] **Step 9: Validate docs and run the full gate**

Run: `npm run docs:validate`
Expected: PASS (no schema or MDX errors).

Run: `npm run docs:links`
Expected: PASS (no broken internal links).

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

If the Mintlify CLI cannot download because the sandbox has no network, report that the docs commands were skipped and why; do not claim they passed.

- [ ] **Step 10: Commit**

```bash
git add docs-site/guides/deployment-linux.mdx docs-site/docs.json docs-site/guides/deployment.mdx docs-site/guides/configuration.mdx docs-site/reference/commands.mdx docs-site/reference/security.mdx .env.example README.md .changeset/admin-and-ops.md
git commit -m "docs(admin): document admin, backups, rotation, and /task"
```

---

## Self-Review

**Spec coverage (spec §4.3):**
- Admin page routes and loopback bind: Task 7 (`GET /`, `/api/projects`, `/api/health`, `POST start|stop`, `/api/logs` redacted, `/api/audit` gated on `auditTail`, JSON `{ error }`).
- Log rotation helper and integration: Tasks 1 and 2 (logger and project server logs, config vars, throttle).
- DB backup: Task 3 (`VACUUM INTO`, quote escaping, prune, config vars).
- Scheduled tasks: Tasks 4-6 (append-only migration, `db.tasks` CRUD, runner, `/task` commands with owner-only add/remove).
- Deploy docs: Task 9 (`deployment-linux.mdx`, nav, Windows backup section, configuration, `.env.example`, commands, security, changeset).
- Acceptance: real-HTTP tests (Task 7), temp-file rotation tests (Tasks 1-2), backup opens as SQLite (Task 3), fake-clock task tests (Task 5), docs validate + broken-links (Task 9).

**Placeholder scan:** no "TBD", "TODO", "add error handling", or "similar to Task N"; every code step contains runnable code. Run commands include exact filters and expected outcomes.

**Identifier consistency:** `rotateIfNeeded`, `RotateOptions`, `createBackupScheduler`, `BackupSchedulerDeps`, `db.backupTo`, `db.tasks`, `ScheduledTask`, `createTaskRunner`, `TaskRunnerDeps`, `createAdminServer`, `AdminDeps`, `AdminServer`, `ADMIN_HOST`, `tailLines`, `logMaxBytes`, `logMaxFiles`, `backupIntervalHours`, `backupKeep`, `adminPort` are each defined once and used with the same names and types in later tasks.

**Known spec latitude (documented, not placeholders):** `createAdminServer` returns `{ port, address, close }` (a superset of the spec's `{ close(): void }`) so port-0 tests can reach the server and assert the loopback bind. `createTaskRunner` adds `ensureThread` to the spec's deps because the spec requires the injected `ensureThread(channelId)` behavior.
