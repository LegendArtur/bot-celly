# Smart Thread Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give managed Discord threads a live status prefix and a short title that the session agent authors once, in-band, then locks.

**Architecture:** A new pure module `src/thread-name.ts` holds name composition, marker parsing/stripping, and a `ThreadNamer` that coalesces and throttles renames. The runner emits status transitions and marker-stripped text; `src/index.ts` wires the namer to the Discord channel and DB. Status is persisted in three new `threads` columns.

**Tech Stack:** TypeScript, Node 24, vitest, discord.js, node:sqlite.

**Spec:** `docs/superpowers/specs/2026-10-01-smart-thread-names-design.md`

## Global Constraints

- **argv-only.** Never pass user input through a host shell; only `src/sbx.ts` may import `child_process`.
- **Containment.** All path checks go through the shared helper.
- **Policy.** Never weaken the bot-enforced permission policy or re-assert-after-wake.
- **Tests.** The vitest suite is the contract; add/update tests for every behavior change.
- Discord thread names are capped at **100 characters**; the agent title at **10 words / 80 characters**.
- Marker line is exactly `:::celly-name <title>`.
- Status prefixes: `🟢 working`, `⛔ blocked`, `⏸️ idle`, `❌ error`, `⏹️ stopping`.
- `SMART_THREAD_NAMES` boolean env, default `true`.
- Docs + changeset are part of the change (`AGENTS.md`). Run `npm test`, `npm run typecheck`, `npm run build`.
- Follow repo conventions: ESM imports from `../src/x.ts` in tests, `.js` extensions in `src` relative imports, no code comments unless behavior is non-obvious.

---

### Task 1: Pure naming utilities

**Files:**
- Create: `src/thread-name.ts`
- Test: `test/thread-name.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ThreadStatus = "working" | "blocked" | "idle" | "error" | "stopping"`
  - `statusPrefix(status: ThreadStatus): string`
  - `composeThreadName(status: ThreadStatus, title: string | null): string`
  - `normalizeTitle(raw: string): string | null`
  - `parseNameMarker(text: string): string | null`
  - `stripNameMarker(text: string): string`
  - constants `TITLE_MAX_WORDS = 10`, `TITLE_MAX_CHARS = 80`, `THREAD_NAME_MAX_CHARS = 100`, `THREAD_NAME_MARKER = ":::celly-name"`

- [ ] **Step 1: Write the failing test**

```ts
// test/thread-name.test.ts
import { expect, test } from "vitest"
import {
  composeThreadName, normalizeTitle, parseNameMarker, statusPrefix, stripNameMarker,
} from "../src/thread-name.ts"

test("statusPrefix maps every status to an emoji + label", () => {
  expect(statusPrefix("working")).toBe("🟢 working")
  expect(statusPrefix("blocked")).toBe("⛔ blocked")
  expect(statusPrefix("idle")).toBe("⏸️ idle")
  expect(statusPrefix("error")).toBe("❌ error")
  expect(statusPrefix("stopping")).toBe("⏹️ stopping")
})

test("composeThreadName joins prefix and title, and tolerates a missing title", () => {
  expect(composeThreadName("working", "Fix auth redirect loop")).toBe("🟢 working · Fix auth redirect loop")
  expect(composeThreadName("idle", null)).toBe("⏸️ idle")
  expect(composeThreadName("idle", "   ")).toBe("⏸️ idle")
})

test("composeThreadName never exceeds Discord's 100 character limit", () => {
  const name = composeThreadName("working", "x".repeat(200))
  expect(name.length).toBeLessThanOrEqual(100)
})

test("normalizeTitle strips wrapping quotes/markdown, trailing punctuation, caps words", () => {
  expect(normalizeTitle('  "Fix the auth redirect loop"  ')).toBe("Fix the auth redirect loop")
  expect(normalizeTitle("`Ship smart thread names`")).toBe("Ship smart thread names")
  expect(normalizeTitle("Fix login.")).toBe("Fix login")
  expect(normalizeTitle("one two three four five six seven eight nine ten eleven"))
    .toBe("one two three four five six seven eight nine ten")
  expect(normalizeTitle("")).toBeNull()
  expect(normalizeTitle("   ")).toBeNull()
})

test("parseNameMarker extracts the first marker line only when complete", () => {
  expect(parseNameMarker("hello\n:::celly-name Fix auth redirect loop\nmore")).toBe("Fix auth redirect loop")
  expect(parseNameMarker(":::celly-name Fix auth redirect loop")).toBe("Fix auth redirect loop")
  expect(parseNameMarker("no marker here")).toBeNull()
})

test("stripNameMarker removes marker lines including a trailing partial one", () => {
  expect(stripNameMarker("hello\n:::celly-name Fix auth\nworld")).toBe("hello\nworld")
  expect(stripNameMarker("hello\n:::celly-name Fix auth")).toBe("hello\n")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/thread-name.test.ts`
