# Celly Close-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead code and bloat, extract the overgrown units, share test scaffolding, delete the hand-made README hero asset, and close the command-chain bypass in the bash deny list.

**Architecture:** Move the permission engine out of `src/runner.ts` into `src/policy.ts`, then harden it with a full-command shell scanner. Extract the typing-indicator and list-cache clusters from `src/index.ts` into `src/typing.ts` and `src/lists.ts`. Introduce shared `test/helpers/` modules. Fail closed on commands the policy cannot statically analyze.

**Tech Stack:** TypeScript (NodeNext, strict, Node >=24 <25), Discord.js 14, `@opencode-ai/sdk`, SQLite via `node:sqlite`, vitest 3, changesets.

**Spec:** `docs/superpowers/specs/2026-09-29-celly-closeout-design.md`

## Global Constraints

- `npm test`, `npm run typecheck`, and `npm run build` must pass at the end of every task.
- The vitest suite is the contract. Tests may be merged or deleted only where this plan says so; all other tests must stay green without weakening assertions.
- Never introduce a host shell. Every `sbx` invocation stays in `src/sbx.ts`; only that module imports `child_process`.
- All path checks continue to go through the shared helpers. Do not touch the re-assert-after-wake behavior.
- Source imports use `.js` specifiers (NodeNext); test imports use `../src/<file>.ts`.
- Do not add comments to code except comments that already exist in moved blocks.
- Behavior, security, or user-visible changes get a changeset. Docs changes do not.
- README and `docs-site/` updates ship in the same task as the behavior they describe.
- Commit at the end of every task with a conventional message. Do not run `npx changeset version`.

---

### Task 1: Remove dead exports

**Files:**
- Modify: `src/commands.ts` (delete `parseCustomId`, lines 171-174)
- Modify: `src/sbx.ts` (delete the `cp` method at line 197)
- Modify: `src/config.ts` (delete `guildId` from `Config` at line 8 and from the `loadConfig` return at line 109)
- Test: `test/config.test.ts` (lines 179-187)

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` without `guildId`; `guildIds` unchanged; `DISCORD_GUILD_ID` parsing unchanged.

- [ ] **Step 1: Delete the three dead symbols**

Delete `parseCustomId` from `src/commands.ts`. The canonical `parseCustomIdFull` stays.

Delete the method:

```ts
  async cp(from: string, to: string) { await this.must(["cp", from, to]) }
