# Conversation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the A-conversation-ux surface from the vNext spec: queue visibility with Remove/Clear buttons, `/undo`, `/redo`, `/diff`, `/share`, `/unshare`, `/compact`, `/context-usage`, autocomplete for `/resume`/`/model`/`/agent`, per-channel default model/agent, and tool titles plus elapsed time in streamed replies.

**Architecture:** New `src/session-utils.ts` owns session-level SDK calls and pure formatting (undo/redo/diff/share/compact/context usage) behind a `SessionOps` interface, so `src/commands.ts` stays Discord-only and tests assert exact SDK payloads with fake clients. New `src/autocomplete.ts` is a stale-while-revalidate suggestion cache; `src/index.ts` wires per-channel caches and per-channel default settings. `src/runner.ts` gains `createdAt` plus three queue-access methods; `src/events.ts`/`src/render.ts` gain tool titles and `startedAt`/`elapsedMs`. Token/cost persistence and the renderer `setFooter` belong to providers-and-cost and are deliberately not touched here.

**Tech Stack:** TypeScript ESM (Node 24, `.js` value imports in `src/`, `.ts` imports in `test/`), discord.js 14.27 (raw command JSON, `ComponentType`, `ButtonStyle`, `interaction.respond`), `@opencode-ai/sdk` 1.18.32 (`session.revert`/`unrevert`/`diff`/`share`/`unshare`/`summarize`/`messages`, `config.providers`), Vitest 3 with fake timers, SQLite `settings`.

**Spec:** docs/superpowers/specs/2026-09-27-vnext-features-design.md

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (guarded by `test/imports.test.ts`). Only `src/opencode.ts` and `src/projects.ts` may build `http://127.0.0.1:${...}` URLs.
- argv-only spawning: `shell: false`, `windowsHide: true`; never interpolate user input into a shell string sent to the host.
- Secrets (Discord token, server passwords, provider keys) never in argv, logs, audit entries, or Discord messages. Redact through `src/log.ts`.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and `../src/x.ts` imports. Temp dirs via `mkdtempSync(join(tmpdir(), "celly-...-")); try { } finally { rmSync(...) }`.
- Command changes update `docs-site/reference/commands.mdx` and the README commands table; config changes update `docs-site/guides/configuration.mdx` and `.env.example` (this plan adds no env config). Security-relevant changes update `docs-site/reference/security.mdx`. New docs pages register in `docs-site/docs.json` (no new pages here).
- Run `npm test`, `npm run typecheck`, `npm run build` before each commit.
- Migrations are append-only; this plan adds no migration.
- Add no new npm dependencies. Discord ephemeral replies use `flags: 64`. Reuse `sanitizeSelectOptions` for select menus.
- Conversation UX must not touch cost/token persistence; the token/duration footer (`Renderer.setFooter`) belongs to providers-and-cost. This plan only adds `Renderer.startedAt`/`elapsedMs()`.
- Spec §3.1 wire format stays `celly:<action>:<id>[:<extra>]`; reserved action names used here: `queue-remove`, `queue-clear`.

### Worktree

Run this plan in an isolated worktree created with `superpowers:using-git-worktrees`:

```bash
git worktree add ../discordAI-conversation-ux -b conversation-ux main
```

All commands below run from that worktree root. Merge back only after the final task is green.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/runner.ts` | modify | Queue entries gain `createdAt`; add `queuedFor`/`removeQueued`/`clearQueued`. |
| `src/render.ts` | modify | Tool line `> [name] status · title` (120-char truncation); `startedAt`/`endedAt`; `elapsedMs()`. |
| `src/events.ts` | modify | `NormalizedEvent` `tool` gains optional `title` from `part.state.title`. |
| `src/session-utils.ts` | create | Session SDK wrapper (`SessionOps`): undo/redo, diff, share/unshare, compact, context usage; pure formatters. |
| `src/autocomplete.ts` | create | `createSuggestionCache`: TTL cache, stale-while-revalidate, `[]` on cold miss. |
| `src/commands.ts` | modify | `/queue` + buttons, `/undo` `/redo` `/diff` `/share` `/unshare` `/compact` `/context-usage`, autocomplete options + handler, channel-scoped `/model` `/agent`. |
| `src/helpers.ts` | modify | `seedThreadDefaults` (channel default → global default). |
| `src/index.ts` | modify | Wire `SessionOps`, suggestion caches, autocomplete/button branches, channel defaults, thread seeding. |
| `test/runner.test.ts` | modify | Queue observability tests. |
| `test/render.test.ts` | modify | Tool-line + elapsed tests. |
| `test/events.test.ts` | modify | Tool-title mapping tests. |
| `test/session-utils.test.ts` | create | Exact SDK payload + formatting tests. |
| `test/autocomplete.test.ts` | create | Cache TTL/stale/failure tests. |
| `test/commands.test.ts` | modify | Command/button/autocomplete/channel-default tests. |
| `test/wiring.test.ts` | modify | `seedThreadDefaults` tests. |
| `docs-site/reference/commands.mdx` | modify | Command rows; shrink deferred list. |
| `docs-site/reference/architecture.mdx` | modify | Module map rows. |
| `README.md` | modify | Commands table + roadmap. |
| `.changeset/conversation-ux.md` | create | Minor changeset. |

---

### Task 1: Queue observability

**Files:**
- Modify: `src/runner.ts` (queue field at `:167`, `requeue` `:213-216`, `enqueue` `:217-222`, public methods after `activeThreadsFor` `:177-179`)
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface QueuedPrompt { text: string; actor: string; createdAt: number }`; `Runner.queuedFor(threadId: string): QueuedPrompt[]`; `Runner.removeQueued(threadId: string, index: number): boolean`; `Runner.clearQueued(threadId: string): number`.

- [ ] **Step 1: Write the failing tests**

Append to `test/runner.test.ts`:

```ts
test("queuedFor returns copies of queued prompts with createdAt", async () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(1000)
    const { db } = makeDb()
    const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
      createRenderer: async () => makeRenderer() as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "a", "u")
    vi.setSystemTime(2000)
    await runner.prompt("t1", "b", "u")
    const entries = runner.queuedFor("t1")
    expect(entries).toEqual([{ text: "b", actor: "u", createdAt: 2000 }])
    entries.pop()
    expect(runner.queuedFor("t1")).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})

test("removeQueued removes by index and reports out-of-range", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  await runner.prompt("t1", "b", "u")
  await runner.prompt("t1", "c", "u")
  expect(runner.removeQueued("t1", 1)).toBe(true)
  expect(runner.queuedFor("t1").map((q) => q.text)).toEqual(["b", "c"])
  expect(runner.removeQueued("t1", 5)).toBe(false)
  expect(runner.removeQueued("t1", -1)).toBe(false)
  expect(runner.removeQueued("t1", 1.5)).toBe(false)
  expect(runner.removeQueued("t2", 0)).toBe(false)
  expect(runner.queuedFor("t1").map((q) => q.text)).toEqual(["b", "c"])
})

test("clearQueued removes every entry and returns the count", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  await runner.prompt("t1", "b", "u")
  expect(runner.clearQueued("t1")).toBe(2)
  expect(runner.queuedFor("t1")).toEqual([])
  expect(runner.clearQueued("t1")).toBe(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.ts -t "queuedFor"`
Expected: FAIL — `TypeError: runner.queuedFor is not a function` (and the same for `removeQueued`/`clearQueued`).

- [ ] **Step 3: Write the minimal implementation**

In `src/runner.ts`, add before `export class Runner`:

```ts
export interface QueuedPrompt {
  text: string
  actor: string
  createdAt: number
}
```

Change the queue field:

```ts
private queue = new Map<string, QueuedPrompt[]>()
```

Replace `requeue` and `enqueue` with:

```ts
private requeue(threadId: string, next: QueuedPrompt): void {
  const q = this.queue.get(threadId) ?? []
  q.unshift(next); this.queue.set(threadId, q)
}
private enqueue(threadId: string, next: { text: string; actor: string }): string {
  const q = this.queue.get(threadId) ?? []
  if (q.length >= this.deps.maxQueue) return "queue full"
  q.push({ text: next.text, actor: next.actor, createdAt: Date.now() }); this.queue.set(threadId, q)
  return `queued (${q.length})`
}
```

Add public methods after `activeThreadsFor`:

```ts
queuedFor(threadId: string): QueuedPrompt[] {
  return (this.queue.get(threadId) ?? []).map((entry) => ({ ...entry }))
}
removeQueued(threadId: string, index: number): boolean {
  const q = this.queue.get(threadId)
  if (!q || !Number.isInteger(index) || index < 0 || index >= q.length) return false
  q.splice(index, 1)
  if (q.length === 0) this.queue.delete(threadId)
  return true
}
clearQueued(threadId: string): number {
  const q = this.queue.get(threadId)
  const count = q?.length ?? 0
  this.queue.delete(threadId)
  return count
}
```

`drain` still calls `this.requeue(threadId, next)` with the shifted entry, so requeue preserves the original `createdAt`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS (all runner tests, including the three new ones).

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts test/runner.test.ts
git commit -m "feat: expose queued prompts with createdAt and remove/clear helpers"
```

---

### Task 2: `/queue` command with Remove/Clear buttons

**Files:**
- Modify: `src/commands.ts` (imports `:1`, custom-id helpers `:56-60`, `commandData` `:22-27`, `handleCommand` after `abort` `:213-221`, new `handleButton` after `handleSelect` `:265`)
- Modify: `src/index.ts` (`onInteraction` `:416-424`)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `QueuedPrompt`, `Runner.queuedFor/removeQueued/clearQueued` (Task 1).
- Produces: `export interface ParsedCustomId { action: string; id?: string; extra?: string }`; `parseCustomIdFull(customId: string): ParsedCustomId`; `buttonCustomId(action: string, id: string, extra?: string): string`; `export const QUEUE_REMOVE = "queue-remove"`; `export const QUEUE_CLEAR = "queue-clear"`; `handleButton(interaction: any, deps: CommandDeps): Promise<void>`. Wire format: `celly:queue-remove:<threadId>:<index>` (0-based index) and `celly:queue-clear:<threadId>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/commands.test.ts`:

```ts
function button(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    customId: over.customId,
    channelId: over.channelId ?? "t1",
    user: over.user ?? { id: "u1" },
    calls,
    deferUpdate: async () => { calls.push({ kind: "deferUpdate" }) },
    editReply: async (c: any) => { calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}

test("parseCustomIdFull splits action, id, and extra", () => {
  expect(parseCustomIdFull("celly:queue-remove:t1:3")).toEqual({ action: "queue-remove", id: "t1", extra: "3" })
  expect(parseCustomIdFull("celly:queue-clear:t1")).toEqual({ action: "queue-clear", id: "t1", extra: undefined })
})

test("queue lists queued prompts with remove and clear buttons", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const entries = [
    { text: "first", actor: "u1", createdAt: 1 },
    { text: "second", actor: "u2", createdAt: 2 },
  ]
  const i = interaction({ commandName: "queue", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: { queuedFor: () => entries } as any, db, authorized: () => true })
  const edit = editOf(i)
  expect(edit.content).toContain("Queued (2)")
  expect(edit.content).toContain("1. first")
  expect(edit.content).toContain("2. second")
  const rows = edit.components
  expect(rows[0].components.map((b: any) => b.custom_id)).toEqual([
    "celly:queue-remove:t1:0",
    "celly:queue-remove:t1:1",
  ])
  expect(rows[0].components[0].label).toBe("Remove #1")
  expect(rows[1].components[0].custom_id).toBe("celly:queue-clear:t1")
  expect(rows[1].components[0].label).toBe("Clear")
})