Expected: FAIL (cannot resolve `../src/thread-name.ts`).

- [ ] **Step 3: Write the implementation**

```ts
// src/thread-name.ts
export type ThreadStatus = "working" | "blocked" | "idle" | "error" | "stopping"

export const TITLE_MAX_WORDS = 10
export const TITLE_MAX_CHARS = 80
export const THREAD_NAME_MAX_CHARS = 100
export const THREAD_NAME_MARKER = ":::celly-name"

const STATUS_PREFIX: Record<ThreadStatus, string> = {
  working: "🟢 working",
  blocked: "⛔ blocked",
  idle: "⏸️ idle",
  error: "❌ error",
  stopping: "⏹️ stopping",
}

export function statusPrefix(status: ThreadStatus): string {
  return STATUS_PREFIX[status]
}

export function normalizeTitle(raw: string): string | null {
  let text = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  text = text.replace(/^[`"'*_~]+/, "").replace(/[`"'*_~]+$/, "").trim()
  text = text.replace(/[.,;:!?。，、！？]+$/, "").trim()
  if (!text) return null
  let words = text.split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS)
  text = words.join(" ")
  if (text.length > TITLE_MAX_CHARS) text = text.slice(0, TITLE_MAX_CHARS).trimEnd()
  words = text.split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS)
  return words.join(" ") || null
}

export function composeThreadName(status: ThreadStatus, title: string | null): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim()
  const prefix = statusPrefix(status)
  const combined = clean ? `${prefix} · ${clean}` : prefix
  return combined.slice(0, THREAD_NAME_MAX_CHARS)
}

const MARKER_LINE = /^[ \t]*:::celly-name[ \t]+(.+?)[ \t]*$/m
const MARKER_LINE_REMOVE = /^[ \t]*:::celly-name[^\n]*(?:\n|$)/gm

export function parseNameMarker(text: string): string | null {
  const match = MARKER_LINE.exec(text ?? "")
  if (!match) return null
  return normalizeTitle(match[1] ?? "")
}