```

from `src/sbx.ts`.

Delete `guildId: string;` from `Config` in `src/config.ts` and `guildId: guildIds![0]!,` from the object returned by `loadConfig`.

- [ ] **Step 2: Update the config tests**

In `test/config.test.ts`, rewrite the two tests so they no longer read `c.guildId`:

```ts
test("loadConfig prefers DISCORD_GUILD_IDS over the legacy singular id", () => {
  const c = loadConfig({ DISCORD_TOKEN: "t", DISCORD_GUILD_IDS: "g1,g2", DISCORD_GUILD_ID: "legacy" })
  expect(c.guildIds).toEqual(["g1", "g2"])
})
test("loadConfig falls back to the singular guild id", () => {
  const c = loadConfig({ ...base })
  expect(c.guildIds).toEqual(["g"])
})
```

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass, no references to `parseCustomId(`, `.cp(`, or `guildId` outside `guildIds`.

- [ ] **Step 4: Commit**

```bash
git add src/commands.ts src/sbx.ts src/config.ts test/config.test.ts
git commit -m "refactor: remove dead exports and the unused Config.guildId field"
```

---

### Task 2: Remove dead command branches and add the drift guard

**Files:**
- Modify: `src/commands.ts` (delete lines 388-393 and 406-418)
- Test: `test/commands.test.ts` (delete three tests, add one)

**Interfaces:**
- Consumes: `commandData()` and `handleCommand(interaction, deps)` from `src/commands.ts`.
- Produces: no new exports.

- [ ] **Step 1: Delete the dead branches**

In `src/commands.ts`, remove the direct-session branch inside `if (interaction.commandName === "resume")`:

```ts
      const direct = interaction.options.getString("session", false)
      if (direct) {
        const existing = deps.db.threads.getBySession(direct)[0]
        const thread = await deps.createThread?.({ channelId: project.channelId, title: existing?.title ?? `resume ${new Date().toISOString()}`, sessionId: direct, authorId: interaction.user?.id })
        return void await interaction.editReply(noMentions(thread ? `resumed in <#${thread.threadId}>` : "resume unavailable"))
      }
```

and inside the `model`/`agent` branch:

```ts
      const direct = interaction.options.getString(interaction.commandName, false)
      if (direct) {
        if (thread) {
          if (interaction.commandName === "model") deps.setThreadModel?.(scope, direct)
          else deps.setThreadAgent?.(scope, direct)
        } else if (interaction.commandName === "model") {
          deps.setChannelModel?.(scope, direct)
        } else {
          deps.setChannelAgent?.(scope, direct)
        }
        const label = thread ? interaction.commandName : `channel ${interaction.commandName}`
        return void await interaction.editReply(noMentions(`${label} set to ${direct}`))
      }
```

The `session`, `model`, and `agent` options do not exist in `commandData()` (`src/commands.ts:45-48`), so `getString(name, false)` always returns `null` in production.

- [ ] **Step 2: Delete the tests that inject the removed options**

Delete these three tests from `test/commands.test.ts`:

- `"model and agent with a direct value set the thread override"`
- `"resume with a direct session id creates the thread without a select"`
- `"model in a project channel with a direct value sets the channel default"`

- [ ] **Step 3: Write the drift guard test**

Add to `test/commands.test.ts`:

```ts
test("every declared command has a handler branch", async () => {
  for (const command of commandData()) {
    const subs = (command.options ?? [])
      .filter((o: any) => o.type === ApplicationCommandOptionType.Subcommand)
      .map((o: any) => o.name)
    for (const sub of subs.length ? subs : [undefined]) {
      const i = interaction({ commandName: command.name, channelId: "c", sub })
      await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
      expect(editOf(i), `${command.name} ${sub ?? ""}`).not.toBe("not implemented in this build")
    }
  }
})
```

`ApplicationCommandOptionType` is already imported at the top of `test/commands.test.ts`.

`interaction()` and `editOf()` already exist in this file. A command that loses its branch falls through to the `"not implemented in this build"` reply and fails the test.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. The new test fails if any `commandData()` name has no branch.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "fix(commands): drop dead direct-option branches and guard command coverage"
```

---

### Task 3: Shared database, project, thread, and logger fixtures

**Files:**
- Create: `test/helpers/fixtures.ts`
- Modify: `test/admin.test.ts`, `test/commands.test.ts`, `test/db.test.ts`, `test/handlers.test.ts`, `test/tasks.test.ts`, `test/worktrees.test.ts`, `test/idle.test.ts`, `test/attach.test.ts`, `test/backup.test.ts`, `test/projects.test.ts`

**Interfaces:**
- Produces: `freshDb(): Db`, `projectFixture(over?: Partial<Project>): Project`, `threadRow(over?: Partial<Thread>): Thread`, `silentLogger`.

- [ ] **Step 1: Create `test/helpers/fixtures.ts`**

```ts
import { openDb } from "../../src/db.ts"
import type { Db } from "../../src/db.ts"
import type { Project, Thread } from "../../src/types.ts"

export function freshDb(): Db {
  const db = openDb(":memory:")
  db.migrate()
  return db
}

export function projectFixture(over: Partial<Project> = {}): Project {
  return {
    channelId: "c", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null,
    sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", status: "provisioning", createdAt: 1,
    ...over,
  }
}

export function threadRow(over: Partial<Thread> = {}): Thread {
  return {
    threadId: "t1", channelId: "c", sessionId: "s1", title: "hello", model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1,
    ...over,
  }
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as any
```

- [ ] **Step 2: Migrate the ten test files**

For each file, delete the local `fresh()`/`proj`/`project()`/`thread()`/logger definitions and import from `../helpers/fixtures.ts`. Preserve each file's exact field values by passing overrides, for example:

- `test/admin.test.ts`: `fresh()` → `freshDb()`; `proj` → `projectFixture({ channelId: "c1" })`.
- `test/db.test.ts`: `fresh()` → `freshDb()`; `proj` → `projectFixture({ channelId: "c1", guildId: "g1", directory: "C:\\p\\demo" })`.
- `test/handlers.test.ts`: `fresh()` → `freshDb()`, `silent` → `silentLogger`, `thread()` → `threadRow`, and keep the ready default by wrapping the fixture: `const project = (over: Partial<Project> = {}) => projectFixture({ status: "ready", ...over })`. Do not use bare `projectFixture` here; its default status is `provisioning` and the handler tests rely on `ready`.
- `test/projects.test.ts`: local `logger()` → `silentLogger`; the local `proj` at line 606 → `projectFixture()`.
- `test/commands.test.ts`: local `fresh()` → `freshDb()`; `proj` → `projectFixture()`; the local `threadRow` → the shared `threadRow`.
- `test/tasks.test.ts`, `test/worktrees.test.ts`, `test/idle.test.ts`, `test/attach.test.ts`, `test/backup.test.ts`: same replacement, values preserved via overrides.

Do not change any assertion.

- [ ] **Step 3: Verify**

Run: `rg -n "function fresh\(\)" test/` (expect no output except `test/helpers/fixtures.ts` if it existed, which it should not).
Run: `npm test && npm run typecheck && npm run build`
Expected: all pass with the same test count as after Task 2.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/fixtures.ts test/*.test.ts
git commit -m "test: share database, project, thread, and logger fixtures"
```

---

### Task 4: Shared temp-directory helper

**Files:**
- Create: `test/helpers/tmp.ts`
- Modify: `test/audit.test.ts`, `test/rotate.test.ts`, `test/log.test.ts`, `test/backup.test.ts`, `test/config.test.ts`, `test/admin.test.ts`, `test/sbx.test.ts`, `test/db.test.ts`

**Interfaces:**
- Produces: `withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T>`.

- [ ] **Step 1: Create `test/helpers/tmp.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 2: Migrate the try/finally call sites**

Replace each `mkdtempSync(join(tmpdir(), "..."))` + `try { ... } finally { rmSync(dir, ...) }` pattern with `await withTempDir("celly-...", (dir) => { ... })`. Make the enclosing test callback `async` and `await` the helper. Examples:

```ts
test("does nothing when the file is missing or under maxBytes", async () => {
  await withTempDir("celly-rotate-", (dir) => {
    const file = join(dir, "bot.log")
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    writeFileSync(file, "small")
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    expect(existsSync(`${file}.1`)).toBe(false)
  })
})
```

- [ ] **Step 3: Verify**

Run: `rg -n "mkdtempSync" test/`
Expected: only `test/helpers/tmp.ts` and `test/projects.test.ts` (the shared per-suite data dir in `makeCfg`) remain.
Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/tmp.ts test/*.test.ts
git commit -m "test: share the temp-directory helper"
```

---

### Task 5: Shared HTTP test server

**Files:**
- Create: `test/helpers/http.ts`
- Modify: `test/projects.test.ts`, `test/events.test.ts`, `test/opencode.test.ts`, `test/attachments.test.ts`

**Interfaces:**
- Produces: `startTestServer(handler): Promise<{ url: string; port: number; close(): Promise<void> }>`.

- [ ] **Step 1: Create `test/helpers/http.ts`**

```ts
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

export interface TestServer {
  url: string
  port: number
  close(): Promise<void>
}

export async function startTestServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
```

- [ ] **Step 2: Migrate the four test files**

Replace hand-rolled `createServer(...)` + `server.listen(0, "127.0.0.1", ...)` + manual address extraction with `await startTestServer(handler)`; use `server.url`/`server.port` and `await server.close()`. Keep each file's handler body unchanged. In `test/projects.test.ts`, keep `healthServer(healthy, config, honorPatch)` but implement it on top of `startTestServer` and return `{ port: server.port, close: server.close }`.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/http.ts test/*.test.ts
git commit -m "test: share the HTTP test-server helper"
```

---

### Task 6: Merge or delete the provably redundant tests

**Files:**
- Modify: `test/mode.test.ts`, `test/render.test.ts`, `test/opencode.test.ts`, `test/commands.test.ts`, `test/session-utils.test.ts`, `test/sbx.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: same behavioral contract, ~6 fewer test entries.

- [ ] **Step 1: Delete the fully subsumed tests**

- `test/mode.test.ts`: delete `"PLAN_READ_ONLY_TOOLS is the read-only allow list"` (covered by `test/runner.test.ts` plan-mode tests).
- `test/render.test.ts`: delete `"renderer reports elapsed time from the first push to finalize"` (subsumed by `"elapsedMs measures from the first push to finalize"`).
- `test/opencode.test.ts`: delete `"resolveBaseUrl builds the loopback URL from a host port"` and `"createClient exposes baseUrl and auth for health checks"` (both transitively covered by `resolveClient` and the health tests).
- `test/commands.test.ts`: delete `"attach reports a missing project row"` (the shared missing-project branch is covered by `"session-id reports a missing project row"`).

- [ ] **Step 2: Merge the remaining near-duplicates**

- `test/sbx.test.ts`: merge the parser-error pair into one test that passes the same inputs and asserts both the thrown `SbxError` and the JSON shape in its message.
- `test/session-utils.test.ts`: merge the bar/clamp tests (`"formats a 20-cell usage bar"` and `"clamps a full bar"`) into one test with three `expect`s.
- `test/commands.test.ts`: move `expect(requiresOwner("budget", "show")).toBe(true)` and `expect(requiresOwner("budget", "set")).toBe(true)` into `"requiresOwner scopes project mutations"`, then delete `"requiresOwner covers the owner-only commands"`.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass; test count drops by six entries (three already removed in Task 2, not counted here).

- [ ] **Step 4: Commit**

```bash
git add test/mode.test.ts test/render.test.ts test/opencode.test.ts test/commands.test.ts test/session-utils.test.ts test/sbx.test.ts
git commit -m "test: merge redundant cases without losing coverage"
```

---

### Task 7: Extract the permission policy into `src/policy.ts`

**Files:**
- Create: `src/policy.ts`
- Create: `test/policy.test.ts`
- Modify: `src/runner.ts`, `test/runner.test.ts`

**Interfaces:**
- Produces from `src/policy.ts`:
  - `tokenizeShell(command: string): string[]`
  - `normalizeCommand(command: string): string`
  - `evaluatePermission(req: { tool: string; patterns: string[] }, deny?: string[]): "once" | "always" | "reject"`
  - `decidePermission(mode: ApprovalMode, req: { tool: string; patterns: string[] }): "once" | "always" | "reject"`
  - `interface PermissionReplyInput { source: "v1" | "v2"; threadId: string; sessionId: string; requestId: string; reply: "once" | "always" | "reject" }`
- Consumes from `src/runner.ts` after this task: `decidePermission`, `type PermissionReplyInput`.
- `src/runner.ts` keeps `withDirectory`, `RunnerDeps`, `QueuedPrompt`, `Runner`.

- [ ] **Step 1: Create `src/policy.ts` by moving code unchanged**

Copy the following blocks out of `src/runner.ts` into the new file without edits: `const DEFAULT_DENY` through `decidePermission` (currently lines 14-165), and the `PermissionReplyInput` interface (currently lines 167-173). Add the imports the moved code needs:

```ts
import { bashDenyPatterns } from "./opencode.js"
import { PLAN_READ_ONLY_TOOLS } from "./mode.js"
import type { ApprovalMode } from "./mode.ts"
```

- [ ] **Step 2: Trim `src/runner.ts`**

Replace the top import block so it only imports what remains:

```ts
import type { OpencodeClient } from "./opencode.ts"
import type { ApprovalMode } from "./mode.ts"
import { partToEvent } from "./events.js"
import type { NormalizedEvent } from "./events.ts"
import type { Renderer } from "./render.ts"
import type { Db } from "./db.ts"
import type { Thread } from "./types.ts"
import type { ApprovalManager } from "./approvals.ts"
import type { AuditDraft } from "./audit.ts"
import { formatCost, formatDuration, formatUsageFooter, resolveBudget } from "./usage.js"
import { decidePermission, type PermissionReplyInput } from "./policy.js"
```

Delete the moved constants, helpers, and functions. Keep everything from `withDirectory` onward.

- [ ] **Step 3: Move the policy tests to `test/policy.test.ts`**

Create `test/policy.test.ts` with this header and the test blocks moved verbatim from `test/runner.test.ts` (the deny/wrapper/normalization tests currently at lines 6-130 and the three `decidePermission` tests currently at lines 885-906):

```ts
import { expect, test } from "vitest"
import { decidePermission, evaluatePermission, normalizeCommand } from "../src/policy.ts"
```

Then change the import in `test/runner.test.ts` to:

```ts
import { Runner, withDirectory } from "../src/runner.ts"
```

and delete those policy test blocks from `test/runner.test.ts`.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. `test/policy.test.ts` has the same assertions that were in `test/runner.test.ts`; total count unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts src/runner.ts test/policy.test.ts test/runner.test.ts
git commit -m "refactor: extract the permission policy engine into src/policy.ts"
```

---

### Task 8: Extract the typing indicators into `src/typing.ts`

**Files:**
- Create: `src/typing.ts`
- Create: `test/typing.test.ts`
- Modify: `src/index.ts` (delete lines 258-277)
- Modify: `src/helpers.ts` (add `unrefTimer`)

**Interfaces:**
- Produces from `src/helpers.ts`: `unrefTimer(timer: unknown): void`.
- Produces from `src/typing.ts`: `createTypingIndicators(deps: { bucketFor(threadId: string): string; sendTyping(threadId: string, bucketChannelId: string): Promise<void> }): { start(threadId: string): void; stop(threadId: string): void }`.
- `src/index.ts` keeps local aliases `const startTyping = typing.start` and `const stopTyping = typing.stop` so call sites do not change.

- [ ] **Step 1: Add `unrefTimer` to `src/helpers.ts`**

```ts
export function unrefTimer(timer: unknown): void {
  const t = timer as { unref?: () => void }
  t.unref?.()
}
```

- [ ] **Step 2: Write the failing typing tests**

Create `test/typing.test.ts`:

```ts
import { afterEach, expect, test, vi } from "vitest"
import { createTypingIndicators } from "../src/typing.ts"

afterEach(() => vi.useRealTimers())

test("start sends immediately and every 8s, and is idempotent", async () => {
  vi.useFakeTimers()
  const calls: string[] = []
  const typing = createTypingIndicators({
    bucketFor: () => "bucket",
    sendTyping: async (id, bucket) => { calls.push(`${id}:${bucket}`) },
  })
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(["t1:bucket"])
  await vi.advanceTimersByTimeAsync(8000)
  expect(calls).toEqual(["t1:bucket", "t1:bucket"])
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(8000)
  expect(calls).toHaveLength(3)
  typing.stop("t1")
})

test("stop clears the interval and allows a restart", async () => {
  vi.useFakeTimers()
  let calls = 0
  const typing = createTypingIndicators({ bucketFor: () => "b", sendTyping: async () => { calls++ } })
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(0)
  typing.stop("t1")
  await vi.advanceTimersByTimeAsync(16000)
  expect(calls).toBe(1)
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(2)
  typing.stop("t1")
})

test("send failures are swallowed", async () => {
  vi.useFakeTimers()
  const typing = createTypingIndicators({ bucketFor: () => "b", sendTyping: async () => { throw new Error("boom") } })
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(8001)
  typing.stop("t1")
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/typing.test.ts`
Expected: FAIL — `../src/typing.ts` does not exist.

- [ ] **Step 4: Implement `src/typing.ts`**

```ts
import { unrefTimer } from "./helpers.js"

export interface TypingDeps {
  bucketFor(threadId: string): string
  sendTyping(threadId: string, bucketChannelId: string): Promise<void>
}

export function createTypingIndicators(deps: TypingDeps): { start(threadId: string): void; stop(threadId: string): void } {
  const timers = new Map<string, ReturnType<typeof setInterval>>()
  const stop = (threadId: string): void => {
    const timer = timers.get(threadId)
    if (timer) { clearInterval(timer); timers.delete(threadId) }
  }
  const start = (threadId: string): void => {
    if (timers.has(threadId)) return
    const bucketChannelId = deps.bucketFor(threadId)
    const tick = async (): Promise<void> => {
      try { await deps.sendTyping(threadId, bucketChannelId) } catch {}
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 8000)
    unrefTimer(timer)
    timers.set(threadId, timer)
  }
  return { start, stop }
}
```

- [ ] **Step 5: Wire it into `src/index.ts`**

Delete the `typingTimers`/`stopTyping`/`startTyping` block (currently lines 258-277) and replace it with:

```ts
  const typing = createTypingIndicators({
    bucketFor: (threadId) => { const thread = db.threads.get(threadId); return thread ? channelIdForBucket(thread) : threadId },
    sendTyping: async (threadId, bucketChannelId) => {
      const channel = await client.channels.fetch(threadId)
      if (channel && "sendTyping" in channel) await scheduleWithBucket(bucketChannelId, () => (channel as any).sendTyping())
    },
  })
  const startTyping = typing.start
  const stopTyping = typing.stop
```

Add the import `import { createTypingIndicators } from "./typing.js"` next to the other module imports.

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/typing.ts src/helpers.ts src/index.ts test/typing.test.ts
git commit -m "refactor: extract typing indicators into src/typing.ts"
```

---

### Task 9: Extract the project lists into `src/lists.ts`

**Files:**
- Create: `src/lists.ts`
- Create: `test/lists.test.ts`
- Modify: `src/index.ts` (delete lines 556-619)

**Interfaces:**
- Produces from `src/lists.ts`:

```ts
export interface ListDeps {
  projectFor(channelId: string): Project | undefined
  ensureReady(channelId: string): Promise<unknown>
  clientFor(project: Project): OpencodeClient
  modelVariants(model: unknown): string[] | undefined
  log: { warn(message: string, fields?: Record<string, unknown>): void }
}
export interface ProjectLists {
  listSessions(channelId: string): Promise<{ id: string; title: string }[]>
  listModels(channelId: string): Promise<{ id: string; name: string }[]>
  listAgents(channelId: string): Promise<{ id: string; name: string }[]>
  warmLists(channelId: string): void
}
export function createProjectLists(deps: ListDeps): ProjectLists
```

- `src/index.ts` consumes `createProjectLists` and destructures the four methods, so `CommandDeps` and call sites do not change.

- [ ] **Step 1: Write the failing tests**

Create `test/lists.test.ts`:

```ts
import { expect, test } from "vitest"
import { createProjectLists } from "../src/lists.ts"
import { projectFixture, silentLogger } from "./helpers/fixtures.ts"

const base = {
  projectFor: (channelId: string) => (channelId === "c" ? projectFixture() : undefined),
  ensureReady: async () => {},
  modelVariants: () => undefined,
  log: silentLogger,
}

test("listSessions maps ids and titles", async () => {
  const lists = createProjectLists({ ...base, clientFor: () => ({ session: { list: async () => ({ data: [{ id: "s1", title: "one" }, { id: "s2" }] }) } }) as any })
  expect(await lists.listSessions("c")).toEqual([{ id: "s1", title: "one" }, { id: "s2", title: "s2" }])
})

test("listSessions returns [] when the channel is not a project", async () => {
  let called = false
  const lists = createProjectLists({ ...base, clientFor: () => { called = true; return {} as any } })
  expect(await lists.listSessions("nope")).toEqual([])
  expect(called).toBe(false)
})

test("listModels flattens providers and caches the result", async () => {
  let loads = 0
  const lists = createProjectLists({ ...base, clientFor: () => ({ config: { providers: async () => { loads++; return { data: { providers: [{ id: "anthropic", name: "Anthropic", models: { claude: { name: "Claude" } } }] } } } } }) as any })
  expect(await lists.listModels("c")).toEqual([{ id: "anthropic/claude", name: "Claude" }])
  expect(await lists.listModels("c")).toHaveLength(1)
  expect(loads).toBe(1)
})

test("listAgents drops subagents", async () => {
  const lists = createProjectLists({ ...base, clientFor: () => ({ app: { agents: async () => ({ data: [{ name: "build", description: "Build things" }, { name: "hidden", mode: "subagent" }] }) } }) as any })
  expect(await lists.listAgents("c")).toEqual([{ id: "build", name: "build — Build things" }])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/lists.test.ts`
Expected: FAIL — `../src/lists.ts` does not exist.

- [ ] **Step 3: Implement `src/lists.ts`**

Move the logic from `src/index.ts:556-619` unchanged apart from dependency injection:

```ts
import type { Project } from "./types.ts"
import type { OpencodeClient } from "./opencode.ts"
import { createValueCache } from "./list-cache.js"
import type { ValueCache } from "./list-cache.js"

export interface ListDeps {
  projectFor(channelId: string): Project | undefined
  ensureReady(channelId: string): Promise<unknown>
  clientFor(project: Project): OpencodeClient
  modelVariants(model: unknown): string[] | undefined
  log: { warn(message: string, fields?: Record<string, unknown>): void }
}

export interface ProjectLists {
  listSessions(channelId: string): Promise<{ id: string; title: string }[]>
  listModels(channelId: string): Promise<{ id: string; name: string }[]>
  listAgents(channelId: string): Promise<{ id: string; name: string }[]>
  warmLists(channelId: string): void
}

export function createProjectLists(deps: ListDeps): ProjectLists {
  const listSessions = async (channelId: string): Promise<{ id: string; title: string }[]> => {
    const project = deps.projectFor(channelId)
    if (!project) return []
    await deps.ensureReady(channelId).catch(() => {})
    try {
      const sdk = deps.clientFor(project)
      const res: any = await sdk.session.list()
      const data = res?.data ?? res
      const list = Array.isArray(data) ? data : []
      return list.map((s: any) => ({ id: String(s.id), title: String(s.title ?? s.id) }))
    } catch { return [] }
  }

  const listCaches = new Map<string, ValueCache<any>>()
  const listCacheFor = <T>(key: string, load: () => Promise<T[]>): ValueCache<T> => {
    const existing = listCaches.get(key)
    if (existing) return existing
    const cache = createValueCache<T>({ ttlMs: 60_000, load, now: () => Date.now() })
    listCaches.set(key, cache)
    return cache
  }

  const loadModels = async (channelId: string): Promise<{ id: string; name: string; variants?: string[] }[]> => {
    const project = deps.projectFor(channelId)
    if (!project) return []
    try {
      const sdk = deps.clientFor(project)
      const res: any = await sdk.config.providers()
      const data = res?.data ?? res
      const providers = Array.isArray(data?.providers) ? data.providers : []
      const out: { id: string; name: string; variants?: string[] }[] = []
      for (const p of providers) {
        const providerId = typeof p?.id === "string" && p.id ? p.id : undefined
        if (!providerId) continue
        const models = p?.models && typeof p.models === "object" ? p.models : {}
        for (const [mid, model] of Object.entries(models)) {
          const id = `${providerId}/${mid}`
          const name = (model as any)?.name
          out.push({ id, name: typeof name === "string" && name ? name : `${p?.name ?? providerId}/${mid}`, variants: deps.modelVariants(model) })
        }
      }
      return out
    } catch (err) {
      deps.log.warn("list models failed", { channelId, error: String(err) })
      return []
    }
  }

  const loadAgents = async (channelId: string): Promise<{ id: string; name: string }[]> => {
    const project = deps.projectFor(channelId)
    if (!project) return []
    try {
      const sdk = deps.clientFor(project)
      const res: any = await sdk.app.agents()
      const data = res?.data ?? res
      const list = Array.isArray(data) ? data : []
      return list.filter((a: any) => a?.mode !== "subagent").map((a: any) => ({ id: String(a.name), name: a.description ? `${a.name} — ${a.description}` : String(a.name) }))
    } catch { return [] }
  }

  return {
    listSessions,
    listModels: (channelId) => listCacheFor(`models:${channelId}`, () => loadModels(channelId)).get(),
    listAgents: (channelId) => listCacheFor(`agents:${channelId}`, () => loadAgents(channelId)).get(),
    warmLists: (channelId) => {
      listCacheFor(`models:${channelId}`, () => loadModels(channelId)).refresh()
      listCacheFor(`agents:${channelId}`, () => loadAgents(channelId)).refresh()
    },
  }
}
```

- [ ] **Step 4: Wire it into `src/index.ts`**

Replace the deleted block with:

```ts
  const lists = createProjectLists({
    projectFor: (channelId) => db.projects.getByChannel(channelId),
    ensureReady: (channelId) => projects.ensureReady(channelId),
    clientFor: (project) => resolveClient(project),
    modelVariants,
    log,
  })
  const { listSessions, listModels, listAgents, warmLists } = lists
```

Remove the now-unused `createValueCache` and `ValueCache` imports from `src/index.ts` and add `import { createProjectLists } from "./lists.js"`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. `listModels` keeps its `{ id, name }` surface type; the runtime `variants` field is preserved because it comes from the cache.

- [ ] **Step 6: Commit**

```bash
git add src/lists.ts src/index.ts test/lists.test.ts
git commit -m "refactor: extract project list caches into src/lists.ts"
```

---

### Task 10: Shared command helpers and runner channel-state dedup

**Files:**
- Modify: `src/helpers.ts` (add `getErrorMessage`)
- Modify: `src/commands.ts` (add `replyError`, `healthSuffix`; use them)
- Modify: `src/runner.ts` (add `clearChannelState`; use it)

**Interfaces:**
- Produces from `src/helpers.ts`: `getErrorMessage(err: unknown): string`.
- Produces internal helpers in `src/commands.ts`: `replyError(interaction: any, e: unknown): Promise<void>`, `healthSuffix(deps: CommandDeps, channelId: string): Promise<string>`.
- Produces private `Runner.clearChannelState(channelId: string): Thread[]`.

- [ ] **Step 1: Add `getErrorMessage`**

```ts
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
```

- [ ] **Step 2: Deduplicate the error replies in `src/commands.ts`**

Add next to the other module-level helpers:

```ts
async function replyError(interaction: any, e: unknown): Promise<void> {
  const content = `error: ${getErrorMessage(e)}`
  if (interaction.deferred || interaction.replied) return void await interaction.editReply(noMentions(content))
  await interaction.reply(noMentions(content, { flags: 64 }))
}
```

Replace every identical catch block in `handleCommand`, `handleSelect`, `handleButton`, and `handleModalSubmit`:

```ts
  } catch (e) {
    const content = `error: ${(e as Error).message}`
    if (interaction.deferred || interaction.replied) return void await interaction.editReply(noMentions(content))
    await interaction.reply(noMentions(content, { flags: 64 }))
  }
```

with:

```ts
  } catch (e) {
    await replyError(interaction, e)
  }
```

- [ ] **Step 3: Deduplicate the health suffix**

Add:

```ts
async function healthSuffix(deps: CommandDeps, channelId: string): Promise<string> {
  let healthy: boolean | undefined
  try { healthy = await deps.projects.health?.(channelId) } catch { healthy = false }
  return healthy === undefined ? "" : healthy ? " healthy" : " unhealthy"
}
```

In the `project list` branch replace the inline `try/catch` + `health` computation with `const health = await healthSuffix(deps, p.channelId)`; do the same in the `project status` branch.

- [ ] **Step 4: Deduplicate the runner channel teardown**

Add to `Runner`:

```ts
  private clearChannelState(channelId: string): Thread[] {
    const threads = this.deps.db.threads.byChannel(channelId)
    for (const thread of threads) { this.queue.delete(thread.threadId); this.clearAbortTimer(thread.threadId) }
    return threads
  }
```

Rewrite the first loop in `handleProjectDown` and `resetChannel` to `const threads = this.clearChannelState(channelId)`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass; no `(e as Error).message` remains in `src/commands.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/helpers.ts src/commands.ts src/runner.ts
git commit -m "refactor: share command error/health helpers and runner channel teardown"
```

---

### Task 11: Stop swallowing failures

**Files:**
- Modify: `src/lists.ts` (log `listSessions` and `loadAgents` failures)
- Modify: `src/projects.ts` (log log-file failures)
- Test: `test/lists.test.ts`

**Interfaces:**
- Consumes: `getErrorMessage` from `src/helpers.ts`.
- Produces: same public surfaces; failures now emit `warn`.

- [ ] **Step 1: Write the failing test**

Add to `test/lists.test.ts`:

```ts
test("listSessions and listAgents log and return [] when the server call fails", async () => {
  const warnings: string[] = []
  const lists = createProjectLists({ ...base,
    clientFor: () => ({ session: { list: async () => { throw new Error("down") } }, app: { agents: async () => { throw new Error("down") } } }) as any,
    log: { warn: (message) => { warnings.push(message) } } })
  expect(await lists.listSessions("c")).toEqual([])
  expect(await lists.listAgents("c")).toEqual([])
  expect(warnings).toEqual(["list sessions failed", "list agents failed"])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lists.test.ts`
Expected: FAIL — `warnings` is empty because the catches are silent.

- [ ] **Step 3: Log the failures**

In `src/lists.ts`, change both silent catches to warn, matching the existing `loadModels` style:

```ts
    } catch (err) {
      deps.log.warn("list sessions failed", { channelId, error: String(err) })
      return []
    }
```

```ts
    } catch (err) {
      deps.log.warn("list agents failed", { channelId, error: String(err) })
      return []
    }
```

- [ ] **Step 4: Report project log-file failures once**

In `src/projects.ts` `bootServer`, add a `let logFailureReported = false` before `appendLog` and change the catch to:

```ts
      } catch (err) {
        if (!logFailureReported) {
          logFailureReported = true
          this.deps.log.warn("project log append failed", { channelId, error: getErrorMessage(err) })
        }
      }
```

Change the `mkdirSync`/`chmodSync` catches to warn:

```ts
    try { mkdirSync(dirname(logFile), { recursive: true }) } catch (err) { this.deps.log.warn("project log dir create failed", { channelId, error: getErrorMessage(err) }) }
    try { chmodSync(logFile, 0o600) } catch (err) { this.deps.log.warn("project log chmod failed", { channelId, error: getErrorMessage(err) }) }
```

Import `getErrorMessage` from `./helpers.js`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lists.ts src/projects.ts test/lists.test.ts
git commit -m "fix: log swallowed list and project-log failures"
```

---

### Task 12: One token formatter, one chunk constant, one unref helper

**Files:**
- Modify: `src/session-utils.ts` (import `formatTokens`, delete the local copy)
- Modify: `src/helpers.ts` (add `DISCORD_CHUNK_LIMIT`)
- Modify: `src/commands.ts`, `src/render.ts`, `src/shell.ts` (use the constant)
- Modify: `src/approvals.ts`, `src/backup.ts`, `src/idle.ts`, `src/runner.ts`, `src/tasks.ts`, `src/projects.ts` (use `unrefTimer`)
- Test: `test/session-utils.test.ts` (expect `1.3M`)

**Interfaces:**
- Produces from `src/helpers.ts`: `DISCORD_CHUNK_LIMIT = 1900`.
- `session-utils.formatTokens` is removed; it imports `formatTokens` from `./usage.js`.
- User-visible: `/context-usage` renders `1.3M` instead of `1.3m`.

- [ ] **Step 1: Update the session-utils test expectation**

In `test/session-utils.test.ts`, change the million-scale expectation from `"1.3m"` to `"1.3M"` (and any other lowercase `m` output in that file). Run `npx vitest run test/session-utils.test.ts` and confirm it fails.

- [ ] **Step 2: Unify the formatter**

Delete the local `formatTokens` in `src/session-utils.ts` and add `formatTokens` to its import from `./usage.js` (which already exports it). Run `npx vitest run test/session-utils.test.ts` and confirm it passes.

- [ ] **Step 3: Add `DISCORD_CHUNK_LIMIT`**

```ts
export const DISCORD_CHUNK_LIMIT = 1900
```

Replace the literals at `src/commands.ts:232`, `src/render.ts:159`, and `src/shell.ts:21`, and make the default parameter at `src/render.ts:55`:

```ts
export function chunkMessage(text: string, max = DISCORD_CHUNK_LIMIT): string[] {
```

Import it from `./helpers.js` in the three files.

- [ ] **Step 4: Sweep the unref idiom**

For each of `src/approvals.ts`, `src/backup.ts`, `src/idle.ts`, `src/runner.ts`, `src/tasks.ts`, `src/projects.ts`, replace:

```ts
if (typeof (timer as any).unref === "function") (timer as any).unref()
```

with `unrefTimer(timer)` and import it from `./helpers.js`. (`src/typing.ts` already uses it from Task 8.)

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. `rg -n "1900|as any\).unref" src/` shows only `test/helpers` declarations and no remaining idiom.

- [ ] **Step 6: Commit**

```bash
git add src/session-utils.ts src/helpers.ts src/commands.ts src/render.ts src/shell.ts src/approvals.ts src/backup.ts src/idle.ts src/runner.ts src/tasks.ts src/projects.ts test/session-utils.test.ts
git commit -m "refactor: unify token formatting, chunk limit, and timer unref"
```

---

### Task 13: Shell command scanner

**Files:**
- Modify: `src/policy.ts` (add the scanner; not yet wired into evaluation)
- Test: `test/policy.test.ts`

**Interfaces:**
- Produces from `src/policy.ts`:
  - `type ShellScan = { ok: true; commands: string[] } | { ok: false; reason: string; commands: string[] }` — a failure still carries the commands found before the unparseable construct, so an explicit deny match wins over the indeterminate verdict
  - `scanShellCommands(input: string): ShellScan`
- Internal functions `collectCommands`, `collectSubstitutions`, `expandSegment`, `shellPayload`, `ScanError`, `extractBalanced`, `findBacktickEnd`, `readWord`, `readHeredocBody`, `isIndeterminate`, and `COMPOUND_KEYWORDS` stay private.

- [ ] **Step 1: Write the failing scanner tests**

Add to `test/policy.test.ts` (update the import to include `scanShellCommands`):

```ts
test("splits every top-level command separator", () => {
  for (const input of ["echo hi; git push", "true && npm publish", "a || b", "printf x | grep y", "a & b", "one\ntwo"]) {
    const scan = scanShellCommands(input)
    expect(scan.ok, input).toBe(true)
    expect(scan.ok && scan.commands.length, input).toBe(2)
  }
})

test("ignores separators inside quotes", () => {
  const scan = scanShellCommands(`git commit -m "fix: a; git push" && git status`)
  expect(scan.ok).toBe(true)
  expect(scan.ok && scan.commands).toEqual([`git commit -m "fix: a; git push"`, "git status"])
})

test("extracts command substitutions and backticks recursively", () => {
  const scan = scanShellCommands("echo $(echo $(printenv)) `npm publish`")
  expect(scan.ok).toBe(true)
  expect(scan.ok && scan.commands).toContain("printenv")
  expect(scan.ok && scan.commands).toContain("npm publish")
})

test("single-quoted substitutions and separators are literal", () => {
  const scan = scanShellCommands("echo '$(git push); git push'")
  expect(scan.ok).toBe(true)
  expect(scan.ok && scan.commands).toEqual(["echo '$(git push); git push'"])
})

test("quoted heredocs are skipped and unquoted heredocs are scanned for substitutions", () => {
  const quoted = scanShellCommands("cat <<'EOF'\n$(printenv)\ngit push\nEOF")
  expect(quoted.ok).toBe(true)
  expect(quoted.ok && quoted.commands).toEqual(["cat <<'EOF'\n$(printenv)\ngit push\nEOF"])
  const unquoted = scanShellCommands("cat <<EOF\n$(printenv)\nEOF")
  expect(unquoted.ok).toBe(true)
  expect(unquoted.ok && unquoted.commands).toContain("printenv")
})

test("expands shell -c payloads so hidden chains are visible", () => {
  const chain = scanShellCommands("bash -c 'echo x; git push'")
  expect(chain.ok).toBe(true)
  expect(chain.ok && chain.commands).toContain("git push")
  const quoted = scanShellCommands(`bash -c 'echo "a; git push"'`)
  expect(quoted.ok).toBe(true)
  expect(quoted.ok && quoted.commands).not.toContain("git push")
  const wrapped = scanShellCommands("env -i bash -c 'npm publish'")
  expect(wrapped.ok).toBe(true)
  expect(wrapped.ok && wrapped.commands).toContain("npm publish")
})

test("fails closed on constructs it cannot analyze", () => {
  for (const input of ["diff <(git status) <(git log)", "echo $(git push", "echo 'unterminated", "$(git push)"]) {
    const scan = scanShellCommands(input)
    expect(scan.ok, input).toBe(false)
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/policy.test.ts`
Expected: FAIL — `scanShellCommands` is not exported.

- [ ] **Step 3: Implement the scanner in `src/policy.ts`**

```ts
const COMPOUND_KEYWORDS = new Set([
  "eval", "source", ".", "{", "}", "if", "then", "elif", "else", "fi",
  "for", "do", "done", "while", "until", "case", "esac", "select", "function", "coproc",
])

export type ShellScan = { ok: true; commands: string[] } | { ok: false; reason: string; commands: string[] }

class ScanError extends Error {
  constructor(readonly reason: string) { super(reason) }
}

function extractBalanced(input: string, openIndex: number, open: string, close: string): { text: string; next: number } | null {
  let depth = 0
  let quote: "'" | '"' | null = null
  for (let i = openIndex; i < input.length; i++) {
    const ch = input[i]!
    if (quote === "'") { if (ch === "'") quote = null; continue }
    if (quote === '"') { if (ch === "\\") { i++; continue } if (ch === '"') quote = null; continue }
    if (ch === "\\") { i++; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return { text: input.slice(openIndex + 1, i), next: i + 1 }
    }
  }
  return null
}

function findBacktickEnd(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue }
    if (input[i] === "`") return i
  }
  return -1
}

function readWord(input: string, start: number): { text: string; quoted: boolean; next: number } | null {
  let text = ""
  let quoted = false
  let i = start
  while (i < input.length && !/[\s;&|()<>`]/.test(input[i]!)) {
    const ch = input[i]!
    if (ch === "\\") {
      if (i + 1 >= input.length) return null
      text += input[i + 1]
      quoted = true
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const close = ch === "'" ? input.indexOf("'", i + 1) : findQuoteEnd(input, i + 1)
      if (close === -1) return null
      text += input.slice(i + 1, close)
      quoted = true
      i = close + 1
      continue
    }
    text += ch
    i++
  }
  return { text, quoted, next: i }
}

function findQuoteEnd(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue }
    if (input[i] === '"') return i
  }
  return -1
}

function readHeredocBody(input: string, start: number, delimiter: string, stripTabs: boolean): { body: string; next: number } | null {
  let i = start
  if (input[i] === "\n") i++
  const bodyStart = i
  while (i <= input.length) {
    const lineEnd = input.indexOf("\n", i)
    const end = lineEnd === -1 ? input.length : lineEnd
    const line = input.slice(i, end)
    const candidate = stripTabs ? line.replace(/^\t+/, "") : line
    if (candidate === delimiter) return { body: input.slice(bodyStart, i), next: end + 1 }
    if (lineEnd === -1) return null
    i = lineEnd + 1
  }
  return null
}

function collectSubstitutions(input: string, depth: number, commands: string[]): void {
  if (depth > 6) throw new ScanError("nesting too deep")
  let quote: "'" | null = null
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (quote === "'") { if (ch === "'") quote = null; i++; continue }
    if (ch === "\\") { i += 2; continue }
    if (ch === "'") { quote = "'"; i++; continue }
    if (ch === "$" && input[i + 1] === "(") {
      const parsed = extractBalanced(input, i + 1, "(", ")")
      if (!parsed) throw new ScanError("unbalanced $(")
      const inner = parsed.text
      if (inner.startsWith("(")) collectSubstitutions(inner, depth + 1, commands)
      else collectCommands(inner, depth + 1, commands)
      i = parsed.next
      continue
    }
    if (ch === "`") {
      const end = findBacktickEnd(input, i + 1)
      if (end === -1) throw new ScanError("unbalanced backtick")
      collectCommands(input.slice(i + 1, end), depth + 1, commands)
      i = end + 1
      continue
    }
    i++
  }
}

function shellPayload(segment: string): string | undefined {
  const tokens = tokenizeShell(segment)
  let i = 0
  for (;;) {
    while (tokens[i] !== undefined && ENV_ASSIGNMENT.test(tokens[i]!)) i++
    const token = tokens[i]
    if (token === undefined) return undefined
    const name = executableName(token)
    if (name === "env") {
      i++
      while (tokens[i] !== undefined) {
        const t = tokens[i]!
        if (ENV_ASSIGNMENT.test(t)) { i++; continue }
        if (t.startsWith("-")) { i += ENV_VALUE_OPTS.has(t) ? 2 : 1; continue }
        break
      }
      if (tokens[i] === undefined) return undefined
      continue
    }
    if (WRAPPERS.has(name)) {
      i++
      const valueOpts = WRAPPER_VALUE_OPTS[name]
      while (tokens[i]?.startsWith("-")) i += valueOpts?.has(tokens[i]!) ? 2 : 1
      continue
    }
    if (SHELLS.has(name)) {
      const cIndex = shellCommandIndex(tokens, i + 1)
      if (cIndex !== -1 && tokens[cIndex + 1] !== undefined) return tokens.slice(cIndex + 1).join(" ")
    }
    return undefined
  }
}

function expandSegment(segment: string, depth: number, commands: string[]): void {
  commands.push(segment)
  const payload = shellPayload(segment)
  if (payload !== undefined) collectCommands(payload, depth + 1, commands)
}

function collectCommands(input: string, depth: number, commands: string[]): void {
  if (depth > 6) throw new ScanError("nesting too deep")
  let current = ""
  let quote: "'" | '"' | null = null
  let i = 0
  const flush = (): void => {
    const c = current.trim()
    current = ""
    if (c) expandSegment(c, depth, commands)
  }
  while (i < input.length) {
    const ch = input[i]!
    if (quote === "'") {
      current += ch
      if (ch === "'") quote = null
      i++
      continue
    }
    if (quote === null) {
      if (ch === "\\") {
        if (i + 1 >= input.length) { current += ch; i++; continue }
        current += input.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === "'") { quote = "'"; current += ch; i++; continue }
      if (ch === '"') { quote = '"'; current += ch; i++; continue }
    } else if (ch === '"') {
      quote = null
      current += ch
      i++
      continue
    } else if (ch === "\\") {
      current += input.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === "$" && input[i + 1] === "{") {
      const end = input.indexOf("}", i + 2)
      if (end === -1) throw new ScanError("unbalanced ${")
      current += input.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (ch === "$" && input[i + 1] === "(") {
      if (current.trim() === "") throw new ScanError("command position is a substitution")
      const parsed = extractBalanced(input, i + 1, "(", ")")
      if (!parsed) throw new ScanError("unbalanced $(")
      const inner = parsed.text
      if (inner.startsWith("(")) collectSubstitutions(inner, depth + 1, commands)
      else collectCommands(inner, depth + 1, commands)
      current += input.slice(i, parsed.next)
      i = parsed.next
      continue
    }
    if (ch === "`") {
      if (current.trim() === "") throw new ScanError("command position is a substitution")
      const end = findBacktickEnd(input, i + 1)
      if (end === -1) throw new ScanError("unbalanced backtick")
      collectCommands(input.slice(i + 1, end), depth + 1, commands)
      current += input.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (quote === null && (ch === "<" || ch === ">") && input[i + 1] === "(") throw new ScanError("process substitution")
    if (quote === null && ch === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      const stripTabs = input[i + 2] === "-"
      let j = i + (stripTabs ? 3 : 2)
      while (input[j] === " " || input[j] === "\t") j++
      const word = readWord(input, j)
      if (!word || !word.text) throw new ScanError("unterminated heredoc")
      const body = readHeredocBody(input, word.next, word.text, stripTabs)
      if (!body) throw new ScanError("unterminated heredoc")
      if (!word.quoted) collectSubstitutions(body.body, depth, commands)
      current += input.slice(i, body.next)
      i = body.next
      continue
    }
    if (quote === null && (ch === ";" || ch === "\n" || ch === "&" || ch === "|" || ch === "(" || ch === ")")) {
      flush()
      if ((ch === "&" && input[i + 1] === "&") || (ch === "|" && input[i + 1] === "|")) i++
      i++
      continue
    }
    current += ch
    i++
  }
  if (quote !== null) throw new ScanError("unbalanced quote")
  flush()
}

export function scanShellCommands(input: string): ShellScan {
  const commands: string[] = []
  try {
    collectCommands(input, 0, commands)
    return { ok: true, commands }
  } catch (e) {
    if (e instanceof ScanError) return { ok: false, reason: e.reason, commands }
    throw e
  }
}

function isIndeterminate(segment: string): boolean {
  const normalized = normalizeCommand(segment)
  const exe = normalized.split(" ")[0]
  if (!exe) return false
  if (COMPOUND_KEYWORDS.has(exe)) return true
  return exe.includes("$") || exe.includes("`")
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/policy.test.ts`
Expected: PASS. If a heredoc test fails because the scanner treats the newline inside the skipped body as a separator, check that `current += input.slice(i, body.next)` is used so the body stays in the segment text.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass; `scanShellCommands` is not yet called by `evaluatePermission`, so existing behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/policy.ts test/policy.test.ts
git commit -m "feat(policy): add a fail-closed shell command scanner"
```

---

### Task 14: Wire the scanner into the deny policy and document it

**Files:**
- Modify: `src/policy.ts` (`evaluatePermission`, `decidePermission`)
- Modify: `docs-site/reference/security.mdx`
- Modify: `docs-site/reference/limitations.mdx`
- Create: `.changeset/deny-chain-hardening.md`
- Test: `test/policy.test.ts`

**Interfaces:**
- `evaluatePermission` now returns `"once" | "always" | "reject" | "ask"`; `"ask"` means indeterminate.
- `decidePermission` maps indeterminate to `reject` in `auto`/`plan` and `ask` in `buttons`; explicit deny matches stay `reject` in every mode.

- [ ] **Step 1: Write the failing corpus tests**

Add to `test/policy.test.ts`:

```ts
test("deny-listed commands hidden behind separators or substitutions are rejected", () => {
  const variants = [
    "echo hi; git push",
    "true && git push",
    "echo hi || npm publish",
    "printf x | git push",
    "echo hi & git clean -fdx .",
    "one\ngit push",
    "echo $(printenv)",
    "echo `npm publish --access public`",
    "echo $(echo $(git push))",
    "cat $(echo opencode.env)",
    "bash -c 'echo x; git push'",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("reject")
  }
})

test("benign chains and quoted separators stay allowed", () => {
  const variants = [
    "npm test && npm run build",
    "git status; ls",
    `git commit -m "fix: a; git push"`,
    "cat <<'EOF'\ngit push\n$(printenv)\nEOF",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("once")
  }
})

test("indeterminate commands fail closed", () => {
  for (const patterns of [["diff <(git status) <(git log)"], ['eval "git push"'], ["$x push"]]) {
    const req = { tool: "bash", patterns }
    expect(evaluatePermission(req), patterns[0]).toBe("ask")
    expect(decidePermission("auto", req), patterns[0]).toBe("reject")
    expect(decidePermission("buttons", req), patterns[0]).toBe("ask")
    expect(decidePermission("plan", req), patterns[0]).toBe("reject")
  }
})

test("explicit deny matches stay an absolute reject in buttons mode", () => {
  const req = { tool: "bash", patterns: ["echo hi; git push"] }
  expect(decidePermission("buttons", req)).toBe("reject")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/policy.test.ts`
Expected: FAIL — the chain variants currently return `"once"`.

- [ ] **Step 3: Replace `evaluatePermission` and `decidePermission`**

```ts
export function evaluatePermission(req: { tool: string; patterns: string[] }, deny: string[] = DEFAULT_DENY): "once" | "always" | "reject" | "ask" {
  if (!ALLOWED_TOOLS.has(req.tool)) return "reject"
  const matches = (pattern: string, value: string) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    return new RegExp(`^${escaped}$`).test(value)
  }
  if (req.tool !== "bash") {
    for (const p of req.patterns) if (SENSITIVE_PATH.test(p)) return "reject"
    return "once"
  }
  const normalizedDeny = deny === DEFAULT_DENY ? NORMALIZED_DEFAULT_DENY : deny.map(normalizeCommand)
  let indeterminate = false
  for (const p of req.patterns) {
    const scanned = scanShellCommands(p)
    for (const segment of scanned.commands) {
      const normalized = normalizeCommand(segment)
      if (normalizedDeny.some((d) => matches(d, normalized))) return "reject"
      if (isIndeterminate(segment)) indeterminate = true
    }
    if (!scanned.ok) indeterminate = true
  }
  return indeterminate ? "ask" : "once"
}

export function decidePermission(mode: ApprovalMode, req: { tool: string; patterns: string[] }): "once" | "always" | "reject" | "ask" {
  const verdict = evaluatePermission(req)
  if (verdict === "reject") return "reject"
  if (verdict === "ask") return mode === "buttons" ? "ask" : "reject"
  if (PLAN_READ_ONLY_TOOLS.has(req.tool)) return "once"
  return mode === "plan" ? "reject" : mode === "auto" ? "once" : "ask"
}
```

`src/runner.ts` already handles `"ask"` from `decidePermission` when routing to `ApprovalManager.requestPermission`, so no runner change is needed.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/policy.test.ts test/runner.test.ts`
Expected: PASS, including every pre-existing policy test.

- [ ] **Step 5: Update the security docs**

In `docs-site/reference/security.mdx`, keep the existing deny-list bullet and add directly after it:

```md
- Celly evaluates every command in a shell line: each `;` / `&&` / `||` / `|` /
  `&` segment, command substitutions (`$(...)`, backticks), and heredoc bodies.
  Commands that cannot be statically analyzed (process substitution,
  variable executables, `eval`/`source`, compound control keywords,
  unbalanced quotes, substitutions in command position) fail closed: they
  require approval in `buttons` mode and are rejected in `auto` and `plan`
  mode.
```

In `docs-site/reference/limitations.mdx`, add to the bullet list:

```md
- **The bash deny list is defense-in-depth, not the sandbox boundary.** Celly
  statically analyzes shell commands and fails closed on what it cannot prove,
  but arbitrary wrapper binaries, encoded payloads, and unmodelled shell
  features can still reach the sandbox. The sandbox is the boundary.
```

- [ ] **Step 6: Add the changeset**

Create `.changeset/deny-chain-hardening.md`:

```md
---
"celly": patch
---

Evaluate the whole bash command in the permission policy: deny-listed commands
hidden behind separators (`;`, `&&`, `||`, `|`, `&`), command substitutions
(`$(...)`, backticks), or heredoc bodies are now rejected, and commands the
policy cannot statically analyze fail closed (approval in buttons mode,
rejection in auto and plan).
```

- [ ] **Step 7: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/policy.ts test/policy.test.ts docs-site/reference/security.mdx docs-site/reference/limitations.mdx .changeset/deny-chain-hardening.md
git commit -m "feat(security): evaluate full shell commands and fail closed"
```

---

### Task 15: Remove the README hero asset and unreferenced images

**Files:**
- Delete: `docs-site/images/demo.svg`
- Delete: `docs-site/images/Gemini_Generated_Image_mr6onpmr6onpmr6o(1).jpg`
- Modify: `README.md` (lines 4-7)
- Modify: `.gitignore`

**Interfaces:** none.

- [ ] **Step 1: Confirm the images are unreferenced**

Run: `rg -n "demo\\.svg|Gemini_Generated" README.md docs-site docs`
Expected: only `README.md:6` for `demo.svg`; no references for the Gemini JPG.

- [ ] **Step 2: Delete the asset and the hero block**

Delete the files. Remove from `README.md`:

```html
<p align="center">
  <img src="docs-site/images/demo.svg" alt="Celly streaming a coding agent's reply inside a Discord thread" width="820">
</p>
```

- [ ] **Step 3: Ignore the untracked host config**

Append to `.gitignore`:

```gitignore

# Host-side opencode config used while developing this repo
/config.json
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. `git status --short` no longer lists `config.json`.

- [ ] **Step 5: Commit**

```bash
git add -A README.md .gitignore docs-site/images
git commit -m "docs: remove the README hero asset and ignore the host config"
```

---

### Task 16: Fix the docs rot and update the module map

**Files:**
- Modify: `docs-site/reference/architecture.mdx`
- Modify: `docs-site/guides/configuration.mdx`
- Modify: `docs-site/reference/commands.mdx`
- Review: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Fix the architecture module map**

In `docs-site/reference/architecture.mdx`:

- Replace the `src/autocomplete.ts` row with `src/list-cache.ts` — "Generic stale-while-revalidate cache backing the model/agent pickers."
- Add rows:
  - `src/policy.ts` — "Shell command parsing and permission policy: deny-list matching, wrapper normalization, and the fail-closed indeterminate policy used by `runner.ts`."
  - `src/typing.ts` — "Typing-indicator interval manager for active threads."
  - `src/lists.ts` — "Cached session, model, and agent listing for the pickers."
- Fix the existing rows:
  - `src/projects.ts`: drop "reconcile loop" (it lives in `handlers.ts`).
  - `src/opencode.ts`: drop "SSE subscription lifecycle" (it lives in `events.ts`).
  - `src/discord.ts`: keep client construction and access control; drop "message router, thread lifecycle, slash-command registration" (those live in `handlers.ts`/`index.ts`/`commands.ts`).
  - `src/runner.ts`: mention the run state machine and that policy evaluation now lives in `policy.ts`.

- [ ] **Step 2: Fix the lock wording**

In `docs-site/guides/configuration.mdx`, change the `DATA_DIR` sentence so it no longer claims the single-instance lock lives there. Use:

```md
`DATA_DIR` holds the SQLite database (`bot.db`), the rotating log
(`bot.log`), and per-project server logs (`logs/<sandbox>.log`). The
single-instance lock is a loopback TCP port, not a file. `DATA_DIR` is
gitignored and created on boot.
```

- [ ] **Step 3: Fix the `/queue` access row**

In `docs-site/reference/commands.mdx`, change `/queue` from `authorized` to `thread` (it requires being inside a thread and the README already says so).

- [ ] **Step 4: Review the README tables**

Confirm every row in the README command table still matches `commands.mdx`; no command surface changed in this close-out, so only the `/queue` row needs to agree (it already says `thread`).

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. If network allows: `npm run docs:validate && npm run docs:links`.

- [ ] **Step 6: Commit**

```bash
git add docs-site/reference/architecture.mdx docs-site/guides/configuration.mdx docs-site/reference/commands.mdx README.md
git commit -m "docs: fix the module map, lock wording, and /queue access row"
```

---

### Task 17: Final changeset and full verification

**Files:**
- Create: `.changeset/context-usage-token-format.md`

**Interfaces:** none.

- [ ] **Step 1: Add the user-visible formatting changeset**

Create `.changeset/context-usage-token-format.md`:

```md
---
"celly": patch
---

Render context-usage token counts with the same `k`/`M` formatting as `/cost`.
```

- [ ] **Step 2: Run the full definition of done**

Run: `npm test`
Expected: 36+ test files pass; policy has a new test file, so the file count may grow.

Run: `npm run typecheck`
Expected: pass.

Run: `npm run build`
Expected: pass.

Run: `npm run docs:validate && npm run docs:links` (if the network permits)
Expected: pass.

Run: `git status --short`
Expected: clean tree.

- [ ] **Step 3: Confirm no invariant was weakened**

Run: `rg -n "child_process" src/`
Expected: only `src/sbx.ts`.

Run: `rg -n "as any\).unref" src/`
Expected: no output.

Run: `rg -n "parseCustomId|autocomplete" src/ docs-site/`
Expected: no source hits; only historical changelog/plans if any.

- [ ] **Step 4: Commit**

```bash
git add .changeset/context-usage-token-format.md
git commit -m "chore: add the context-usage formatting changeset"
```

---

## Self-Review

- **Spec coverage:** Workstream A → Tasks 1, 2, 6, 15, 16. Workstream B → Tasks 3-5, 7-12. Workstream C → Tasks 13, 14. Definition of done → Task 17.
- **Type consistency:** `evaluatePermission` grows to include `"ask"` in Task 14; `decidePermission`'s signature is declared in Task 7 and extended in Task 14; `runner.ts`'s existing `"ask"` branch covers the new verdict without change. `ShellScan` failures carry partial `commands` so `evaluatePermission` checks deny matches before applying the indeterminate verdict. `shellPayload` intentionally repeats the wrapper walk from `normalizeCommand` rather than refactoring the test-pinned normalizer; the payload tests in Task 13 pin it. `createProjectLists` types are fixed in Task 9 and used unchanged in Task 11. `unrefTimer` is introduced in Task 8 and swept in Task 12. `DISCORD_CHUNK_LIMIT` is introduced and used in Task 12.
- **Placeholders:** none. Every code step contains the code; every mechanical migration step names the files and the acceptance command.