test("queue outside a thread is rejected and an empty queue says so", async () => {
  const outside = interaction({ commandName: "queue", channelId: "c" })
  await handleCommand(outside, { projects: {} as any, runner: { queuedFor: () => [] } as any, db: fresh(), authorized: () => true })
  expect(editOf(outside)).toBe("use /queue inside a thread")

  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const empty = interaction({ commandName: "queue", channelId: "t1" })
  await handleCommand(empty, { projects: {} as any, runner: { queuedFor: () => [] } as any, db, authorized: () => true })
  expect(editOf(empty)).toBe("queue is empty")
})

test("queue remove button removes the index and refreshes the list", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const state = [
    { text: "first", actor: "u", createdAt: 1 },
    { text: "second", actor: "u", createdAt: 2 },
  ]
  const removed: number[] = []
  const i = button({ customId: "celly:queue-remove:t1:0" })
  await handleButton(i, { projects: {} as any, db, authorized: () => true, runner: {
    removeQueued: (_threadId: string, index: number) => { removed.push(index); state.splice(index, 1); return true },
    queuedFor: () => state,
  } as any })
  expect(removed).toEqual([0])
  const edit = editOf(i)
  expect(edit.content).toContain("Queued (1)")
  expect(edit.content).toContain("1. second")
  expect(edit.components[0].components[0].custom_id).toBe("celly:queue-remove:t1:0")
})

test("queue remove with a stale index reports the queue changed", async () => {
  const i = button({ customId: "celly:queue-remove:t1:9" })
  await handleButton(i, { projects: {} as any, db: fresh(), authorized: () => true,
    runner: { removeQueued: () => false } as any })
  expect(editOf(i)).toBe("queue changed; run /queue again")
})

test("queue clear button clears and reports the count", async () => {
  const i = button({ customId: "celly:queue-clear:t1" })
  await handleButton(i, { projects: {} as any, db: fresh(), authorized: () => true,
    runner: { clearQueued: () => 3 } as any })
  const edit = editOf(i)
  expect(edit.content).toBe("cleared 3 queued prompts")
  expect(edit.components).toEqual([])
})

test("unauthorized queue buttons are rejected before deferUpdate", async () => {
  const i = button({ customId: "celly:queue-clear:t1" })
  await handleButton(i, { projects: {} as any, db: fresh(), authorized: () => false, runner: {} as any })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "You are not authorized.", flags: 64, allowedMentions: { parse: [] } } })
})
```

Update the imports at the top of `test/commands.test.ts` to include the new names:

```ts
import { SELECT_OPTION_MAX, SELECT_OPTIONS_MAX, commandData, handleButton, handleCommand, handleSelect, parseCustomIdFull, requiresOwner, sanitizeSelectOptions } from "../src/commands.ts"
```

Update the declared command set test:

```ts
test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "model", "new", "project", "queue", "resume"])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts -t "queue"`
Expected: FAIL — `handleButton is not a function` / `parseCustomIdFull is not a function`; the declared command set test fails with `"queue"` missing.

- [ ] **Step 3: Write the minimal implementation**

In `src/commands.ts`, change the discord.js import:

```ts
import { ApplicationCommandOptionType, ButtonStyle, ComponentType } from "discord.js"
```

Add the runner type import:

```ts
import type { QueuedPrompt } from "./runner.ts"
```

Add the new command to `commandData()` (after the `agent` entry):

```ts
{ name: "queue", description: "Show and manage this thread's queued prompts" },
```

Add the queue constants and the button-id encoder. Do **not** redefine
`parseCustomIdFull`/`parseCustomId`: approvals-and-questions merges first and
owns them (spec §3.1). Only if they are absent in your tree, add them with the
canonical body from spec §3.1 before continuing.

```ts
export const QUEUE_REMOVE = "queue-remove"
export const QUEUE_CLEAR = "queue-clear"

export function buttonCustomId(action: string, id: string, extra?: string): string {
  return extra === undefined ? `celly:${action}:${id}` : `celly:${action}:${id}:${extra}`
}
```

Add the queue renderer next to `selectRow`:

```ts
function queueMessage(threadId: string, entries: QueuedPrompt[]): any {
  if (!entries.length) return noMentions("queue is empty")
  const shown = entries.slice(0, 10)
  const content = `Queued (${entries.length}):\n` + shown.map((entry, i) => `${i + 1}. ${entry.text.slice(0, 100)}`).join("\n")
  const rows: any[] = []
  for (let i = 0; i < shown.length; i += 5) {
    rows.push({ type: ComponentType.ActionRow, components: shown.slice(i, i + 5).map((_, j) => ({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      custom_id: buttonCustomId(QUEUE_REMOVE, threadId, String(i + j)),
      label: `Remove #${i + j + 1}`,
    })) })
  }
  rows.push({ type: ComponentType.ActionRow, components: [{
    type: ComponentType.Button,
    style: ButtonStyle.Danger,
    custom_id: buttonCustomId(QUEUE_CLEAR, threadId),
    label: "Clear",
  }] })
  return { content, components: rows, allowedMentions: { parse: [] } }
}
```

Add the command branch in `handleCommand` after the `abort` branch:

```ts
if (interaction.commandName === "queue") {
  const thread = deps.db.threads.get(interaction.channelId)
  if (!thread) return void await interaction.editReply(noMentions("use /queue inside a thread"))
  return void await interaction.editReply(queueMessage(thread.threadId, deps.runner.queuedFor(thread.threadId)))
}
```

Add `handleQueueButton` after `handleSelect` (a dedicated handler so it never
conflicts with approvals-and-questions' dispatcher):

```ts
export async function handleQueueButton(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action, id: threadId, extra } = parseCustomIdFull(interaction.customId ?? "")
  try {
    await interaction.deferUpdate()
    if (action === QUEUE_REMOVE) {
      if (!threadId) return void await interaction.editReply(noMentions("unknown queue button"))
      const index = Number(extra)
      if (!Number.isInteger(index) || !deps.runner.removeQueued(threadId, index)) {
        return void await interaction.editReply({ content: "queue changed; run /queue again", components: [], allowedMentions: { parse: [] } })
      }
      return void await interaction.editReply(queueMessage(threadId, deps.runner.queuedFor(threadId)))
    }
    if (action === QUEUE_CLEAR) {
      if (!threadId) return void await interaction.editReply(noMentions("unknown queue button"))
      const cleared = deps.runner.clearQueued(threadId)
      const content = cleared > 0 ? `cleared ${cleared} queued prompt${cleared === 1 ? "" : "s"}` : "queue is empty"
      return void await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } })
    }
    return void await interaction.editReply({ content: "unknown button", components: [], allowedMentions: { parse: [] } })
  } catch (e) {
    const content = `error: ${(e as Error).message}`
    if (interaction.deferred || interaction.replied) return void await interaction.editReply(noMentions(content))
    await interaction.reply(noMentions(content, { flags: 64 }))
  }
}
```

Extend the `handleButton` dispatcher (spec §3.1) with the queue route. If
`handleButton` does not exist yet because approvals-and-questions has not
merged, create it with exactly this body:

```ts
export async function handleButton(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action } = parseCustomIdFull(interaction.customId ?? "")
  if (action === QUEUE_REMOVE || action === QUEUE_CLEAR) return handleQueueButton(interaction, deps)
}
```

In `src/index.ts`, import `handleButton` and add the branch in `onInteraction`:

```ts
import { commandData, handleButton, handleCommand, handleSelect } from "./commands.js"
```

```ts
if (interaction.isButton()) { await handleButton(interaction, commandDeps); return }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts src/index.ts test/commands.test.ts
git commit -m "feat: add /queue with remove and clear buttons"
```

---

### Task 3: `/undo` and `/redo` via `session.revert`/`unrevert`

**Files:**
- Create: `src/session-utils.ts`
- Create: `test/session-utils.test.ts`
- Modify: `src/commands.ts` (imports, `CommandDeps` `:34-49`, `handleCommand` after `queue`)
- Modify: `src/index.ts` (wiring after `clientFor` `:139-145`, `commandDeps` `:386-400`)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `OpencodeClient` from `src/opencode.ts`; SDK verified signatures `session.messages({ path, query? })`, `session.revert({ path, body: { messageID }, query? })`, `session.unrevert({ path, query? })`.
- Produces: `SessionTarget { sessionId: string; directory?: string }`; `SessionOps { undo(threadId): Promise<"reverted" | "nothing">; redo(threadId): Promise<"redone"> }`; `SessionOpsDeps { targetFor(threadId): SessionTarget | undefined; clientFor(threadId): OpencodeClient }`; `SessionArgs { path: { id: string }; query?: { directory: string } }`; `createSessionOps(deps: SessionOpsDeps): SessionOps`; `lastUserMessageId(client: OpencodeClient, args: SessionArgs): Promise<string | undefined>`; `CommandDeps.sessions?: SessionOps`.

- [ ] **Step 1: Write the failing tests**

Create `test/session-utils.test.ts`:

```ts
// test/session-utils.test.ts
import { expect, test } from "vitest"
import { createSessionOps } from "../src/session-utils.ts"

function fakeClient(over: any = {}) {
  return {
    session: {
      messages: async () => ({ data: [] }),
      revert: async () => ({}),
      unrevert: async () => ({}),
      ...over.session,
    },
  } as any
}

test("undo reverts to the last user message with the exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({
    session: {
      messages: async (args: any) => { calls.push(["messages", args]); return { data: [
        { info: { id: "m1", role: "user" } },
        { info: { id: "m2", role: "assistant" } },
        { info: { id: "m3", role: "user" } },
      ] } },
      revert: async (args: any) => { calls.push(["revert", args]); return {} },
    },
  })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client })
  expect(await ops.undo("t1")).toBe("reverted")
  expect(calls).toEqual([
    ["messages", { path: { id: "s1" }, query: { directory: "/w" } }],
    ["revert", { path: { id: "s1" }, query: { directory: "/w" }, body: { messageID: "m3" } }],
  ])
})

test("undo without a directory omits the query and reports nothing to undo", async () => {
  const calls: any[] = []
  const client = fakeClient({
    session: {
      messages: async (args: any) => { calls.push(["messages", args]); return { data: [{ info: { id: "m1", role: "assistant" } }] } },
      revert: async (args: any) => { calls.push(["revert", args]); return {} },
    },
  })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client })
  expect(await ops.undo("t1")).toBe("nothing")
  expect(calls).toEqual([["messages", { path: { id: "s1" } }]])
})

test("undo rejects an unknown thread", async () => {
  const ops = createSessionOps({ targetFor: () => undefined, clientFor: () => fakeClient() })
  await expect(ops.undo("t9")).rejects.toThrow("unknown thread t9")
})