export function stripNameMarker(text: string): string {
  return (text ?? "").replace(MARKER_LINE_REMOVE, "")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/thread-name.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/thread-name.ts test/thread-name.test.ts
git commit -m "feat(thread-name): add name composition and marker utilities"
```

---

### Task 2: Persist name state in the database

**Files:**
- Modify: `src/types.ts` (Thread interface)
- Modify: `src/db.ts` (migration v10, rowToThread, upsert, Db.threads methods)
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Thread` gains `nameLocked: boolean; nameManual: boolean; lastThreadName: string | null`; `Db.threads` gains:
  - `setTitle(threadId: string, title: string | null): void`
  - `setNameLocked(threadId: string, locked: boolean): void`
  - `setNameManual(threadId: string, manual: boolean): void`
  - `setLastThreadName(threadId: string, name: string | null): void`

- [ ] **Step 1: Write the failing test**

Add to `test/db.test.ts`:

```ts
test("threads persist smart-name state across upsert and get", () => {
  const db = openDb(":memory:")
  db.migrate()
  db.projects.insertProvisioning({
    channelId: "c1", guildId: "g1", name: "p1", directory: "/tmp/p1",
    sandboxPath: null, sandboxName: "s1", hostPort: 4300, serverPassword: "x", createdAt: 1,
  })
  db.threads.upsert({
    threadId: "t1", channelId: "c1", sessionId: "sess1", title: "seed",
    model: null, agent: null, variant: null, worktreePath: null, liveMessageId: null,
    originMessageId: null, archiveNoticeAt: null, renderState: "idle",
    nameLocked: false, nameManual: false, lastThreadName: null, createdAt: 1, lastActiveAt: 1,
  })
  db.threads.setTitle("t1", "Fix auth redirect loop")
  db.threads.setNameLocked("t1", true)
  db.threads.setLastThreadName("t1", "🟢 working · Fix auth redirect loop")
  db.threads.setNameManual("t1", true)
  const t = db.threads.get("t1")!
  expect(t.title).toBe("Fix auth redirect loop")
  expect(t.nameLocked).toBe(true)
  expect(t.nameManual).toBe(true)
  expect(t.lastThreadName).toBe("🟢 working · Fix auth redirect loop")
  db.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL (missing properties / methods).

- [ ] **Step 3: Implement**

In `src/types.ts`, add to `Thread` (after `renderState`):

```ts
  nameLocked: boolean; nameManual: boolean; lastThreadName: string | null
```

In `src/db.ts`:

Add migration:

```ts
  { version: 10, up: (raw) => raw.exec(`
    ALTER TABLE threads ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads ADD COLUMN name_manual INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads ADD COLUMN last_thread_name TEXT;
  `) },
```

Extend the `Db.threads` interface:

```ts
    setTitle(threadId: string, title: string | null): void
    setNameLocked(threadId: string, locked: boolean): void
    setNameManual(threadId: string, manual: boolean): void
    setLastThreadName(threadId: string, name: string | null): void
```

Extend `rowToThread`:

```ts
  nameLocked: Number(r.name_locked ?? 0) === 1,
  nameManual: Number(r.name_manual ?? 0) === 1,
  lastThreadName: r.last_thread_name ?? null,
```

Extend `upsert` to insert and conflict-update the three columns:

```ts
      upsert(t) {
        raw.prepare(`INSERT INTO threads (thread_id,channel_id,session_id,title,model,agent,variant,worktree_path,live_message_id,origin_message_id,render_state,name_locked,name_manual,last_thread_name,created_at,last_active_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET session_id=excluded.session_id, title=excluded.title, model=excluded.model, agent=excluded.agent, variant=excluded.variant, origin_message_id=excluded.origin_message_id, name_locked=excluded.name_locked, name_manual=excluded.name_manual, last_thread_name=excluded.last_thread_name, last_active_at=excluded.last_active_at`)
          .run(t.threadId,t.channelId,t.sessionId,t.title,t.model,t.agent,t.variant,t.worktreePath,t.liveMessageId,t.originMessageId ?? null,t.renderState,t.nameLocked ? 1 : 0,t.nameManual ? 1 : 0,t.lastThreadName,t.createdAt,t.lastActiveAt)
      },
```

Add the setters near `setModel`:

```ts
      setTitle(threadId, title) { raw.prepare(`UPDATE threads SET title=? WHERE thread_id=?`).run(title, threadId) },
      setNameLocked(threadId, locked) { raw.prepare(`UPDATE threads SET name_locked=? WHERE thread_id=?`).run(locked ? 1 : 0, threadId) },
      setNameManual(threadId, manual) { raw.prepare(`UPDATE threads SET name_manual=? WHERE thread_id=?`).run(manual ? 1 : 0, threadId) },
      setLastThreadName(threadId, name) { raw.prepare(`UPDATE threads SET last_thread_name=? WHERE thread_id=?`).run(name, threadId) },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Find and fix every other place that constructs a `Thread`**

Run: `npm run typecheck`
Any existing `Thread` object literal missing the new fields will fail to compile (e.g. `src/index.ts:239`, `src/handlers.ts:277`). Add `nameLocked: false, nameManual: false, lastThreadName: null` to each.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add src/types.ts src/db.ts src/index.ts src/handlers.ts test/db.test.ts
git commit -m "feat(db): persist thread smart-name state"
```

---

### Task 3: Add the SMART_THREAD_NAMES config flag

**Files:**
- Modify: `src/config.ts` (Config interface + loadConfig)
- Modify: `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config.smartThreadNames: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.ts` (follow the existing helper that builds a valid env in that file):

```ts
test("SMART_THREAD_NAMES defaults to true and parses booleans", () => {
  expect(loadConfig({ ...baseEnv() }).smartThreadNames).toBe(true)
  expect(loadConfig({ ...baseEnv(), SMART_THREAD_NAMES: "false" }).smartThreadNames).toBe(false)
  expect(loadConfig({ ...baseEnv(), SMART_THREAD_NAMES: "1" }).smartThreadNames).toBe(true)
})
```

Use whatever valid-env helper already exists in `test/config.test.ts`; if none, inline `DISCORD_TOKEN` and `DISCORD_GUILD_ID`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (`smartThreadNames` undefined).

- [ ] **Step 3: Implement**

In `src/config.ts` `Config`, add near `attachAutoThread`:

```ts
  attachAutoThread: boolean
  smartThreadNames: boolean
```

In the returned object:

```ts
    attachAutoThread: bool(env, "ATTACH_AUTO_THREAD", false),
    smartThreadNames: bool(env, "SMART_THREAD_NAMES", true),
```

In `.env.example`, add an entry near `ATTACH_AUTO_THREAD`:

```
# Live status emoji + agent-authored thread names (default: true)
SMART_THREAD_NAMES=true
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/config.test.ts && npm run typecheck
git add src/config.ts .env.example test/config.test.ts
git commit -m "feat(config): add SMART_THREAD_NAMES flag"
```

---

### Task 4: `ThreadNamer` (coalescing, throttling, one-shot lock)

**Files:**
- Modify: `src/thread-name.ts` (append class)
- Test: `test/thread-name.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 exports (`ThreadStatus`, `composeThreadName`, `parseNameMarker`).
- Produces:
  - `interface ThreadNamerDeps { enabled(): boolean; rename(threadId: string, name: string): Promise<void>; getTitle(threadId: string): string | null; isLocked(threadId: string): boolean; setLockedTitle(threadId: string, title: string): void; now(): number; log(msg: string, fields?: Record<string, unknown>): void; settleMs?: number; bucketCapacity?: number; refillMs?: number }`
  - `class ThreadNamer` with `setStatus(threadId, status)`, `noteFinalText(threadId, text)`, `onManualRename(threadId)`, `cancel(threadId)`
  - constants `NAMER_SETTLE_MS = 20_000`, `NAMER_BUCKET_CAPACITY = 2`, `NAMER_REFILL_MS = 300_000`

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/thread-name.test.ts
import { vi } from "vitest"
import { ThreadNamer } from "../src/thread-name.ts"

function namerDeps(overrides: Partial<ConstructorParameters<typeof ThreadNamer>[0]> = {}) {
  const titles: Record<string, string | null> = {}
  const locked = new Set<string>()
  const renames: { threadId: string; name: string }[] = []
  return {
    renames, titles, locked,
    deps: {
      enabled: () => true,
      rename: async (threadId: string, name: string) => { renames.push({ threadId, name }) },
      getTitle: (threadId: string) => titles[threadId] ?? "seed",
      isLocked: (threadId: string) => locked.has(threadId),
      setLockedTitle: (threadId: string, title: string) => { titles[threadId] = title; locked.add(threadId) },
      now: () => Date.now(),
      log: () => {},
      settleMs: 20,
      bucketCapacity: 2,
      refillMs: 300,
      ...overrides,
    },
  }
}

test("namer coalesces bursts and applies the last state after settle", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "working")
    namer.setStatus("t1", "blocked")
    namer.setStatus("t1", "idle")
    await vi.advanceTimersByTimeAsync(25)
    expect(renames).toEqual([{ threadId: "t1", name: "⏸️ idle · seed" }])
  } finally { vi.useRealTimers() }
})

test("namer locks the title on the first marker and ignores later ones", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames, titles } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.noteFinalText("t1", "intro\n:::celly-name Fix auth redirect loop\n")
    namer.noteFinalText("t1", "again\n:::celly-name Something else entirely\n")
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(25)
    expect(titles.t1).toBe("Fix auth redirect loop")
    expect(renames.at(-1)).toEqual({ threadId: "t1", name: "🟢 working · Fix auth redirect loop" })
  } finally { vi.useRealTimers() }
})

test("namer throttles to the token bucket and eventually applies", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames } = namerDeps({ settleMs: 5, refillMs: 100 })
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(10)   // token 1
    namer.setStatus("t1", "blocked")
    await vi.advanceTimersByTimeAsync(10)   // token 2
    namer.setStatus("t1", "idle")
    await vi.advanceTimersByTimeAsync(10)   // no token yet
    expect(renames).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(150)  // refill
    expect(renames).toHaveLength(3)
  } finally { vi.useRealTimers() }
})

test("namer keeps the desired state when a rename fails, and retries", async () => {
  vi.useFakeTimers()
  try {
    let fail = true
    const { deps } = namerDeps({
      settleMs: 5, refillMs: 50,
      rename: async () => { if (fail) throw Object.assign(new Error("rate limited"), { retryAfter: 1 }) },
    })
    const calls = { n: 0 }
    deps.rename = async () => { calls.n++; if (fail) throw new Error("boom") }
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(10)
    expect(calls.n).toBe(1)
    fail = false
    await vi.advanceTimersByTimeAsync(100)
    expect(calls.n).toBeGreaterThan(1)
  } finally { vi.useRealTimers() }
})

test("namer stops after a manual rename and when disabled", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.onManualRename("t1")
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(25)
    expect(renames).toHaveLength(0)

    const off = namerDeps({ enabled: () => false })
    const namer2 = new ThreadNamer(off.deps)
    namer2.setStatus("t2", "working")
    await vi.advanceTimersByTimeAsync(25)
    expect(off.renames).toHaveLength(0)
  } finally { vi.useRealTimers() }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/thread-name.test.ts`
Expected: FAIL (`ThreadNamer` not exported).

- [ ] **Step 3: Implement (append to `src/thread-name.ts`)**

```ts
import { unrefTimer } from "./helpers.js"