test("redo unreverts with the exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { unrevert: async (args: any) => { calls.push(args); return {} } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client })
  expect(await ops.redo("t1")).toBe("redone")
  expect(calls).toEqual([{ path: { id: "s1" } }])
})
```

Append to `test/commands.test.ts`:

```ts
test("undo reverts the thread's last user message", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const calls: string[] = []
  const i = interaction({ commandName: "undo", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { undo: async (threadId: string) => { calls.push(threadId); return "reverted" } } as any })
  expect(calls).toEqual(["t1"])
  expect(editOf(i)).toBe("reverted the last message")
})

test("undo outside a thread is rejected and nothing to undo is reported", async () => {
  const outside = interaction({ commandName: "undo", channelId: "c" })
  await handleCommand(outside, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, sessions: {} as any })
  expect(editOf(outside)).toBe("use /undo inside a thread")

  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const empty = interaction({ commandName: "undo", channelId: "t1" })
  await handleCommand(empty, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { undo: async () => "nothing" } as any })
  expect(editOf(empty)).toBe("nothing to undo")
})

test("redo unreverts the thread", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const calls: string[] = []
  const i = interaction({ commandName: "redo", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { redo: async (threadId: string) => { calls.push(threadId); return "redone" } } as any })
  expect(calls).toEqual(["t1"])
  expect(editOf(i)).toBe("redone")
})
```

Update the declared command set test:

```ts
expect(names).toEqual(["abort", "agent", "model", "new", "project", "queue", "redo", "resume", "undo"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-utils.test.ts test/commands.test.ts -t "undo"`
Expected: FAIL — `Failed to resolve import "../src/session-utils.ts"`; command tests fail with `use /undo inside a thread` coming back for everything (unimplemented branch hits `not implemented in this build`).

- [ ] **Step 3: Write the minimal implementation**

Create `src/session-utils.ts`:

```ts
import type { OpencodeClient } from "./opencode.ts"

export interface SessionTarget {
  sessionId: string
  directory?: string
}

export interface SessionOps {
  undo(threadId: string): Promise<"reverted" | "nothing">
  redo(threadId: string): Promise<"redone">
}

export interface SessionOpsDeps {
  targetFor(threadId: string): SessionTarget | undefined
  clientFor(threadId: string): OpencodeClient
}

export interface SessionArgs {
  path: { id: string }
  query?: { directory: string }
}

function unwrap<T>(response: unknown): T {
  return ((response as { data?: T } | undefined)?.data ?? response) as T
}

function argsFor(deps: SessionOpsDeps, threadId: string): SessionArgs {
  const target = deps.targetFor(threadId)
  if (!target) throw new Error(`unknown thread ${threadId}`)
  return target.directory
    ? { path: { id: target.sessionId }, query: { directory: target.directory } }
    : { path: { id: target.sessionId } }
}

export async function lastUserMessageId(client: OpencodeClient, args: SessionArgs): Promise<string | undefined> {
  const messages = unwrap<unknown>(await client.session.messages(args))
  let last: { info?: { id?: unknown; role?: unknown } } | undefined
  if (Array.isArray(messages)) {
    for (const message of messages as { info?: { id?: unknown; role?: unknown } }[]) {
      if (message?.info?.role === "user") last = message
    }
  }
  return typeof last?.info?.id === "string" && last.info.id ? last.info.id : undefined
}

export function createSessionOps(deps: SessionOpsDeps): SessionOps {
  return {
    async undo(threadId) {
      const args = argsFor(deps, threadId)
      const messageID = await lastUserMessageId(deps.clientFor(threadId), args)
      if (!messageID) return "nothing"
      await deps.clientFor(threadId).session.revert({ ...args, body: { messageID } })
      return "reverted"
    },
    async redo(threadId) {
      const args = argsFor(deps, threadId)
      await deps.clientFor(threadId).session.unrevert(args)
      return "redone"
    },
  }
}
```

In `src/commands.ts`, add the type import and `CommandDeps` field:

```ts
import type { SessionOps } from "./session-utils.ts"
```

```ts
  setThreadModel?(threadId: string, model: string | null): void
  setThreadAgent?(threadId: string, agent: string | null): void
  sessions?: SessionOps
```

Add the command branch after the `queue` branch:

```ts
if (interaction.commandName === "undo" || interaction.commandName === "redo") {
  const thread = deps.db.threads.get(interaction.channelId)
  if (!thread) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
  if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
  if (interaction.commandName === "undo") {
    const result = await deps.sessions.undo(thread.threadId)
    return void await interaction.editReply(noMentions(result === "reverted" ? "reverted the last message" : "nothing to undo"))
  }
  await deps.sessions.redo(thread.threadId)
  return void await interaction.editReply(noMentions("redone"))
}
```

In `src/index.ts`, add the value import and wire the ops after `clientFor`:

```ts
import { createSessionOps } from "./session-utils.js"
```

```ts
const directoryFor = (threadId: string): string | undefined => db.threads.get(threadId)?.worktreePath ?? undefined
const sessions = createSessionOps({
  targetFor: (threadId) => {
    const thread = db.threads.get(threadId)
    if (!thread) return undefined
    const directory = directoryFor(threadId)
    return directory ? { sessionId: thread.sessionId, directory } : { sessionId: thread.sessionId }
  },
  clientFor,
})
```

Add `sessions` to `commandDeps`:

```ts
    setThreadModel, setThreadAgent,
    sessions,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-utils.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-utils.ts test/session-utils.test.ts src/commands.ts src/index.ts test/commands.test.ts
git commit -m "feat: add /undo and /redo over session revert endpoints"
```

---

### Task 4: `/diff` formatting with a 10-file cap

**Files:**
- Modify: `src/session-utils.ts` (import, `SessionOps`, `createSessionOps`)
- Modify: `src/commands.ts` (imports, `handleCommand` after `redo`; `replyChunks` helper)
- Test: `test/session-utils.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `SessionOps`/`argsFor`/`unwrap` from Task 3; SDK `session.diff({ path, query? })` returns `FileDiff[]` where `FileDiff = { file: string; before: string; after: string; additions: number; deletions: number }`; `chunkMessage(text, max?)` from `src/render.ts`.
- Produces: `SessionOps.diff(threadId: string): Promise<FileDiff[]>`; `formatDiff(files: FileDiff[], max?: number): string` (default `max = 10`; status is `A` when `before === ""`, `D` when `after === ""`, else `M`; lines `status path (+adds/-dels)`, then `… and N more`, then `total: +X/-Y across N files`; returns `"no changes"` for an empty list).

- [ ] **Step 1: Write the failing tests**

Append to `test/session-utils.test.ts` (add `formatDiff` to the import):

```ts
import { createSessionOps, formatDiff } from "../src/session-utils.ts"

const FIXTURE_DIFF = [
  { file: "src/a.ts", before: "a", after: "b", additions: 2, deletions: 1 },
  { file: "src/new.ts", before: "", after: "b", additions: 5, deletions: 0 },
  { file: "src/gone.ts", before: "a", after: "", additions: 0, deletions: 9 },
]

test("formatDiff renders status, adds, deletes, and totals", () => {
  expect(formatDiff(FIXTURE_DIFF)).toBe([
    "M src/a.ts (+2/-1)",
    "A src/new.ts (+5/-0)",
    "D src/gone.ts (+0/-9)",
    "total: +7/-10 across 3 files",
  ].join("\n"))
})

test("formatDiff caps at 10 files and keeps whole-list totals", () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ file: `src/f${i}.ts`, before: "a", after: "b", additions: 1, deletions: 1 }))
  const lines = formatDiff(files).split("\n")
  expect(lines).toHaveLength(12)
  expect(lines[10]).toBe("… and 2 more")
  expect(lines[11]).toBe("total: +12/-12 across 12 files")
})

test("formatDiff reports no changes for an empty list", () => {
  expect(formatDiff([])).toBe("no changes")
})

test("diff calls the session diff endpoint and returns the files", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { diff: async (args: any) => { calls.push(args); return { data: FIXTURE_DIFF } } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client })
  expect(await ops.diff("t1")).toEqual(FIXTURE_DIFF)
  expect(calls).toEqual([{ path: { id: "s1" }, query: { directory: "/w" } }])
})
```

Append to `test/commands.test.ts`:

```ts
test("diff formats the file list", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const files = [
    { file: "src/a.ts", before: "a", after: "b", additions: 2, deletions: 1 },
    { file: "src/b.ts", before: "", after: "x", additions: 3, deletions: 0 },
  ]
  const i = interaction({ commandName: "diff", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { diff: async () => files } as any })
  expect(editOf(i)).toBe("M src/a.ts (+2/-1)\nA src/b.ts (+3/-0)\ntotal: +5/-1 across 2 files")
})

test("diff chunks long file lists into a follow-up", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const files = Array.from({ length: 10 }, (_, i) => ({ file: `src/${"x".repeat(200)}${i}.ts`, before: "a", after: "b", additions: 1, deletions: 1 }))
  const i = interaction({ commandName: "diff", channelId: "t1" })
  i.followUp = async (c: any) => { i.calls.push({ kind: "followUp", c }) }
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { diff: async () => files } as any })
  expect(i.calls.filter((c: any) => c.kind === "edit")).toHaveLength(1)
  expect(i.calls.filter((c: any) => c.kind === "followUp")).toHaveLength(1)
  for (const call of i.calls) {
    if (call.kind === "followUp") expect(call.c.flags).toBe(64)
  }
})
```

Update the declared command set test:

```ts
expect(names).toEqual(["abort", "agent", "diff", "model", "new", "project", "queue", "redo", "resume", "undo"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-utils.test.ts -t "formatDiff"`
Expected: FAIL — `formatDiff is not a function` (and the `/diff` command test returns `not implemented in this build`).

- [ ] **Step 3: Write the minimal implementation**

In `src/session-utils.ts`, add the SDK type import:

```ts
import type { FileDiff } from "@opencode-ai/sdk"
```

Extend `SessionOps`:

```ts
export interface SessionOps {
  undo(threadId: string): Promise<"reverted" | "nothing">
  redo(threadId: string): Promise<"redone">
  diff(threadId: string): Promise<FileDiff[]>
}
```

Add `formatDiff` before `createSessionOps`:

```ts
export function formatDiff(files: FileDiff[], max = 10): string {
  if (!files.length) return "no changes"
  const shown = files.slice(0, max)
  const lines = shown.map((file) => {
    const status = file.before === "" ? "A" : file.after === "" ? "D" : "M"
    return `${status} ${file.file} (+${file.additions}/-${file.deletions})`
  })
  if (files.length > shown.length) lines.push(`… and ${files.length - shown.length} more`)
  const additions = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0)
  const deletions = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0)
  lines.push(`total: +${additions}/-${deletions} across ${files.length} file${files.length === 1 ? "" : "s"}`)
  return lines.join("\n")
}
```

Add the `diff` method to `createSessionOps` after `redo`:

```ts
    async diff(threadId) {
      const args = argsFor(deps, threadId)
      const files = unwrap<unknown>(await deps.clientFor(threadId).session.diff(args))
      return Array.isArray(files) ? (files as FileDiff[]) : []
    },
```

In `src/commands.ts`, add imports:

```ts
import { formatDiff } from "./session-utils.js"
import { chunkMessage } from "./render.js"
```

Add the reply helper after `selectRow`:

```ts
async function replyChunks(interaction: any, content: string): Promise<void> {
  const chunks = chunkMessage(content, 1900)
  const [first = "no changes", ...rest] = chunks
  await interaction.editReply(noMentions(first))
  for (const chunk of rest) await interaction.followUp(noMentions(chunk, { flags: 64 }))
}
```

Add the command branch after the `undo`/`redo` branch:

```ts
if (interaction.commandName === "diff") {
  const thread = deps.db.threads.get(interaction.channelId)
  if (!thread) return void await interaction.editReply(noMentions("use /diff inside a thread"))
  if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
  const files = await deps.sessions.diff(thread.threadId)
  return void await replyChunks(interaction, formatDiff(files))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-utils.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-utils.ts src/commands.ts test/session-utils.test.ts test/commands.test.ts
git commit -m "feat: add /diff with capped file list and totals"
```

---

### Task 5: `/share` and `/unshare`

**Files:**
- Modify: `src/session-utils.ts` (`SessionOps`, `createSessionOps`)
- Modify: `src/commands.ts` (`handleCommand` after `diff`)
- Test: `test/session-utils.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: SDK `session.share({ path, query? })` returns a `Session` with `share?: { url: string }`; `session.unshare({ path, query? })`.
- Produces: `SessionOps.share(threadId: string): Promise<string>` (throws `Error("session share returned no url")` when absent); `SessionOps.unshare(threadId: string): Promise<void>`. Command copy: `shared: <url>` and `unshared`.

- [ ] **Step 1: Write the failing tests**

Append to `test/session-utils.test.ts`:

```ts
test("share returns the session share url with the exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { share: async (args: any) => { calls.push(args); return { data: { id: "s1", share: { url: "https://opncd.ai/s/abc" } } } } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client })
  expect(await ops.share("t1")).toBe("https://opncd.ai/s/abc")
  expect(calls).toEqual([{ path: { id: "s1" } }])
})

test("share throws when the session has no url", async () => {
  const client = fakeClient({ session: { share: async () => ({ data: { id: "s1" } }) } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client })
  await expect(ops.share("t1")).rejects.toThrow("session share returned no url")
})

test("unshare posts the unshare endpoint", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { unshare: async (args: any) => { calls.push(args); return {} } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client })
  await expect(ops.unshare("t1")).resolves.toBeUndefined()
  expect(calls).toEqual([{ path: { id: "s1" }, query: { directory: "/w" } }])
})
```

Append to `test/commands.test.ts`:

```ts
test("share posts the share url and unshare confirms", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const shared: string[] = []
  const sharedInteraction = interaction({ commandName: "share", channelId: "t1" })
  await handleCommand(sharedInteraction, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { share: async (threadId: string) => { shared.push(threadId); return "https://opncd.ai/s/abc" } } as any })
  expect(shared).toEqual(["t1"])
  expect(editOf(sharedInteraction)).toBe("shared: https://opncd.ai/s/abc")

  const unshared: string[] = []
  const unshareInteraction = interaction({ commandName: "unshare", channelId: "t1" })
  await handleCommand(unshareInteraction, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { unshare: async (threadId: string) => { unshared.push(threadId) } } as any })
  expect(unshared).toEqual(["t1"])
  expect(editOf(unshareInteraction)).toBe("unshared")
})
```

Update the declared command set test:

```ts
expect(names).toEqual(["abort", "agent", "diff", "model", "new", "project", "queue", "redo", "resume", "share", "undo", "unshare"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts -t "share posts"`
Expected: FAIL — `/share` returns `not implemented in this build`; session-utils tests fail with `ops.share is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `src/session-utils.ts`, extend `SessionOps`:

```ts
  share(threadId: string): Promise<string>
  unshare(threadId: string): Promise<void>
```

Add to `createSessionOps` after `diff`:

```ts
    async share(threadId) {
      const args = argsFor(deps, threadId)
      const session = unwrap<{ share?: { url?: unknown } }>(await deps.clientFor(threadId).session.share(args))
      const url = session?.share?.url
      if (typeof url !== "string" || !url) throw new Error("session share returned no url")
      return url
    },
    async unshare(threadId) {
      const args = argsFor(deps, threadId)
      await deps.clientFor(threadId).session.unshare(args)
    },
```

Add the command branches in `src/commands.ts` after the `diff` branch:

```ts
if (interaction.commandName === "share" || interaction.commandName === "unshare") {
  const thread = deps.db.threads.get(interaction.channelId)
  if (!thread) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
  if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
  if (interaction.commandName === "share") {
    const url = await deps.sessions.share(thread.threadId)
    return void await interaction.editReply(noMentions(`shared: ${url}`))
  }
  await deps.sessions.unshare(thread.threadId)
  return void await interaction.editReply(noMentions("unshared"))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-utils.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-utils.ts src/commands.ts test/session-utils.test.ts test/commands.test.ts
git commit -m "feat: add /share and /unshare"
```

---

### Task 6: `/compact` with the thread model

**Files:**
- Modify: `src/session-utils.ts` (`SessionOpsDeps`, `SessionOps`, `createSessionOps`)
- Modify: `src/commands.ts` (`handleCommand` after `share`/`unshare`)
- Modify: `src/index.ts` (add `threadModel` to the `createSessionOps` deps)
- Test: `test/session-utils.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: SDK `session.summarize({ path, body: { providerID, modelID }, query? })`; `SessionOpsDeps.threadModel(threadId: string): string | null | undefined`.
- Produces: `SessionOps.compact(threadId: string): Promise<"compacted">`; throws `Error("set a model with /model first")` when the thread has no `provider/model` model. Command copy on success: `compacted`; the failure surfaces as `error: set a model with /model first` through `handleCommand`'s catch.

- [ ] **Step 1: Write the failing tests**

Append to `test/session-utils.test.ts`. Task 3's tests construct `createSessionOps` without `threadModel`, so update every existing `createSessionOps` call in this file to include `threadModel: () => null` (and pass a real one where the test needs it):

```ts
test("compact summarizes with the thread model and exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { summarize: async (args: any) => { calls.push(args); return { data: true } } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client, threadModel: () => "anthropic/claude" })
  expect(await ops.compact("t1")).toBe("compacted")
  expect(calls).toEqual([{ path: { id: "s1" }, query: { directory: "/w" }, body: { providerID: "anthropic", modelID: "claude" } }])
})

test("compact without a model throws the spec error", async () => {
  const client = fakeClient()
  for (const model of [null, undefined, "claude", "anthropic/", ""]) {
    const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client, threadModel: () => model })
    await expect(ops.compact("t1")).rejects.toThrow("set a model with /model first")
  }
})
```

Append to `test/commands.test.ts`:

```ts
test("compact reports compacted, and the no-model error is exact", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const ok = interaction({ commandName: "compact", channelId: "t1" })
  await handleCommand(ok, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { compact: async () => "compacted" } as any })
  expect(editOf(ok)).toBe("compacted")

  const bad = interaction({ commandName: "compact", channelId: "t1" })
  await handleCommand(bad, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { compact: async () => { throw new Error("set a model with /model first") } } as any })
  expect(editOf(bad)).toBe("error: set a model with /model first")
})
```

Update the declared command set test:

```ts
expect(names).toEqual(["abort", "agent", "compact", "diff", "model", "new", "project", "queue", "redo", "resume", "share", "undo", "unshare"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-utils.test.ts -t "compact"`
Expected: FAIL — `ops.compact is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `src/session-utils.ts`:

```ts
export interface SessionOpsDeps {
  targetFor(threadId: string): SessionTarget | undefined
  clientFor(threadId: string): OpencodeClient
  threadModel(threadId: string): string | null | undefined
}
```

```ts
  compact(threadId: string): Promise<"compacted">
```

Add to `createSessionOps` after `unshare`:

```ts
    async compact(threadId) {
      const model = deps.threadModel(threadId)
      const slash = typeof model === "string" ? model.indexOf("/") : -1
      if (slash <= 0 || slash === model!.length - 1) throw new Error("set a model with /model first")
      const args = argsFor(deps, threadId)
      await deps.clientFor(threadId).session.summarize({
        ...args,
        body: { providerID: model!.slice(0, slash), modelID: model!.slice(slash + 1) },
      })
      return "compacted"
    },
```

Add the command branch in `src/commands.ts` after the `share`/`unshare` branch:

```ts
if (interaction.commandName === "compact") {
  const thread = deps.db.threads.get(interaction.channelId)
  if (!thread) return void await interaction.editReply(noMentions("use /compact inside a thread"))
  if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
  await deps.sessions.compact(thread.threadId)
  return void await interaction.editReply(noMentions("compacted"))
}
```

In `src/index.ts`, add `threadModel` to the `createSessionOps` call:

```ts
  clientFor,
  threadModel: (threadId) => db.threads.get(threadId)?.model,
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-utils.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-utils.ts src/commands.ts src/index.ts test/session-utils.test.ts test/commands.test.ts
git commit -m "feat: add /compact over session.summarize"
```

---

### Task 7: `/context-usage`

**Files:**
- Modify: `src/session-utils.ts` (`SessionOpsDeps`, `SessionOps`, `createSessionOps`, new formatters)
- Modify: `src/commands.ts` (`handleCommand` after `compact`)
- Modify: `src/index.ts` (add `modelLimit` to the `createSessionOps` deps)
- Test: `test/session-utils.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: SDK `session.messages({ path, query? })` (assistant `info.tokens = { input, output, reasoning, cache: { read, write } }`); `config.providers()` (`Provider.models[id].limit.context`); `SessionOpsDeps.modelLimit(threadId: string, model: string): Promise<number | undefined>`.
- Produces: `formatTokens(n: number): string` (`>= 1_000_000` → `"1.2m"`, `>= 1000` → rounded-to-one-decimal `"12.5k"`, else the integer); `formatContextUsage(used: number, limit: number, cells?: number): string` (`"<used>/<limit> (<pct>%)\n[<filled>…]"`, default 20 cells, `filled = round(used/limit * cells)` clamped); `SessionOps.contextUsage(threadId): Promise<{ used: number; limit: number } | "no-usage" | "no-limit">` where `used = input + output + cache.read + cache.write` of the last assistant message.

- [ ] **Step 1: Write the failing tests**

Append to `test/session-utils.test.ts` (add `formatContextUsage`, `formatTokens` to the import; every existing `createSessionOps` call also gains `modelLimit: async () => undefined`):

```ts
test("formatTokens renders plain, k, and m values", () => {
  expect(formatTokens(950)).toBe("950")
  expect(formatTokens(6000)).toBe("6k")
  expect(formatTokens(12500)).toBe("12.5k")
  expect(formatTokens(1250000)).toBe("1.3m")
})

test("formatContextUsage renders a 20-cell bar", () => {
  expect(formatContextUsage(50000, 100000)).toBe("50k/100k (50%)\n[██████████░░░░░░░░░░]")
  expect(formatContextUsage(1550, 200000)).toBe("1.6k/200k (1%)\n[░░░░░░░░░░░░░░░░░░░░]")
})

test("formatContextUsage clamps a full bar", () => {
  expect(formatContextUsage(200000, 100000)).toBe("200k/100k (200%)\n[████████████████████]")
})

test("contextUsage sums the last assistant tokens and reads the model limit", async () => {
  const limits: Array<[string, string]> = []
  const client = fakeClient({ session: { messages: async () => ({ data: [
    { info: { id: "m1", role: "user" } },
    { info: { id: "m2", role: "assistant", tokens: { input: 1000, output: 200, cache: { read: 300, write: 50 } } } },
    { info: { id: "m3", role: "assistant", tokens: { input: 4000, output: 500, cache: { read: 100, write: 0 } } } },
  ] }) } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client,
    threadModel: () => "anthropic/claude",
    modelLimit: async (threadId, model) => { limits.push([threadId, model]); return 200000 } })
  expect(await ops.contextUsage("t1")).toEqual({ used: 4600, limit: 200000 })
  expect(limits).toEqual([["t1", "anthropic/claude"]])
})

test("contextUsage reports no-usage and no-limit", async () => {
  const noUsage = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => fakeClient(),
    threadModel: () => "anthropic/claude", modelLimit: async () => 200000 })
  expect(await noUsage.contextUsage("t1")).toBe("no-usage")

  const withUsage = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => fakeClient({ session: {
    messages: async () => ({ data: [{ info: { id: "m2", role: "assistant", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } }] }),
  } }), threadModel: () => "anthropic/claude", modelLimit: async () => undefined })
  expect(await withUsage.contextUsage("t1")).toBe("no-limit")

  const noModel = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => fakeClient({ session: {
    messages: async () => ({ data: [{ info: { id: "m2", role: "assistant", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } }] }),
  } }), threadModel: () => null, modelLimit: async () => 200000 })
  expect(await noModel.contextUsage("t1")).toBe("no-limit")
})
```

Append to `test/commands.test.ts`:

```ts
test("context-usage renders the usage bar and the no-usage message", async () => {
  const db = fresh(); db.threads.upsert(threadRow("t1"))
  const ok = interaction({ commandName: "context-usage", channelId: "t1" })
  await handleCommand(ok, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { contextUsage: async () => ({ used: 50000, limit: 100000 }) } as any })
  expect(editOf(ok)).toBe("50k/100k (50%)\n[██████████░░░░░░░░░░]")

  const empty = interaction({ commandName: "context-usage", channelId: "t1" })
  await handleCommand(empty, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { contextUsage: async () => "no-usage" } as any })
  expect(editOf(empty)).toBe("no usage recorded for this thread yet")
})
```

Update the declared command set test:

```ts
expect(names).toEqual(["abort", "agent", "compact", "context-usage", "diff", "model", "new", "project", "queue", "redo", "resume", "share", "undo", "unshare"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-utils.test.ts -t "formatContextUsage"`
Expected: FAIL — `formatContextUsage is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `src/session-utils.ts`:

```ts
export interface SessionOpsDeps {
  targetFor(threadId: string): SessionTarget | undefined
  clientFor(threadId: string): OpencodeClient
  threadModel(threadId: string): string | null | undefined
  modelLimit(threadId: string, model: string): Promise<number | undefined>
}
```

```ts
  contextUsage(threadId: string): Promise<{ used: number; limit: number } | "no-usage" | "no-limit">
```

Add the formatters before `createSessionOps`:

```ts
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return String(n)
}

export function formatContextUsage(used: number, limit: number, cells = 20): string {
  const ratio = limit > 0 ? used / limit : 0
  const pct = Math.round(ratio * 100)
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)))
  return `${formatTokens(used)}/${formatTokens(limit)} (${pct}%)\n[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`
}
```

Add to `createSessionOps` after `compact`:

```ts
    async contextUsage(threadId) {
      const args = argsFor(deps, threadId)
      const messages = unwrap<unknown>(await deps.clientFor(threadId).session.messages(args))
      let last: any
      if (Array.isArray(messages)) {
        for (const message of messages as any[]) if (message?.info?.role === "assistant") last = message
      }
      if (!last) return "no-usage"
      const tokens = last.info?.tokens ?? {}
      const used = Number(tokens.input ?? 0) + Number(tokens.output ?? 0)
        + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0)
      const model = deps.threadModel(threadId)
      if (typeof model !== "string" || !model) return "no-limit"
      const limit = await deps.modelLimit(threadId, model)
      if (typeof limit !== "number" || limit <= 0) return "no-limit"
      return { used, limit }
    },
```

Add the command branch in `src/commands.ts` after `compact`:

```ts
if (interaction.commandName === "context-usage") {
  const thread = deps.db.threads.get(interaction.channelId)
  if (!thread) return void await interaction.editReply(noMentions("use /context-usage inside a thread"))
  if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
  const usage = await deps.sessions.contextUsage(thread.threadId)
  if (usage === "no-usage") return void await interaction.editReply(noMentions("no usage recorded for this thread yet"))
  if (usage === "no-limit") return void await interaction.editReply(noMentions("context limit unavailable for this model"))
  return void await interaction.editReply(noMentions(formatContextUsage(usage.used, usage.limit)))
}
```

Import the formatter in `src/commands.ts`:

```ts
import { formatContextUsage, formatDiff } from "./session-utils.js"
```

In `src/index.ts`, replace the existing `threadModel:` entry of the `createSessionOps` call (added in Task 6) with:

```ts
  threadModel: (threadId) => db.threads.get(threadId)?.model,
  modelLimit: async (threadId, model) => {
    const thread = db.threads.get(threadId)
    if (!thread) return undefined
    const project = db.projects.getByChannel(thread.channelId)
    if (!project) return undefined
    const slash = model.indexOf("/")
    if (slash <= 0) return undefined
    try {
      const res: any = await resolveClient(project).config.providers()
      const data = res?.data ?? res
      const provider = (data?.providers ?? []).find((p: any) => p?.id === model.slice(0, slash))
      const limit = provider?.models?.[model.slice(slash + 1)]?.limit?.context
      return typeof limit === "number" && limit > 0 ? limit : undefined
    } catch { return undefined }
  },
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-utils.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-utils.ts src/commands.ts src/index.ts test/session-utils.test.ts test/commands.test.ts
git commit -m "feat: add /context-usage with model context limit bar"
```

---

### Task 8: `src/autocomplete.ts` suggestion cache

**Files:**
- Create: `src/autocomplete.ts`
- Create: `test/autocomplete.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const SUGGESTION_LIMIT = 25`; `SuggestionCacheDeps { ttlMs: number; load(): Promise<string[]>; now(): number }`; `SuggestionCache { suggest(query: string): Promise<string[]> }`; `createSuggestionCache(deps: SuggestionCacheDeps): SuggestionCache`. Behavior: cold cache starts a background load and returns `[]`; loaded values are filtered case-insensitively by substring, deduped, values truncated to 100 chars; after `ttlMs` the stale values are served while a single background refresh runs; load failures are swallowed and the next `suggest` retries.

- [ ] **Step 1: Write the failing tests**

Create `test/autocomplete.test.ts`:

```ts
// test/autocomplete.test.ts
import { expect, test, vi } from "vitest"
import { createSuggestionCache } from "../src/autocomplete.ts"

test("cold cache returns [] while a background load runs", async () => {
  let resolveLoad!: (value: string[]) => void
  const load = vi.fn(() => new Promise<string[]>((resolve) => { resolveLoad = resolve }))
  const cache = createSuggestionCache({ ttlMs: 1000, load, now: () => 0 })
  await expect(cache.suggest("a")).resolves.toEqual([])
  await expect(cache.suggest("b")).resolves.toEqual([])
  expect(load).toHaveBeenCalledTimes(1)
  resolveLoad(["alpha", "beta"])
  await new Promise((resolve) => setTimeout(resolve, 0))
  await expect(cache.suggest("a")).resolves.toEqual(["alpha"])
})

test("filters case-insensitively, dedupes, and caps at 25", async () => {
  const values = Array.from({ length: 40 }, (_, i) => `model-${i}`)
  const cache = createSuggestionCache({ ttlMs: 1000, load: async () => values, now: () => 0 })
  await cache.suggest("")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await cache.suggest("model")).toHaveLength(25)
  expect(await cache.suggest("MODEL-3")).toEqual([
    "model-3", "model-30", "model-31", "model-32", "model-33", "model-34",
    "model-35", "model-36", "model-37", "model-38", "model-39",
  ])

  const dupes = createSuggestionCache({ ttlMs: 1000, load: async () => ["a", "a", "b"], now: () => 0 })
  await dupes.suggest("")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await dupes.suggest("")).toEqual(["a", "b"])
})

test("serves stale values while revalidating after the ttl", async () => {
  let t = 0
  let calls = 0
  const loads = [["old"], ["new"]]
  const load = vi.fn(async () => loads[Math.min(calls++, loads.length - 1)]!)
  const cache = createSuggestionCache({ ttlMs: 100, load, now: () => t })
  await cache.suggest("")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await cache.suggest("")).toEqual(["old"])
  t = 200
  expect(await cache.suggest("")).toEqual(["old"])
  expect(load).toHaveBeenCalledTimes(2)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await cache.suggest("")).toEqual(["new"])
})

test("a failed load leaves the cache cold and retries on the next suggest", async () => {
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce(["alpha"])
  const cache = createSuggestionCache({ ttlMs: 1000, load, now: () => 0 })
  await expect(cache.suggest("")).resolves.toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 0))
  await expect(cache.suggest("a")).resolves.toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(load).toHaveBeenCalledTimes(2)
  await expect(cache.suggest("a")).resolves.toEqual(["alpha"])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/autocomplete.test.ts`
Expected: FAIL — `Failed to resolve import "../src/autocomplete.ts"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/autocomplete.ts`:

```ts
export const SUGGESTION_LIMIT = 25

export interface SuggestionCacheDeps {
  ttlMs: number
  load(): Promise<string[]>
  now(): number
}

export interface SuggestionCache {
  suggest(query: string): Promise<string[]>
}

export function createSuggestionCache(deps: SuggestionCacheDeps): SuggestionCache {
  let values: string[] | null = null
  let loadedAt = 0
  let inflight = false
  const refresh = (): void => {
    if (inflight) return
    inflight = true
    void deps.load()
      .then((next) => {
        values = (Array.isArray(next) ? next : [])
          .map((value) => String(value).slice(0, 100))
          .filter((value) => value.length > 0)
        loadedAt = deps.now()
      })
      .catch(() => {})
      .finally(() => { inflight = false })
  }
  return {
    async suggest(query: string): Promise<string[]> {
      if (values === null) { refresh(); return [] }
      if (deps.now() - loadedAt >= deps.ttlMs) refresh()
      const q = query.trim().toLowerCase()
      const matches = q ? values.filter((value) => value.toLowerCase().includes(q)) : values
      const seen = new Set<string>()
      const out: string[] = []
      for (const value of matches) {
        if (seen.has(value)) continue
        seen.add(value)
        out.push(value)
        if (out.length >= SUGGESTION_LIMIT) break
      }
      return out
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/autocomplete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/autocomplete.ts test/autocomplete.test.ts
git commit -m "feat: add stale-while-revalidate autocomplete suggestion cache"
```

---

### Task 9: Autocomplete wiring for `/resume`, `/model`, `/agent`

**Files:**
- Modify: `src/commands.ts` (`commandData` `:22-27`, `CommandDeps` `:34-49`, new autocomplete helpers after `handleButton`, `handleCommand` model/agent/resume branches `:168-212`)
- Modify: `src/index.ts` (imports, caches + `suggest` after `listAgents` `:372-382`, `commandDeps`, `onInteraction` `:416-424`)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `createSuggestionCache`, `SuggestionCache` (Task 8); Discord `AutocompleteInteraction.options.getFocused()` and `interaction.respond(choices)` where each choice is `{ name: string; value: string }` (both ≤100 chars, ≤25 choices).
- Produces: `export interface AutocompleteChoice { name: string; value: string }`; `export const AUTOCOMPLETE_BUDGET_MS = 2500`; `export const AUTOCOMPLETE_MAX = 25`; `sanitizeAutocompleteChoices(choices: AutocompleteChoice[]): AutocompleteChoice[]`; `handleAutocomplete(interaction: any, deps: CommandDeps): Promise<void>`; `CommandDeps.suggest?(interaction: any, query: string): Promise<AutocompleteChoice[]>`. `/resume` gains an optional `session` option, `/model` a `model` option, `/agent` an `agent` option, all `autocomplete: true`; a provided value bypasses the select flow.

- [ ] **Step 1: Write the failing tests**

Append to `test/commands.test.ts`:

```ts
function autocompleteInteraction(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    commandName: over.commandName ?? "model",
    channelId: over.channelId ?? "t1",
    options: { getFocused: () => over.focused ?? "" },
    user: { id: "u1" },
    calls,
    respond: async (choices: any) => { calls.push({ kind: "respond", choices }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}

test("autocomplete options are declared for resume, model, and agent", () => {
  const commands = commandData()
  expect(commands.find((c: any) => c.name === "resume").options[0]).toMatchObject({ name: "session", autocomplete: true })
  expect(commands.find((c: any) => c.name === "model").options[0]).toMatchObject({ name: "model", autocomplete: true })
  expect(commands.find((c: any) => c.name === "agent").options[0]).toMatchObject({ name: "agent", autocomplete: true })
})

test("autocomplete responds with sanitized choices from suggest", async () => {
  const i = autocompleteInteraction({ commandName: "model", focused: "anth" })
  let captured: any
  await handleAutocomplete(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true,
    suggest: async (interaction: any, query: string) => { captured = { command: interaction.commandName, query }; return [
      { name: "anthropic/claude", value: "anthropic/claude" },
      { name: "", value: "dup" },
      { name: "dup", value: "dup" },
      { name: "x".repeat(150), value: "y".repeat(150) },
    ] } })
  expect(captured).toEqual({ command: "model", query: "anth" })
  expect(i.calls[0].choices).toEqual([
    { name: "anthropic/claude", value: "anthropic/claude" },
    { name: "dup", value: "dup" },
    { name: "x".repeat(100), value: "y".repeat(100) },
  ])
})

test("autocomplete responds [] when unauthorized or suggest rejects", async () => {
  const denied = autocompleteInteraction()
  await handleAutocomplete(denied, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => false,
    suggest: async () => { throw new Error("should not run") } })
  expect(denied.calls[0].choices).toEqual([])

  const failing = autocompleteInteraction()
  await handleAutocomplete(failing, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true,
    suggest: async () => { throw new Error("boom") } })
  expect(failing.calls[0].choices).toEqual([])
})

test("autocomplete responds within the budget when suggest hangs", async () => {
  vi.useFakeTimers()
  try {
    const i = autocompleteInteraction()
    const pending = handleAutocomplete(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true,
      suggest: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(AUTOCOMPLETE_BUDGET_MS)
    await pending
    expect(i.calls[0].choices).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

test("model and agent with a direct autocompleted value set the thread override", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const calls: any[] = []
  const modelInteraction = interaction({ commandName: "model", channelId: "t1", strings: { model: "anthropic/claude" } })
  await handleCommand(modelInteraction, { projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    setThreadModel: (id: string, model: string | null) => { calls.push(["model", id, model]) } })
  expect(calls).toEqual([["model", "t1", "anthropic/claude"]])
  expect(editOf(modelInteraction)).toBe("model set to anthropic/claude")

  const agentInteraction = interaction({ commandName: "agent", channelId: "t1", strings: { agent: "build" } })
  await handleCommand(agentInteraction, { projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    setThreadAgent: (id: string, agent: string | null) => { calls.push(["agent", id, agent]) } })
  expect(calls[1]).toEqual(["agent", "t1", "build"])
  expect(editOf(agentInteraction)).toBe("agent set to build")
})

test("resume with a direct session id creates the thread without a select", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = interaction({ commandName: "resume", channelId: "c", strings: { session: "s9" } })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    createThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s9" } } })
  expect(captured).toMatchObject({ channelId: "c", sessionId: "s9" })
  expect(editOf(i)).toBe("resumed in <#t9>")
})
```

Update the top imports (the file must now import `vi` for the budget test):

```ts
import { expect, test, vi } from "vitest"
import { AUTOCOMPLETE_BUDGET_MS, SELECT_OPTION_MAX, SELECT_OPTIONS_MAX, commandData, handleAutocomplete, handleButton, handleCommand, handleSelect, parseCustomIdFull, requiresOwner, sanitizeSelectOptions } from "../src/commands.ts"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts -t "autocomplete"`
Expected: FAIL — `handleAutocomplete is not a function`; options are missing.

- [ ] **Step 3: Write the minimal implementation**

In `src/commands.ts`, extend `commandData()`:

```ts
    { name: "resume", description: "Resume a session", options: [
      { type: ApplicationCommandOptionType.String, name: "session", description: "Session to resume (autocomplete)", autocomplete: true } ] },
```

```ts
    { name: "model", description: "Choose the model for this thread", options: [
      { type: ApplicationCommandOptionType.String, name: "model", description: "provider/model (autocomplete)", autocomplete: true } ] },
    { name: "agent", description: "Choose the agent for this thread", options: [
      { type: ApplicationCommandOptionType.String, name: "agent", description: "Agent name (autocomplete)", autocomplete: true }] },
```

Add to `CommandDeps` (the `sessions?: SessionOps` field already exists from Task 3):

```ts
  suggest?(interaction: any, query: string): Promise<AutocompleteChoice[]>
```

Add the autocomplete helpers after `handleButton`:

```ts
export interface AutocompleteChoice { name: string; value: string }
export const AUTOCOMPLETE_BUDGET_MS = 2500
export const AUTOCOMPLETE_MAX = 25

export function sanitizeAutocompleteChoices(choices: AutocompleteChoice[]): AutocompleteChoice[] {
  const seen = new Set<string>()
  const out: AutocompleteChoice[] = []
  for (const choice of choices) {
    const value = choice?.value == null ? "" : String(choice.value).slice(0, SELECT_OPTION_MAX)
    const rawName = choice?.name == null ? value : String(choice.name).slice(0, SELECT_OPTION_MAX)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ name: rawName || value, value })
    if (out.length >= AUTOCOMPLETE_MAX) break
  }
  return out
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) },
    )
  })
}

export async function handleAutocomplete(interaction: any, deps: CommandDeps): Promise<void> {
  let choices: AutocompleteChoice[] = []
  try {
    if (deps.authorized(interaction) && deps.suggest) {
      const focused = interaction.options?.getFocused?.()
      const query = typeof focused === "string" ? focused : ""
      choices = sanitizeAutocompleteChoices((await withBudget(deps.suggest(interaction, query), AUTOCOMPLETE_BUDGET_MS)) ?? [])
    }
  } catch {}
  try { await interaction.respond(choices) } catch {}
}
```

In the `resume` branch of `handleCommand`, handle the direct value before the select flow:

```ts
    if (interaction.commandName === "resume") {
      const project = deps.db.projects.getByChannel(interaction.channelId)
      if (!project) return void await interaction.editReply(noMentions("this channel is not a project"))
      const direct = interaction.options.getString("session", false)
      if (direct) {
        const existing = deps.db.threads.getBySession(direct)[0]
        const thread = await deps.createThread?.({ channelId: project.channelId, title: existing?.title ?? `resume ${new Date().toISOString()}`, sessionId: direct, authorId: interaction.user?.id })
        return void await interaction.editReply(noMentions(thread ? `resumed in <#${thread.threadId}>` : "resume unavailable"))
      }
      const sessions = (await deps.listSessions?.(project.channelId)) ?? []
```

The existing select flow continues unchanged after that.

In the `model`/`agent` branch, handle the direct value after `ensureReady`:

```ts
      const direct = interaction.options.getString(interaction.commandName, false)
      if (direct) {
        if (interaction.commandName === "model") deps.setThreadModel?.(thread.threadId, direct)
        else deps.setThreadAgent?.(thread.threadId, direct)
        return void await interaction.editReply(noMentions(`${interaction.commandName} set to ${direct}`))
      }
```

In `src/index.ts`, add imports:

```ts
import { commandData, handleAutocomplete, handleButton, handleCommand, handleSelect } from "./commands.js"
import { createSuggestionCache } from "./autocomplete.js"
import type { SuggestionCache } from "./autocomplete.js"
```

Add the cache registry and `suggest` after `listAgents`:

```ts
const suggestionCaches = new Map<string, SuggestionCache>()
const suggestionCacheFor = (key: string, load: () => Promise<string[]>): SuggestionCache => {
  let cache = suggestionCaches.get(key)
  if (!cache) {
    cache = createSuggestionCache({ ttlMs: 60_000, load, now: () => Date.now() })
    suggestionCaches.set(key, cache)
  }
  return cache
}
const suggest = async (interaction: any, query: string): Promise<{ name: string; value: string }[]> => {
  if (interaction.commandName === "resume") {
    const channelId = interaction.channelId
    const cache = suggestionCacheFor(`resume:${channelId}`, async () => (await listSessions(channelId)).map((session) => session.id))
    return (await cache.suggest(query)).map((value) => ({ name: value, value }))
  }
  const thread = db.threads.get(interaction.channelId)
  const channelId = thread?.channelId ?? interaction.channelId
  if (interaction.commandName === "model") {
    const cache = suggestionCacheFor(`models:${channelId}`, async () => (await listModels(channelId)).map((model) => model.id))
    return (await cache.suggest(query)).map((value) => ({ name: value, value }))
  }
  if (interaction.commandName === "agent") {
    const cache = suggestionCacheFor(`agents:${channelId}`, async () => (await listAgents(channelId)).map((agent) => agent.id))
    return (await cache.suggest(query)).map((value) => ({ name: value, value }))
  }
  return []
}
```

Add `suggest` to `commandDeps` and handle autocomplete in `onInteraction`:

```ts
    setThreadModel, setThreadAgent,
    sessions, suggest,
```

```ts
      if (interaction.isAutocomplete()) { await handleAutocomplete(interaction, commandDeps); return }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/autocomplete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts src/index.ts test/commands.test.ts
git commit -m "feat: autocomplete resume, model, and agent"
```

---

### Task 10: Per-channel default model and agent

**Files:**
- Modify: `src/helpers.ts` (add `seedThreadDefaults`)
- Modify: `src/index.ts` (re-export `:26`, `registerThread` `:154-164`, `setChannelModel`/`setChannelAgent` near `setThreadModel` `:383-384`, `commandDeps` `:386-400`)
- Modify: `src/commands.ts` (`CommandDeps`, `handleCommand` model/agent branch, `handleSelect` `MODEL_SELECT`/`AGENT_SELECT`)
- Test: `test/wiring.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `settings` keys `default_model:<channelId>` / `default_agent:<channelId>`; existing global `default_model` / `default_agent`.
- Produces: `seedThreadDefaults(get: (key: string) => string | undefined, channelId: string): { model: string | null; agent: string | null }` (channel key → global key → `null`); `CommandDeps.setChannelModel?(channelId: string, model: string | null): void`; `CommandDeps.setChannelAgent?(channelId: string, agent: string | null): void`. `/model` and `/agent` in a project channel show selects whose custom-id `id` is the channel id and set the channel default; in a thread they keep the thread override. New threads seed `registerThread` from the channel default first.

- [ ] **Step 1: Write the failing tests**

Append to `test/wiring.test.ts` (add `seedThreadDefaults` to the `../src/index.ts` import):

```ts
test("seedThreadDefaults prefers the channel default then the global default", () => {
  const settings: Record<string, string> = {
    default_model: "global/model",
    default_agent: "global-agent",
    "default_model:c1": "channel/model",
    "default_agent:c1": "channel-agent",
  }
  expect(seedThreadDefaults((key) => settings[key], "c1")).toEqual({ model: "channel/model", agent: "channel-agent" })
  expect(seedThreadDefaults((key) => settings[key], "c2")).toEqual({ model: "global/model", agent: "global-agent" })
  expect(seedThreadDefaults(() => undefined, "c1")).toEqual({ model: null, agent: null })
})
```

Append to `test/commands.test.ts`:

```ts
test("model in a project channel offers a channel-scoped provider select", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = interaction({ commandName: "model", channelId: "c" })
  await handleCommand(i, { projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude" }] })
  const edit = editOf(i)
  expect(edit.content).toBe("Choose a provider for this channel:")
  expect(edit.components[0].components[0].custom_id).toBe("celly:model-provider:c")
})

test("selecting a channel model stores it as a channel default", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = select({ customId: "celly:model:c", values: ["openai/gpt"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setChannelModel: (id: string, model: string | null) => { set = [id, model] } })
  expect(set).toEqual(["c", "openai/gpt"])
  expect(i.calls[1].c).toMatchObject({ content: "channel model set to openai/gpt", components: [] })
})

test("selecting a channel agent stores it as a channel default", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = select({ customId: "celly:agent:c", values: ["build"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setChannelAgent: (id: string, agent: string | null) => { set = [id, agent] } })
  expect(set).toEqual(["c", "build"])
  expect(i.calls[1].c).toMatchObject({ content: "channel agent set to build", components: [] })
})

test("model and agent in a non-project channel are rejected", async () => {
  for (const commandName of ["model", "agent"] as const) {
    const i = interaction({ commandName, channelId: "c" })
    await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
    expect(editOf(i)).toBe("this channel is not a project")
  }
})

test("model in a project channel with a direct value sets the channel default", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = interaction({ commandName: "model", channelId: "c", strings: { model: "anthropic/claude" } })
  let set: any
  await handleCommand(i, { projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    setChannelModel: (id: string, model: string | null) => { set = [id, model] } })
  expect(set).toEqual(["c", "anthropic/claude"])
  expect(editOf(i)).toBe("channel model set to anthropic/claude")
})
```

Replace the existing `"model outside a thread is rejected"` test with the new `"model and agent in a non-project channel are rejected"` test above (delete the old one). Also update the existing `"selecting an agent updates the thread"` test so `t1` resolves to a thread: add `db.threads.upsert(threadRow("t1"))` after `db.projects.insertProvisioning(proj)` (the new scope check falls back to a channel default when no thread row exists).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/wiring.test.ts -t "seedThreadDefaults"`
Expected: FAIL — `seedThreadDefaults is not a function`; command tests return `use /model inside a thread` and no channel default is set.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/helpers.ts`:

```ts
export function seedThreadDefaults(
  get: (key: string) => string | undefined,
  channelId: string,
): { model: string | null; agent: string | null } {
  return {
    model: get(`default_model:${channelId}`) ?? get("default_model") ?? null,
    agent: get(`default_agent:${channelId}`) ?? get("default_agent") ?? null,
  }
}
```

In `src/index.ts`, add it to the helpers import and the re-export list:

```ts
import { buildPromptText, channelIdForBucket, createSubscriptionGate, describeDiscordStartupError, findCategoryId, formatStartupBanner, projectForChannel, sanitizeChannelName, seedThreadDefaults, sessionIdFrom, uniqueChannelName } from "./helpers.js"
```

```ts
export { buildPromptText, createSubscriptionGate, findCategoryId, projectForChannel, sanitizeChannelName, seedThreadDefaults, sessionIdFrom, uniqueChannelName } from "./helpers.js"
```

Change `registerThread` seeding:

```ts
  const registerThread = (project: Project, threadId: string, title: string, sessionId: string): Thread => {
    const now = Date.now()
    const defaults = seedThreadDefaults((key) => db.settings.get(key), project.channelId)
    const record: Thread = {
      threadId, channelId: project.channelId, sessionId, title,
      model: defaults.model, agent: defaults.agent,
      worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: now, lastActiveAt: now,
    }
    db.threads.upsert(record)
    registerSession(threadId, sessionId)
    return record
  }
```

Add channel setters next to the thread setters:

```ts
  const setThreadModel = (threadId: string, model: string | null): void => { if (db.threads.get(threadId)) db.threads.setModel(threadId, model) }
  const setThreadAgent = (threadId: string, agent: string | null): void => { if (db.threads.get(threadId)) db.threads.setAgent(threadId, agent) }
  const setChannelModel = (channelId: string, model: string | null): void => {
    if (!model || !db.projects.getByChannel(channelId)) return
    db.settings.set(`default_model:${channelId}`, model)
  }
  const setChannelAgent = (channelId: string, agent: string | null): void => {
    if (!agent || !db.projects.getByChannel(channelId)) return
    db.settings.set(`default_agent:${channelId}`, agent)
  }
```

Add them to `commandDeps`:

```ts
    setThreadModel, setThreadAgent, setChannelModel, setChannelAgent,
```

In `src/commands.ts`, add the deps:

```ts
  setThreadModel?(threadId: string, model: string | null): void
  setThreadAgent?(threadId: string, agent: string | null): void
  setChannelModel?(channelId: string, model: string | null): void
  setChannelAgent?(channelId: string, agent: string | null): void
```

Rewrite the `model`/`agent` command branch in `handleCommand`:

```ts
    if (interaction.commandName === "model" || interaction.commandName === "agent") {
      const thread = deps.db.threads.get(interaction.channelId)
      const channelProject = thread ? undefined : deps.db.projects.getByChannel(interaction.channelId)
      const scope = thread ? thread.threadId : channelProject ? interaction.channelId : undefined
      if (!scope) return void await interaction.editReply(noMentions("this channel is not a project"))
      // Spec §9: wake the sandbox before asking it for models/agents.
      await deps.projects.ensureReady?.(thread?.channelId ?? interaction.channelId)
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
      if (interaction.commandName === "model") {
        const models = (await deps.listModels?.(thread?.channelId ?? interaction.channelId)) ?? []
        if (!models.length) return void await interaction.editReply(noMentions("no models available"))
        // Discord select menus cap at 25 options, and a flattened model list
        // across every provider overflows it. Offer providers first, then that
        // provider's models, so no provider is unreachable.
        const providers = new Map<string, number>()
        for (const m of models) {
          if (typeof m?.id !== "string" || !m.id) continue
          const slash = m.id.indexOf("/")
          const provider = slash > 0 ? m.id.slice(0, slash) : m.id
          if (!provider) continue
          providers.set(provider, (providers.get(provider) ?? 0) + 1)
        }
        const options = [...providers.entries()].map(([provider, count]) => ({ label: `${provider} (${count})`, value: provider }))
        if (!options.length) return void await interaction.editReply(noMentions("no models available"))
        const where = thread ? "thread" : "channel"
        return void await interaction.editReply({ content: `Choose a provider for this ${where}:`, components: [selectRow(selectCustomId(MODEL_PROVIDER_SELECT, scope), "Select a provider", options)], allowedMentions: { parse: [] } })
      }
      const agents = (await deps.listAgents?.(thread?.channelId ?? interaction.channelId)) ?? []
      if (!agents.length) return void await interaction.editReply(noMentions("no agents available"))
      const options = agents.slice(0, 25).map((a) => ({ label: (a.name || a.id).slice(0, 100), value: a.id }))
      const where = thread ? "thread" : "channel"
      return void await interaction.editReply({ content: `Choose an agent for this ${where}:`, components: [selectRow(selectCustomId(AGENT_SELECT, scope), "Select an agent", options)], allowedMentions: { parse: [] } })
    }
```

Rewrite the select branches in `handleSelect`:

```ts
    if (action === MODEL_SELECT) {
      const scope = id ?? interaction.channelId
      if (deps.db.threads.get(scope)) {
        deps.setThreadModel?.(scope, value ?? null)
        return void await interaction.editReply({ content: `model set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
      }
      deps.setChannelModel?.(scope, value ?? null)
      return void await interaction.editReply({ content: `channel model set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
    }
    if (action === AGENT_SELECT) {
      const scope = id ?? interaction.channelId
      if (deps.db.threads.get(scope)) {
        deps.setThreadAgent?.(scope, value ?? null)
        return void await interaction.editReply({ content: `agent set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
      }
      deps.setChannelAgent?.(scope, value ?? null)
      return void await interaction.editReply({ content: `channel agent set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
    }
```

The `MODEL_PROVIDER_SELECT` branch already falls back to `interaction.channelId` when no thread row matches `id`, so channel-scoped provider selects work unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/wiring.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/helpers.ts src/index.ts src/commands.ts test/wiring.test.ts test/commands.test.ts
git commit -m "feat: per-channel default model and agent"
```

---

### Task 11: Tool titles and elapsed time in the renderer

**Files:**
- Modify: `src/events.ts` (`NormalizedEvent` `:6`, `partToEvent` `:30`)
- Modify: `src/render.ts` (helpers near `sanitizeThreadName`, fields `:98-107`, `push` `:122-134`, `finalize` `:178`)
- Test: `test/events.test.ts`, `test/render.test.ts`

**Interfaces:**
- Consumes: SDK `ToolState` (`part.state.status`, `part.state.title` on running/completed states).
- Produces: `NormalizedEvent` tool variant gains `title?: string`; tool lines render as `> [name] status · title` with the title truncated to 120 chars (`119` + `…` when longer); `Renderer.elapsedMs(): number` (0 before the first push; `endedAt ?? now` minus the first `push` time; `finalize()` records `endedAt`). `setFooter` is NOT added here (providers-and-cost owns it).

- [ ] **Step 1: Write the failing tests**

Append to `test/events.test.ts`:

```ts
test("normalizes tool titles from running and completed states", () => {
  expect(normalizeEvent({ type: "message.part.updated", properties: { part: { id: "p2", messageID: "m1", sessionID: "s1", type: "tool", tool: "bash", state: { status: "running", title: "npm test" } } } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p2", name: "bash", status: "running", title: "npm test" })
  expect(partToEvent("s1", "m1", { id: "p3", type: "tool", tool: "edit", state: { status: "completed", title: "wrote src/a.ts" } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p3", name: "edit", status: "completed", title: "wrote src/a.ts" })
})

test("omits the tool title when the state has none", () => {
  expect(partToEvent("s1", "m1", { id: "p4", type: "tool", tool: "bash", state: { status: "running" } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p4", name: "bash", status: "running" })
})
```

Append to `test/render.test.ts`:

```ts
test("renderer renders tool lines with a title truncated to 120 chars", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p1", name: "bash", status: "running", title: "npm test" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p2", name: "edit", status: "completed", title: "x".repeat(200) })
  await r.finalize()
  expect(sends).toEqual([`> [bash] running · npm test\n> [edit] completed · ${"x".repeat(119)}…`])
})

test("renderer tool lines without a title stay byte-compatible", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p1", name: "bash", status: "running" })
  await r.finalize()
  expect(sends).toEqual(["> [bash] running"])
})

test("renderer reports elapsed time from the first push to finalize", async () => {
  let t = 100
  const r = new Renderer({ send: async () => "m1", edit: async () => {}, now: () => t, intervalMs: 1000 })
  expect(r.elapsedMs()).toBe(0)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a" })
  t = 150
  await r.finalize()
  expect(r.elapsedMs()).toBe(50)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/events.test.ts test/render.test.ts -t "title"`
Expected: FAIL — tool events lack `title`, renderer output is `> [bash] running` without ` · npm test`, `r.elapsedMs is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `src/events.ts`, change the tool variant:

```ts
  | { kind: "tool"; sessionId: string; messageId: string; partId: string; name: string; status: string; title?: string }
```

Change `partToEvent`'s tool branch:

```ts
  if (part.type === "tool") {
    const title = typeof part.state?.title === "string" && part.state.title ? part.state.title : undefined
    return { kind: "tool", sessionId, messageId, partId: part.id, name: part.tool ?? "tool", status: part.state?.status ?? "unknown", title }
  }
```

In `src/render.ts`, add a truncation helper near `sanitizeThreadName`:

```ts
export const TOOL_TITLE_MAX = 120
function truncateToolTitle(title: string, max = TOOL_TITLE_MAX): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title
}
```

Add renderer timing fields after `revision`:

```ts
  private startedAt: number | null = null
  private endedAt: number | null = null
```

Add the public method and change the tool branch in `push`:

```ts
  elapsedMs(): number {
    const end = this.endedAt ?? this.deps.now()
    const start = this.startedAt ?? end
    return Math.max(0, end - start)
  }
  push(e: NormalizedEvent): void {
    if (this.startedAt === null) this.startedAt = this.deps.now()
    if (e.kind === "text") {
```

```ts
    } else if (e.kind === "tool") {
      const title = e.title ? ` · ${truncateToolTitle(e.title)}` : ""
      this.tools.set(e.partId, `[${e.name}] ${e.status}${title}`)
      this.dirty = true
      this.revision++
    }
```

Change `finalize`:

```ts
  async finalize(): Promise<void> {
    await this.flush()
    this.endedAt = this.deps.now()
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/events.test.ts test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/render.ts test/events.test.ts test/render.test.ts
git commit -m "feat: stream tool titles and renderer elapsed time"
```

---

### Task 12: Docs and changeset

**Files:**
- Modify: `docs-site/reference/commands.mdx`
- Modify: `docs-site/reference/architecture.mdx`
- Modify: `README.md`
- Create: `.changeset/conversation-ux.md`

**Interfaces:**
- Consumes: every command and behavior from Tasks 1–11.
- Produces: no code.

- [ ] **Step 1: Update the commands reference**

In `docs-site/reference/commands.mdx`, replace the `/model` and `/agent` table rows with:

```md
| `/model` | authorized | Choose the model for this thread, or the channel default in a project channel (autocomplete or two-step provider → model). |
| `/agent` | authorized | Choose the agent for this thread, or the channel default in a project channel (autocomplete or select). |
| `/queue` | authorized | Show the first 10 queued prompts for this thread with Remove and Clear buttons (ephemeral). |
| `/undo` | authorized | Revert the session to its last user message. |
| `/redo` | authorized | Restore messages reverted by the last `/undo`. |
| `/diff` | authorized | List up to 10 changed files as `status path (+adds/-dels)` plus totals (chunked). |
| `/share` | authorized | Share the session and post the share URL. |
| `/unshare` | authorized | Stop sharing the session. |
| `/compact` | authorized | Summarize the session using the thread's model; errors when no model is set. |
| `/context-usage` | authorized | Show the last assistant message's token use against the model's context limit with a 20-cell bar (ephemeral). |
```

Replace the "Deferred to v1.1" section body with:

```md
Commands: `/project restart`.

Features: worktree-per-thread, `/btw` forks, permission-approval buttons,
`question` rendered as Discord components, voice messages, image attachments,
OpenCode web UI, tunnels/screenshare, multi-guild, cloud sandboxes, `--clone`
sandbox mode, OAuth subscription login, and Linux/macOS deployment docs.
```

- [ ] **Step 2: Update the architecture module map**

In `docs-site/reference/architecture.mdx`, add rows to the module map table after the `src/runner.ts` row:

```md
| `src/session-utils.ts` | Session-level SDK calls and formatting: undo/redo (`session.revert`/`unrevert`), diff, share/unshare, compact, context usage. |
| `src/autocomplete.ts` | Stale-while-revalidate suggestion cache backing slash-command autocomplete. |
```

- [ ] **Step 3: Update the README commands table and roadmap**

In `README.md`, replace the `/model` and `/agent` rows and add the new rows after them:

```md
| `/model` | thread or project channel | Choose the model for this thread or the channel default. |
| `/agent` | thread or project channel | Choose the agent for this thread or the channel default. |
| `/queue` | thread | Show and manage queued prompts for this thread. |
| `/undo` | thread | Revert the session to its last user message. |
| `/redo` | thread | Restore messages reverted by `/undo`. |
| `/diff` | thread | List changed files with `+adds/-dels` and totals. |
| `/share` | thread | Share the session and post the URL. |
| `/unshare` | thread | Stop sharing the session. |
| `/compact` | thread | Summarize the session with the thread's model. |
| `/context-usage` | thread | Token use against the model's context limit. |
```

In the "Status / roadmap" section, remove the commands bullet entries for `/share`, `/diff`, `/undo`, `/redo`, `/context-usage` and the "queue UI" mention from the thread/conversation bullet, leaving:

```md
- **Commands:** `/project restart`.
- **Thread/conversation:** worktree-per-thread, `/btw` forks, permission
  approval buttons, `question` as Discord components.
```

- [ ] **Step 4: Add the changeset**

Create `.changeset/conversation-ux.md`:

```md
---
"celly": minor
---

Add conversation UX: `/queue` with Remove/Clear buttons, `/undo`, `/redo`,
`/diff`, `/share`, `/unshare`, `/compact`, `/context-usage`, autocomplete for
`/resume`, `/model`, and `/agent`, per-channel default model/agent, and tool
titles with elapsed time in streamed replies.
```

- [ ] **Step 5: Verify docs and the full suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

Run: `npm run docs:validate`
Expected: `validation passed` (if the Mintlify CLI cannot reach the network in the executor environment, record that in the task notes and rely on the link checks below).

Run: `grep -n "context-usage" docs-site/reference/commands.mdx README.md`
Expected: one matching row per file; no match in the deferred/roadmap lists.

- [ ] **Step 6: Commit**

```bash
git add docs-site/reference/commands.mdx docs-site/reference/architecture.mdx README.md .changeset/conversation-ux.md
git commit -m "docs: document conversation UX commands and add changeset"
```

---

## Self-Review

**Spec coverage (spec §3.1, §3.3, §4.7):**

- Queue observability (`createdAt`, `queuedFor`, `removeQueued`, `clearQueued`) — Task 1.
- `/queue` ephemeral list (first 10) with `Remove` buttons (`celly:queue-remove:<threadId>:<index>`), `Clear` (`celly:queue-clear:<threadId>`), refresh after each action, stale-index copy `queue changed; run /queue again` — Task 2.
- `/undo` last `user` message via `session.messages` then `session.revert` with `query: { directory }` — Task 3.
- `/redo` `session.unrevert` — Task 3.
- `/diff` cap 10, `A`/`D`/`M` status, `(+adds/-dels)`, totals, `chunkMessage` — Task 4.
- `/share` posts the share URL; `/unshare` — Task 5.
- `/compact` with the thread model and exact `error: set a model with /model first` — Task 6.
- `/context-usage` last assistant tokens + `Model.limit.context` + 20-cell bar, ephemeral (all command replies are deferred `flags: 64`) — Task 7.
- Autocomplete cache `createSuggestionCache({ ttlMs, load, now })`, cold miss returns `[]`, SWR — Task 8.
- `isAutocomplete()` branch, `autocomplete: true` on `/resume`, `/model`, `/agent`, `/model` values `provider/model`, `/agent` values agent names, respond within budget — Task 9. (`/task add`-style channel options belong to the admin-and-ops plan; that command does not exist in this worktree.)
- Per-channel defaults `default_model:<channelId>`/`default_agent:<channelId>`, channel-vs-thread precedence, thread seeding — Task 10.
- Tool title in `NormalizedEvent` (`part.state.title`), `> [name] status · title` truncate 120, `startedAt`/`elapsedMs`; no `setFooter`, no cost/token persistence — Task 11.
- `parseCustomIdFull` per §3.1 with `parseCustomId` behavior preserved — Task 2.
- Docs rows, README table, changeset — Task 12.

**Placeholder scan:** no TBD/TODO/"similar to Task N"/"handle edge cases"; every step shows the exact test or implementation code and the exact run command.

**Type consistency:** `QueuedPrompt` (Task 1) is the element type used by `queuedFor` and Task 2's `queueMessage`; `buttonCustomId`/`parseCustomIdFull`/`SELECT_OPTION_MAX` are defined in Task 2 and reused in Task 9; `SessionOps` methods are added in the same tasks that test them (`undo`/`redo` T3, `diff` T4, `share`/`unshare` T5, `compact` T6, `contextUsage` T7) and every `createSessionOps` call gains new deps in the task that introduces them; `AutocompleteChoice` (Task 9) maps directly from `createSuggestionCache`'s `string[]` (Task 8); `seedThreadDefaults` (Task 10) is exported from `src/helpers.ts` and `src/index.ts`.

## Open Questions

1. `/queue` is thread-scoped. The spec fixes the custom-id format and staleness copy but not a project-channel aggregate view, so a channel invocation answers `use /queue inside a thread`.
2. Clearing a channel default (back to the global `default_model`) has no specified wire format; this plan only sets `default_*:<channelId>` and never deletes it.
3. `/share` can be refused by the opencode `share: "disabled"` policy; the command surfaces the raw `error: <message>`.
4. Autocomplete for `/task add`-style channel options is wired by the admin-and-ops plan (the command lands there); this plan only ships the cache and the `/resume`/`/model`/`/agent` wiring.