export const NAMER_SETTLE_MS = 20_000
export const NAMER_BUCKET_CAPACITY = 2
export const NAMER_REFILL_MS = 300_000

export interface ThreadNamerDeps {
  enabled(): boolean
  rename(threadId: string, name: string): Promise<void>
  getTitle(threadId: string): string | null
  isLocked(threadId: string): boolean
  setLockedTitle(threadId: string, title: string): void
  now(): number
  log(msg: string, fields?: Record<string, unknown>): void
  settleMs?: number
  bucketCapacity?: number
  refillMs?: number
}

interface NamerState {
  status: ThreadStatus
  title: string | null
  manual: boolean
  last?: string
  tokens: number
  lastRefill: number
  blockedUntil: number
  timer?: ReturnType<typeof setTimeout>
}

export class ThreadNamer {
  private states = new Map<string, NamerState>()
  private readonly settleMs: number
  private readonly capacity: number
  private readonly refillMs: number
  constructor(private readonly deps: ThreadNamerDeps) {
    this.settleMs = deps.settleMs ?? NAMER_SETTLE_MS
    this.capacity = deps.bucketCapacity ?? NAMER_BUCKET_CAPACITY
    this.refillMs = deps.refillMs ?? NAMER_REFILL_MS
  }
  private state(threadId: string): NamerState {
    let state = this.states.get(threadId)
    if (!state) {
      state = {
        status: "idle", title: this.deps.getTitle(threadId), manual: false,
        tokens: this.capacity, lastRefill: this.deps.now(), blockedUntil: 0,
      }
      this.states.set(threadId, state)
    }
    return state
  }
  private clearTimer(threadId: string): void {
    const state = this.states.get(threadId)
    if (state?.timer !== undefined) { clearTimeout(state.timer); state.timer = undefined }
  }
  private schedule(threadId: string): void {
    const state = this.states.get(threadId)
    if (!state || state.timer !== undefined) return
    state.timer = setTimeout(() => { state.timer = undefined; void this.flush(threadId) }, this.settleMs)
    unrefTimer(state.timer)
  }
  setStatus(threadId: string, status: ThreadStatus): void {
    if (!this.deps.enabled()) return
    const state = this.state(threadId)
    if (state.manual) return
    state.status = status
    this.schedule(threadId)
  }
  noteFinalText(threadId: string, text: string): void {
    if (!this.deps.enabled() || this.deps.isLocked(threadId)) return
    const title = parseNameMarker(text)
    if (!title) return
    const state = this.state(threadId)
    state.title = title
    this.deps.setLockedTitle(threadId, title)
    this.schedule(threadId)
  }
  onManualRename(threadId: string): void {
    const state = this.state(threadId)
    state.manual = true
    this.clearTimer(threadId)
  }
  cancel(threadId: string): void {
    this.clearTimer(threadId)
    this.states.delete(threadId)
  }
  private async flush(threadId: string): Promise<void> {
    const state = this.states.get(threadId)
    if (!state || state.manual || !this.deps.enabled()) return
    const now = this.deps.now()
    if (now < state.blockedUntil) { this.schedule(threadId); return }
    const elapsed = now - state.lastRefill
    if (elapsed >= this.refillMs) {
      const gained = Math.floor(elapsed / this.refillMs)
      state.tokens = Math.min(this.capacity, state.tokens + gained)
      state.lastRefill += gained * this.refillMs
    }
    const name = composeThreadName(state.status, state.title)
    if (name === state.last) return
    if (state.tokens < 1) { this.schedule(threadId); return }
    state.tokens -= 1
    try {
      await this.deps.rename(threadId, name)
      state.last = name
    } catch (err) {
      this.deps.log("thread rename failed", { threadId, error: String(err) })
      state.blockedUntil = this.deps.now() + this.refillMs
      this.schedule(threadId)
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/thread-name.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/thread-name.ts test/thread-name.test.ts
git commit -m "feat(thread-name): add coalescing ThreadNamer with lock and throttle"
```

---

### Task 5: Inject the naming instruction into sandboxes

**Files:**
- Modify: `src/opencode.ts` (`cellyGlobalInstructions`, `buildBootstrapInstallScript`, `BOOTSTRAP_VERIFY`)
- Test: `test/opencode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `cellyGlobalInstructions(): string`; bootstrap script writes `$HOME/.config/opencode/AGENTS.md` containing it.

- [ ] **Step 1: Write the failing test**

Add to `test/opencode.test.ts`:

```ts
test("bootstrap installs the global AGENTS.md naming instruction", () => {
  const script = buildBootstrapInstallScript("pw")
  expect(script).toContain('"$HOME/.config/opencode/AGENTS.md"')
  expect(script).toContain(":::celly-name")
  expect(buildOpencodeEnv("pw")).not.toContain(":::celly-name")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/opencode.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `src/opencode.ts`:

```ts
export function cellyGlobalInstructions(): string {
  return [
    "# Celly session naming",
    "",
    "Celly shows this session's topic as the Discord thread name.",
    "",
    "Once you understand what this session is about — for example after gathering",
    "requirements or writing a spec — set the name exactly once by emitting one",
    "line on its own:",
    "",
    ":::celly-name <title>",
    "",
    "Rules: at most 10 words; no surrounding quotes and no trailing punctuation;",
    "describe the task, not your reply; emit it only once per session; never",
    "mention the line in your answer (it is removed before the user sees it).",
  ].join("\n") + "\n"
}
```

In `buildBootstrapInstallScript`, add a third heredoc before the final `].join`:

```ts
    `mkdir -p "$HOME/.config/opencode"`,
    `cat > "$HOME/.config/opencode/AGENTS.md" <<'CELLY_AGENTS'`,
    cellyGlobalInstructions().replace(/\n$/, ""),
    "CELLY_AGENTS",
```

In `BOOTSTRAP_VERIFY`, append a check:

```ts
export const BOOTSTRAP_VERIFY = `test -s ${CELLY_CONFIG_PATH} && test -s ${CELLY_ENV_PATH} && test -s "$HOME/.config/opencode/AGENTS.md" && grep -q '"permission"' ${CELLY_CONFIG_PATH} && grep -q 'OPENCODE_SERVER_PASSWORD=' ${CELLY_ENV_PATH} && grep -q 'celly-name' "$HOME/.config/opencode/AGENTS.md"`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/opencode.test.ts test/bootstrap.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode.ts test/opencode.test.ts
git commit -m "feat(opencode): install global naming instruction in sandboxes"
```

---

### Task 6: Runner emits status, strips markers, hands over final text

**Files:**
- Modify: `src/render.ts` (`Renderer.plainText`)
- Modify: `src/runner.ts` (`RunnerDeps`, status emissions, marker strip, final text)
- Test: `test/runner.test.ts`, `test/render.test.ts`

**Interfaces:**
- Consumes: Task 1 (`stripNameMarker`, `ThreadStatus`).
- Produces:
  - `Renderer.plainText(): string`
  - `RunnerDeps.onThreadState?(threadId: string, status: ThreadStatus): void`
  - `RunnerDeps.onFinalText?(threadId: string, text: string): void`

- [ ] **Step 1: Write the failing tests**

Add to `test/render.test.ts`:

```ts
test("plainText joins text segments and drops tool/notice segments", () => {
  const r = new Renderer({ send: async () => "m1", edit: async () => {}, now: () => 0, intervalMs: 1 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p1", text: "hello" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p2", name: "bash", status: "running" })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p3", text: "world" })
  expect(r.plainText()).toBe("hello\n\nworld")
})
```

Add to `test/runner.test.ts` (follow that file's existing fake `RunnerDeps` builder):

```ts
test("runner strips name markers, emits status, and reports final text", async () => {
  const statuses: string[] = []
  const finals: string[] = []
  const pushed: string[] = []
  const deps = makeDeps()   // existing helper in test/runner.test.ts
  deps.onThreadState = (_id, s) => statuses.push(s)
  deps.onFinalText = (_id, text) => finals.push(text)
  deps.createRenderer = async () => ({
    push: (e: any) => { if (e.kind === "text") pushed.push(e.text) },
    tick: async () => {}, flush: async () => {}, finalize: async () => {},
    upsertQuestion: async () => {}, setFooter: () => {}, elapsedMs: () => 0,
    plainText: () => "done\n:::celly-name Fix auth redirect loop\n",
  } as any)
  const runner = new Runner(deps)
  await runner.onEvent("t1", { kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "done\n:::celly-name Fix auth redirect loop\n" })
  await runner.onEvent("t1", { kind: "idle", sessionId: "s" })
  expect(pushed[0]).toBe("done\n")
  expect(statuses).toContain("working")
  expect(statuses).toContain("idle")
  expect(finals[0]).toContain("Fix auth redirect loop")
})
```

If the existing helper is named differently, adapt the call; keep the assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/render.test.ts test/runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/render.ts`, add to `Renderer`:

```ts
  plainText(): string {
    return this.segments.filter((segment) => segment.kind === "text").map((segment) => segment.text).join("\n\n")
  }
```

In `src/runner.ts`:

Add the import:

```ts
import { stripNameMarker } from "./thread-name.js"
import type { ThreadStatus } from "./thread-name.ts"
```

Extend `RunnerDeps`:

```ts
  onThreadState?(threadId: string, status: ThreadStatus): void
  onFinalText?(threadId: string, text: string): void
```

Emit statuses:

- In `prompt`, right after `db.threads.setRenderState(threadId, "running"); db.threads.touch(threadId)`, add:
  ```ts
  this.deps.onThreadState?.(threadId, "working")
  ```
- In `idle`, right after `this.deps.db.threads.setRenderState(threadId, "idle")`, add:
  ```ts
  this.deps.onThreadState?.(threadId, "idle")
  ```
- In `abort`, right after `this.deps.db.threads.setRenderState(threadId, "aborting")`, add:
  ```ts
  this.deps.onThreadState?.(threadId, "stopping")
  ```

In `onEvent`, replace the first branch to strip markers:

```ts
    if (e.kind === "text" || e.kind === "tool") {
      const event = e.kind === "text" ? { ...e, text: stripNameMarker(e.text) } : e
      const r = await this.rendererFor(threadId)
      r.push(event)
      await r.tick()
    }
```

In the `permission` branch, when the decision is `ask`:

```ts
      if (decision === "ask") {
        this.deps.onThreadState?.(threadId, "blocked")
        if (this.deps.approvals) { ...existing... } else { ...existing... }
      }
```

In the `permission-replied` and `question-replied` branches, add `this.deps.onThreadState?.(threadId, "working")`. In the `question` branch, add `this.deps.onThreadState?.(threadId, "blocked")` before `askQuestion`.

In the `idle` branch, report final text before finalizing:

```ts
    } else if (e.kind === "idle") {
      try {
        const r = await this.rendererFor(threadId)
        this.deps.onFinalText?.(threadId, r.plainText())
        await r.finalize()
      } catch (err) { ... }
```

In the `error` branch, add `this.deps.onThreadState?.(threadId, "error")` before finalizing.

In `recover`, strip text parts before pushing:

```ts
        const ev = partToEvent(thread.sessionId, messageId, part)
        if (ev) renderer.push(ev.kind === "text" ? { ...ev, text: stripNameMarker(ev.text) } : ev)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/render.test.ts test/runner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/runner.ts test/render.test.ts test/runner.test.ts
git commit -m "feat(runner): emit thread status and strip name markers"
```

---

### Task 7: Wire the namer into the bot

**Files:**
- Modify: `src/index.ts` (construct `ThreadNamer`, pass runner hooks, manual rename detection)
- Test: `test/wiring.test.ts` (or a focused new test if wiring is not already covered)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: a live namer; renamed threads via `ThreadChannel.setName`; manual detection on `Events.ThreadUpdate`.

- [ ] **Step 1: Write the failing test**

If `test/wiring.test.ts` already exercises runner deps, add an assertion that `onThreadState` and `onFinalText` are provided and that the rename callback sets the DB last name before calling `setName`. Otherwise add a focused unit test for a small exported helper. Concretely, extract the manual-detection decision into `src/thread-name.ts`:

```ts
export function isManualRename(input: {
  oldName: string | null | undefined
  newName: string | null | undefined
  archived: boolean
  known: boolean
  manual: boolean
  lastThreadName: string | null
}): boolean {
  if (!input.known || input.archived || input.manual) return false
  if (!input.newName || input.newName === input.oldName) return false
  return input.newName !== input.lastThreadName
}
```

Test in `test/thread-name.test.ts`:

```ts
test("isManualRename ignores our own writes, archived threads, and unknown threads", () => {
  const base = { oldName: "a", newName: "b", archived: false, known: true, manual: false, lastThreadName: "a" }
  expect(isManualRename(base)).toBe(true)
  expect(isManualRename({ ...base, newName: "a" })).toBe(false)
  expect(isManualRename({ ...base, newName: "b", lastThreadName: "b" })).toBe(false)
  expect(isManualRename({ ...base, archived: true })).toBe(false)
  expect(isManualRename({ ...base, known: false })).toBe(false)
  expect(isManualRename({ ...base, manual: true })).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/thread-name.test.ts`
Expected: FAIL (`isManualRename` not exported).

- [ ] **Step 3: Implement `isManualRename` in `src/thread-name.ts`** (code above).

- [ ] **Step 4: Wire `src/index.ts`**

After `runnerSvc` and `threadBucket` exist (the namer's rename uses `client` and `scheduleWithBucket`), add:

```ts
  const threadNamer = new ThreadNamer({
    enabled: () => cfg.smartThreadNames,
    rename: async (threadId, name) => {
      const thread = db.threads.get(threadId)
      if (!thread || thread.nameManual) return
      db.threads.setLastThreadName(threadId, name)
      const channel = await client.channels.fetch(threadId)
      if (channel && typeof (channel as any).setName === "function") {
        await scheduleWithBucket(threadBucket(threadId), () => (channel as any).setName(name))
      }
    },
    getTitle: (threadId) => db.threads.get(threadId)?.title ?? null,
    isLocked: (threadId) => db.threads.get(threadId)?.nameLocked ?? false,
    setLockedTitle: (threadId, title) => { db.threads.setTitle(threadId, title); db.threads.setNameLocked(threadId, true) },
    now: () => Date.now(),
    log: (message, fields) => log.warn(message, fields),
  })
```

Add to the `new Runner({...})` deps:

```ts
    onThreadState: (threadId, status) => threadNamer.setStatus(threadId, status),
    onFinalText: (threadId, text) => threadNamer.noteFinalText(threadId, text),
```

In the `Events.ThreadUpdate` callback, before the archive handler, detect manual renames:

```ts
  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    const thread = newThread?.id ? db.threads.get(newThread.id) : undefined
    if (isManualRename({
      oldName: oldThread?.name, newName: newThread?.name, archived: !!newThread?.archived,
      known: !!thread, manual: thread?.nameManual ?? false, lastThreadName: thread?.lastThreadName ?? null,
    })) {
      db.threads.setNameManual(newThread.id, true)
      threadNamer.onManualRename(newThread.id)
    }
    void onThreadUpdate(oldThread, newThread)
  })
```

Import `ThreadNamer`, `isManualRename` from `./thread-name.js`.

Add a guard at construction order: `threadNamer` must be defined before the `client.on(Events.ThreadUpdate, ...)` registration, which is at the bottom; place the namer right after `threadBucket`/`approvals` so both are in scope.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. Fix any wiring fallout.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/thread-name.ts test/thread-name.test.ts
git commit -m "feat: wire smart thread naming into the bot"
```

---

### Task 8: Documentation and changeset

**Files:**
- Modify: `docs-site/guides/configuration.mdx`
- Modify: `docs-site/reference/limitations.mdx`
- Modify: `docs-site/reference/architecture.mdx`
- Modify: `README.md`
- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Document the env var**

Add `SMART_THREAD_NAMES` to `docs-site/guides/configuration.mdx` (boolean, default `true`, gates live status prefixes and agent-authored thread names) and to the README env/quick-start table.

- [ ] **Step 2: Document limitations**

Add to `docs-site/reference/limitations.mdx` and the README Limitations section:

- Discord allows roughly two thread-name edits per ten minutes per channel, so status updates are coalesced and may lag.
- Sandboxes created before this feature do not receive the naming instruction until recreated; those threads keep their seeded prompt name.
- The agent may never emit a name; the seeded prompt-derived title then stands.

- [ ] **Step 3: Document the module**

Add `src/thread-name.ts` to the module map in `docs-site/reference/architecture.mdx`: name composition, marker parsing, coalescing/throttling namer.

- [ ] **Step 4: Add the changeset**

Run: `npx changeset`
Select a **minor** bump (new subsystem + default-behavior change). Summary: "Smart thread names: live status prefix and agent-authored, once-locked session titles."

- [ ] **Step 5: Verify docs and commit**

```bash
npm run docs:validate
npm test && npm run typecheck && npm run build
git add docs-site README.md .changeset
git commit -m "docs: document smart thread names"
```

---

## Self-Review

- **Spec coverage:** status prefix (Task 1/4/6/7), marker protocol (Task 1/5/6), 10-word title (Task 1), one-shot lock (Task 4/7), status after lock (Task 4/6), no-name fallback (Task 1 seeds title, Task 4 `getTitle`), manual rename (Task 2/7), rate limiting (Task 4), persistence (Task 2), config (Task 3), injection (Task 5), docs/changeset (Task 8). All covered.
- **Placeholders:** none — every code step contains concrete code.
- **Type consistency:** `ThreadStatus` defined in Task 1, imported in Tasks 6/7; `ThreadNamer` deps match between Task 4 and Task 7; `setLockedTitle`/`getTitle`/`isLocked` consistent; DB method names match between Task 2 and Task 7.
