# Providers, Cost Tracking, and OAuth Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-thread token/cost usage, render a cost footer, enforce a per-channel session budget, and let owners run provider OAuth (`/login`, `/login-code`) from Discord.

**Architecture:** `step-finish` and `message.updated` events normalize into a new `usage` `NormalizedEvent`; the `Runner` persists deltas through a new `db.usage` namespace, updates the renderer footer (`Renderer.setFooter`), and aborts a run that crosses the resolved budget. Commands read the same `db.usage` totals; OAuth lives in a small `src/oauth.ts` module over a minimal client interface so tests use fake clients. `sbx secret` management from Discord is deliberately deferred and only documented.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Node 24 (`node:sqlite`), discord.js 14.27, `@opencode-ai/sdk` 1.18.32, Vitest 3. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-27-vnext-features-design.md` (binding: §1, §2, §3.2, §3.3, §3.6, §4.8).

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process`; only `src/opencode.ts` and `src/projects.ts` may build `http://127.0.0.1:${...}` URLs.
- argv-only spawning: `shell: false`, `windowsHide: true`; never interpolate user input into a host shell string.
- Secrets (Discord token, server passwords, provider keys, OAuth codes/tokens) never in argv, logs, audit entries, or Discord messages. Redact through `src/log.ts`. This plan adds no audit writes.
- Style: double quotes, no statement semicolons, 2-space indent; flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, `../src/x.ts` imports.
- Migrations are append-only: never insert into or reorder `MIGRATIONS` in `src/db.ts`; append at the end. Tests assert behavior, not version numbers.
- Command changes update `docs-site/reference/commands.mdx` and the README commands table; config changes update `docs-site/guides/configuration.mdx` and `.env.example`; security-relevant changes update `docs-site/reference/security.mdx`.
- No new npm dependencies.
- Run `npm test`, `npm run typecheck`, and `npm run build` before every commit.
- **Deferred:** `sbx secret` management from Discord is documented as host-only in `docs-site/guides/providers.mdx` (Task 10). It is not implemented in this plan.
- **Owner gating:** reuse the existing `requiresOwner(commandName, sub)` pattern in `src/commands.ts:102` (returns true for `/budget`, `/login`, `/login-code`, and the existing owner-only `/project` subcommands). No new gating mechanism.

## Worktree

Create an isolated worktree before Task 1 via the `superpowers:using-git-worktrees` skill (native worktree fallback shown here):

```bash
git worktree add ../discordAI-providers-and-cost -b providers-and-cost main
cd ../discordAI-providers-and-cost
npm install
npm test
```

All paths below are relative to that worktree root. Do not commit to `main`. Merge the branch back only after all tasks pass.

## File Structure

**New files**

- `src/usage.ts` — pure formatting/budget helpers: `formatTokens`, `formatCost`, `formatUsageFooter`, `formatUsageSummary`, `resolveBudget`. No I/O, no SDK types.
- `src/oauth.ts` — provider OAuth over a minimal `OAuthClient` interface: `selectOAuthMethod`, `startProviderLogin`, `finishProviderLogin`.
- `test/usage.test.ts` — unit tests for the formatting helpers and `resolveBudget`.
- `test/oauth.test.ts` — fake-client tests for the OAuth module.
- `test/fixtures/opencode-usage-events.jsonl` — SSE fixture with `step-finish` and `message.updated` usage frames.
- `.changeset/providers-and-cost.md` — minor changeset.

**Modified files**

- `src/types.ts` — add `UsageTotals`.
- `src/events.ts` — new `usage` `NormalizedEvent` kind; `partToEvent` and `normalizeEvent` mapping.
- `src/db.ts` — append-only migration 7 (version reserved by the spec; idle-auto-stop uses 5, admin-and-ops uses 6); `db.threads.addUsage`; `db.usage.{thread,channel,totals}`.
- `src/render.ts` — `setFooter`, `elapsedMs`, `startedAt`/`endedAt`, `-# ` footer line.
- `src/config.ts` — `Config.sessionBudgetUsd` from `SESSION_BUDGET_USD`.
- `src/runner.ts` — usage persistence/footer branch; budget enforcement; `RunnerDeps.budgetUsd`/`notify`.
- `src/commands.ts` — `/cost`, `/budget`, `/login`, `/login-code`; `CommandDeps.startLogin`/`finishLogin`/`sessionBudgetUsd`; `requiresOwner` extension.
- `src/index.ts` — wire `budgetUsd`, `notify`, `sessionBudgetUsd`, `startLogin`, `finishLogin`.
- `test/events.test.ts`, `test/db.test.ts`, `test/render.test.ts`, `test/runner.test.ts`, `test/config.test.ts`, `test/commands.test.ts` — tests per task.
- Docs: `docs-site/reference/commands.mdx`, `docs-site/guides/providers.mdx`, `docs-site/guides/configuration.mdx`, `docs-site/reference/security.mdx`, `.env.example`, `README.md`.

---

### Task 1: Normalize usage events

**Files:**
- Modify: `src/events.ts:4-9` (union), `src/events.ts:27-32` (`partToEvent`), `src/events.ts:34-47` (`normalizeEvent`)
- Create: `test/fixtures/opencode-usage-events.jsonl`
- Test: `test/events.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `NormalizedEvent` gains `{ kind: "usage"; sessionId: string; messageId: string; cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }`. `partToEvent(sessionId, messageId, part)` maps `part.type === "step-finish"`. `step-finish` is the **single** usage source; `message.updated` is deliberately ignored (assistant messages carry cumulative cost/tokens and would double-count).

- [ ] **Step 1: Write the failing tests and fixture**

Add to `test/events.test.ts` (below the existing `partToEvent` test):

```ts
test("normalizes a step-finish part into a usage event", () => {
  expect(normalizeEvent({ type: "message.part.updated", properties: { part: {
    id: "p4", messageID: "m1", sessionID: "s1", type: "step-finish", reason: "stop",
    cost: 0.0123, tokens: { input: 1200, output: 3400, reasoning: 0, cache: { read: 10, write: 20 } },
  } } })).toEqual({ kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 10, cacheWrite: 20 })
})

test("partToEvent defaults missing step-finish token fields to zero", () => {
  expect(partToEvent("s1", "m1", { id: "p5", type: "step-finish", cost: 1 }))
    .toEqual({ kind: "usage", sessionId: "s1", messageId: "m1", cost: 1, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })
})

test("ignores message.updated usage so step-finish stays the single source", () => {
  expect(normalizeEvent({ type: "message.updated", properties: { info: {
    id: "m2", sessionID: "s1", role: "assistant", cost: 0.5,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 3, write: 4 } },
  } } })).toBeNull()
  expect(normalizeEvent({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant" } } })).toBeNull()
  expect(normalizeEvent({ type: "message.updated", properties: { info: {
    id: "m3", sessionID: "s1", role: "user", cost: 0,
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } } })).toBeNull()
})

test("dispatches the recorded usage fixtures over SSE", async () => {
  const fixture = readFileSync(new URL("./fixtures/opencode-usage-events.jsonl", import.meta.url), "utf8").trim().split("\n")
  const events: Array<{ threadId: string; e: any }> = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    for (const line of fixture) res.write(`data: ${line}\n\n`)
    res.end()
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const router = new EventRouter({
      route: (sessionId) => (sessionId.startsWith("ses_u") ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(`http://127.0.0.1:${port}`, "pw", ac.signal)
    await waitFor(() => events.length >= 2)
    ac.abort()
    await done
    expect(events).toEqual([
      { threadId: "t1", e: { kind: "usage", sessionId: "ses_u1", messageId: "msg_u1", cost: 0.01, tokensIn: 1000, tokensOut: 200, cacheRead: 100, cacheWrite: 50 } },
      { threadId: "t1", e: { kind: "usage", sessionId: "ses_u2", messageId: "msg_u2", cost: 0.0023, tokensIn: 200, tokensOut: 300, cacheRead: 0, cacheWrite: 0 } },
    ])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
```

Create `test/fixtures/opencode-usage-events.jsonl` with exactly these three lines:

```jsonl
{"type":"message.part.updated","properties":{"part":{"id":"prt_u1","messageID":"msg_u1","sessionID":"ses_u1","type":"step-finish","reason":"stop","cost":0.01,"tokens":{"input":1000,"output":200,"reasoning":0,"cache":{"read":100,"write":50}}}}}
{"type":"message.part.updated","properties":{"part":{"id":"prt_u2","messageID":"msg_u2","sessionID":"ses_u2","type":"step-finish","reason":"stop","cost":0.0023,"tokens":{"input":200,"output":300,"reasoning":0,"cache":{"read":0,"write":0}}}}}
{"type":"message.updated","properties":{"info":{"id":"msg_u3","sessionID":"ses_u3","role":"user","cost":0,"tokens":{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}}}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/events.test.ts`
Expected: FAIL — `normalizeEvent` returns `null` for `step-finish`; the fixture test only sees the old two events.

- [ ] **Step 3: Implement**

In `src/events.ts`, extend the union (keep existing kinds byte-compatible):

```ts
export type NormalizedEvent =
  | { kind: "text"; sessionId: string; messageId: string; partId: string; text: string }
  | { kind: "tool"; sessionId: string; messageId: string; partId: string; name: string; status: string }
  | { kind: "usage"; sessionId: string; messageId: string; cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId: string; message: string }
  | { kind: "permission"; sessionId: string; permissionId: string; tool: string; patterns: string[] }
```

Extend `partToEvent`:

```ts
export function partToEvent(sessionId: string, messageId: string, part: any): NormalizedEvent | null {
  if (!part || typeof part !== "object") return null
  if (part.type === "text") return { kind: "text", sessionId, messageId, partId: part.id, text: part.text ?? "" }
  if (part.type === "tool") return { kind: "tool", sessionId, messageId, partId: part.id, name: part.tool ?? "tool", status: part.state?.status ?? "unknown" }
  if (part.type === "step-finish") return {
    kind: "usage", sessionId, messageId,
    cost: typeof part.cost === "number" ? part.cost : 0,
    tokensIn: part.tokens?.input ?? 0, tokensOut: part.tokens?.output ?? 0,
    cacheRead: part.tokens?.cache?.read ?? 0, cacheWrite: part.tokens?.cache?.write ?? 0,
  }
  return null
}
```

Do **not** add a `message.updated` case to `normalizeEvent`: assistant messages
carry cumulative cost/tokens and would double-count against `step-finish`. The
existing `default: return null` stays.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/events.test.ts`
Expected: PASS (all existing tests, including the original two-event fixture test, still pass).

- [ ] **Step 5: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/events.ts test/events.test.ts test/fixtures/opencode-usage-events.jsonl
git commit -m "feat: normalize usage events from step-finish"
```

---

### Task 2: Persist usage totals

**Files:**
- Modify: `src/types.ts:1-14` (add `UsageTotals`)
- Modify: `src/db.ts:1-33` (`Db` interface), `src/db.ts:61-66` (append migration 7 — version reserved by the spec), `src/db.ts:71-81` (row helpers), `src/db.ts:116-144` (`threads` + new `usage` namespace)
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface UsageTotals { cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }` in `src/types.ts`.
  - `db.threads.addUsage(threadId: string, delta: UsageTotals): void`.
  - `db.usage.thread(threadId: string): UsageTotals` (zeros for an unknown thread), `db.usage.channel(channelId: string): UsageTotals`, `db.usage.totals(): UsageTotals`.

- [ ] **Step 1: Write the failing tests**

Add to `test/db.test.ts` (the `threadRow` helper there is inline; reuse the row object literal style):

```ts
test("addUsage accumulates per-thread totals", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  expect(db.usage.thread("t1")).toEqual({ cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })
  db.threads.addUsage("t1", { cost: 0.5, tokensIn: 10, tokensOut: 2, cacheRead: 3, cacheWrite: 4 })
  db.threads.addUsage("t1", { cost: 0.25, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  expect(db.usage.thread("t1")).toEqual({ cost: 0.75, tokensIn: 11, tokensOut: 3, cacheRead: 3, cacheWrite: 4 })
})

test("usage aggregates per channel and across all threads", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.addUsage("t1", { cost: 0.1, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "other", sandboxName: "celly-other", hostPort: 4301 })
  db.threads.upsert({ threadId: "t2", channelId: "c2", sessionId: "s2", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.addUsage("t2", { cost: 0.2, tokensIn: 2, tokensOut: 2, cacheRead: 0, cacheWrite: 0 })
  expect(db.usage.channel("c1")).toEqual({ cost: 0.1, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  expect(db.usage.channel("c2").tokensIn).toBe(2)
  const totals = db.usage.totals()
  expect(totals.cost).toBeCloseTo(0.3)
  expect(totals.tokensIn).toBe(3)
  expect(totals.tokensOut).toBe(3)
})

test("thread upsert preserves accumulated usage", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const row = { threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 }
  db.threads.upsert(row)
  db.threads.addUsage("t1", { cost: 0.4, tokensIn: 4, tokensOut: 4, cacheRead: 0, cacheWrite: 0 })
  db.threads.upsert({ ...row, sessionId: "s2", lastActiveAt: 9 })
  expect(db.usage.thread("t1").cost).toBe(0.4)
  expect(db.usage.thread("t1").tokensIn).toBe(4)
})
```

Also in `test/db.test.ts`, delete the legacy literal version assertion if it is
still present (idle-auto-stop removes the same line; do not fail the task if it
is already gone):

```ts
    expect(Number((raw.prepare("PRAGMA user_version").get() as any).user_version)).toBe(4)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — `db.usage` is undefined and `db.threads.addUsage is not a function` (`TypeError`).

- [ ] **Step 3: Implement**

In `src/types.ts` add:

```ts
export interface UsageTotals {
  cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number
}
```

In `src/db.ts`, update the import and the `Db` interface:

```ts
import type { Project, ProjectStatus, RenderState, Thread, UsageTotals } from "./types.ts"
```

```ts
  threads: {
    // ...existing methods unchanged...
    addUsage(threadId: string, delta: UsageTotals): void
    // ...existing methods unchanged...
  }
  usage: {
    thread(threadId: string): UsageTotals
    channel(channelId: string): UsageTotals
    totals(): UsageTotals
  }
  settings: { get(key: string): string | undefined; set(key: string, value: string): void }
```

Append the migration at the **end** of `MIGRATIONS` (never reorder existing entries):

```ts
const SCHEMA_V7 = `
ALTER TABLE threads ADD COLUMN cost REAL NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN tokens_cache_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN tokens_cache_write INTEGER NOT NULL DEFAULT 0;
`
const MIGRATIONS: { version: number; up(raw: DatabaseSync): void }[] = [
  { version: 1, up: (raw) => raw.exec(SCHEMA_V1) },
  { version: 2, up: (raw) => raw.exec(SCHEMA_V2) },
  { version: 3, up: (raw) => raw.exec("ALTER TABLE threads ADD COLUMN live_message_ids TEXT") },
  { version: 4, up: (raw) => raw.exec("CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id)") },
  { version: 7, up: (raw) => raw.exec(SCHEMA_V7) },
]
```

Add row helpers next to `rowToProject`/`rowToThread`:

```ts
const ZERO_USAGE = (): UsageTotals => ({ cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })
const rowToUsage = (r: any): UsageTotals => ({
  cost: Number(r?.cost ?? 0), tokensIn: Number(r?.tokens_in ?? 0), tokensOut: Number(r?.tokens_out ?? 0),
  cacheRead: Number(r?.tokens_cache_read ?? 0), cacheWrite: Number(r?.tokens_cache_write ?? 0),
})
```

Add `addUsage` to the `threads` namespace:

```ts
      addUsage(threadId, delta) {
        raw.prepare(`UPDATE threads SET cost=cost+?, tokens_in=tokens_in+?, tokens_out=tokens_out+?, tokens_cache_read=tokens_cache_read+?, tokens_cache_write=tokens_cache_write+? WHERE thread_id=?`)
          .run(delta.cost, delta.tokensIn, delta.tokensOut, delta.cacheRead, delta.cacheWrite, threadId)
      },
```

Add the `usage` namespace after `threads`:

```ts
    usage: {
      thread(threadId) {
        const r = raw.prepare(`SELECT cost, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM threads WHERE thread_id=?`).get(threadId)
        return r ? rowToUsage(r) : ZERO_USAGE()
      },
      channel(channelId) {
        const r = raw.prepare(`SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens_in),0) AS tokens_in,
          COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(tokens_cache_read),0) AS tokens_cache_read,
          COALESCE(SUM(tokens_cache_write),0) AS tokens_cache_write FROM threads WHERE channel_id=?`).get(channelId)
        return rowToUsage(r)
      },
      totals() {
        const r = raw.prepare(`SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens_in),0) AS tokens_in,
          COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(tokens_cache_read),0) AS tokens_cache_read,
          COALESCE(SUM(tokens_cache_write),0) AS tokens_cache_write FROM threads`).get()
        return rowToUsage(r)
      },
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/types.ts src/db.ts test/db.test.ts
git commit -m "feat: persist per-thread usage totals"
```

---

### Task 3: Renderer footer and elapsed time

**Files:**
- Modify: `src/render.ts:98-179` (`Renderer` class)
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Renderer.setFooter(text: string): void` (appends `-# <text>` as the final `body()` line; empty string clears it) and `Renderer.elapsedMs(): number` (0 before the first `push`; from first `push` to `finalize`, frozen after finalize).

- [ ] **Step 1: Write the failing tests**

Add to `test/render.test.ts`:

```ts
test("renderer appends the footer as a final -# line", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {}, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hello" })
  r.setFooter("$0.0123 · 1.2k in / 3.4k out")
  await r.finalize()
  expect(sends).toEqual(["hello\n\n-# $0.0123 · 1.2k in / 3.4k out"])
})

test("renderer footers can be replaced and cleared", async () => {
  const edits: string[] = []
  const r = new Renderer({ initialMessageId: "m1", send: async () => "m1", edit: async (_id, c) => { edits.push(c) }, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hi" })
  r.setFooter("a")
  await r.finalize()
  r.setFooter("b")
  await r.finalize()
  r.setFooter("")
  await r.finalize()
  expect(edits).toEqual(["hi\n\n-# a", "hi\n\n-# b", "hi"])
})

test("elapsedMs measures from the first push to finalize", async () => {
  let t = 100
  const r = new Renderer({ send: async () => "m1", edit: async () => {}, now: () => t, intervalMs: 1000 })
  expect(r.elapsedMs()).toBe(0)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hi" })
  t = 350
  expect(r.elapsedMs()).toBe(250)
  await r.finalize()
  t = 9999
  expect(r.elapsedMs()).toBe(250)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/render.test.ts`
Expected: FAIL — `r.setFooter is not a function` and `r.elapsedMs is not a function`.

- [ ] **Step 3: Implement**

In `src/render.ts`, add fields to `Renderer`:

```ts
  private footer = ""
  private startedAt: number | null = null
  private endedAt: number | null = null
```

Change `body()` to append the footer last:

```ts
  private body(): string {
    const toolLines = [...this.tools.values()].map((t) => `> ${t}`).join("\n")
    const footer = this.footer ? `-# ${this.footer}` : ""
    return [toolLines, this.text, footer].filter(Boolean).join("\n\n")
  }
```

Record the start in `push` and add the two public methods:

```ts
  setFooter(text: string): void {
    const next = text.trim()
    if (next === this.footer) return
    this.footer = next
    this.dirty = true
    this.revision++
  }
  elapsedMs(): number {
    if (this.startedAt === null) return 0
    return (this.endedAt ?? this.deps.now()) - this.startedAt
  }
  push(e: NormalizedEvent): void {
    if (this.startedAt === null) this.startedAt = this.deps.now()
    if (e.kind === "text") {
      // ...existing body unchanged...
```

Record the end in `finalize`:

```ts
  async finalize(): Promise<void> {
    if (this.endedAt === null) this.endedAt = this.deps.now()
    await this.flush()
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/render.ts test/render.test.ts
git commit -m "feat: add renderer footer and elapsed time"
```

---

### Task 4: Usage persistence and footer in the Runner

**Files:**
- Create: `src/usage.ts`, `test/usage.test.ts`
- Modify: `src/runner.ts:1-7` (imports), `src/runner.ts:287-317` (`onEvent`)
- Modify: `test/runner.test.ts:132-146` (`makeDb` helper)
- Test: `test/usage.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `usage` `NormalizedEvent` (Task 1); `db.threads.addUsage`, `db.usage.thread` (Task 2); `Renderer.setFooter` (Task 3).
- Produces:
  - `formatTokens(n: number): string`, `formatCost(n: number): string`, `formatUsageFooter(t: UsageTotals): string`, `formatUsageSummary(label: string, t: UsageTotals): string`, `resolveBudget(settings: { get(key: string): string | undefined }, channelId: string, envBudget: number): number` in `src/usage.ts`.
  - `Runner.onEvent` handles `usage`: persists the delta, sets the footer to `formatUsageFooter(totals)`, ticks the renderer.

- [ ] **Step 1: Write the failing helper tests**

Create `test/usage.test.ts`:

```ts
// test/usage.test.ts
import { expect, test } from "vitest"
import { formatCost, formatTokens, formatUsageFooter, formatUsageSummary, resolveBudget } from "../src/usage.ts"

test("formats token counts compactly", () => {
  expect(formatTokens(0)).toBe("0")
  expect(formatTokens(999)).toBe("999")
  expect(formatTokens(1000)).toBe("1k")
  expect(formatTokens(1200)).toBe("1.2k")
  expect(formatTokens(1_200_000)).toBe("1.2M")
})

test("formats cost to four decimal places", () => {
  expect(formatCost(0)).toBe("$0.0000")
  expect(formatCost(0.01234)).toBe("$0.0123")
  expect(formatCost(1.5)).toBe("$1.5000")
})

test("builds the usage footer", () => {
  expect(formatUsageFooter({ cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 0, cacheWrite: 0 }))
    .toBe("$0.0123 · 1.2k in / 3.4k out")
  expect(formatUsageSummary("session", { cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 0, cacheWrite: 0 }))
    .toBe("session: $0.0123 · 1.2k in / 3.4k out")
})

test("resolveBudget prefers a finite non-negative channel override", () => {
  const store = new Map<string, string>([["budget_usd:c1", "2.5"]])
  const settings = { get: (k: string) => store.get(k) }
  expect(resolveBudget(settings, "c1", 1)).toBe(2.5)
  expect(resolveBudget(settings, "c2", 1)).toBe(1)
  store.set("budget_usd:c2", "bogus")
  expect(resolveBudget(settings, "c2", 1)).toBe(1)
  store.set("budget_usd:c2", "-1")
  expect(resolveBudget(settings, "c2", 1)).toBe(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/usage.test.ts`
Expected: FAIL — `Failed to resolve import "../src/usage.ts"`.

- [ ] **Step 3: Implement `src/usage.ts`**

```ts
import type { UsageTotals } from "./types.ts"

function scaled(value: number): number {
  return Math.round(value * 10) / 10
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) {
    const m = scaled(n / 1_000_000)
    if (m < 1000) return `${m}M`
  }
  if (n >= 1000) {
    const k = scaled(n / 1000)
    if (k < 1000) return `${k}k`
  }
  return String(Math.round(n))
}

export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return "$0.0000"
  return "$" + (Math.round(n * 10_000) / 10_000).toFixed(4)
}

export function formatUsageFooter(t: UsageTotals): string {
  return `${formatCost(t.cost)} · ${formatTokens(t.tokensIn)} in / ${formatTokens(t.tokensOut)} out`
}

export function formatUsageSummary(label: string, t: UsageTotals): string {
  return `${label}: ${formatUsageFooter(t)}`
}

export function resolveBudget(
  settings: { get(key: string): string | undefined },
  channelId: string,
  envBudget: number,
): number {
  const raw = settings.get(`budget_usd:${channelId}`)
  if (raw !== undefined) {
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return envBudget
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run test/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Runner test and extend the fake db**

In `test/runner.test.ts`, first extend `makeDb` (currently at `test/runner.test.ts:132`) to expose mutable usage and settings:

```ts
function makeDb(state = "running", threads: any[] = [], liveMessageId: string | null = null, liveMessageIds: string[] = []) {
  const states: string[] = []
  const ids = liveMessageIds.length ? liveMessageIds : (liveMessageId ? [liveMessageId] : [])
  const usage = { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 }
  const settings = new Map<string, string>()
  const db = {
    threads: {
      setRenderState(_t: string, s: string) { states.push(s) },
      touch() {},
      get() { return { renderState: state, liveMessageId, channelId: "c1" } },
      liveMessageIds() { return ids },
      setLiveMessages() {},
      byChannel() { return threads },
      addUsage(_t: string, d: any) {
        usage.cost += d.cost; usage.tokensIn += d.tokensIn; usage.tokensOut += d.tokensOut
        usage.cacheRead += d.cacheRead; usage.cacheWrite += d.cacheWrite
      },
    },
    usage: {
      thread() { return { ...usage } },
      channel() { return { ...usage } },
      totals() { return { ...usage } },
    },
    settings: { get: (k: string) => settings.get(k), set: (k: string, v: string) => { settings.set(k, v) } },
  } as any
  return { db, states, usage, settings }
}
```

Then add:

```ts
test("usage events persist totals and set the renderer footer", async () => {
  const { db, usage } = makeDb()
  const footers: string[] = []
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => ({ push: () => {}, tick: async () => {}, finalize: async () => {}, setFooter: (t: string) => { footers.push(t) } }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 10, cacheWrite: 20 })
  expect(usage).toMatchObject({ cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 10, cacheWrite: 20 })
  expect(footers).toEqual(["$0.0123 · 1.2k in / 3.4k out"])
})
```

- [ ] **Step 6: Run the Runner test to verify it fails**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — `db.threads.addUsage is not a function` (the `usage` branch does not exist; the event is ignored).

- [ ] **Step 7: Implement the Runner usage branch**

In `src/runner.ts` add the import:

```ts
import { formatUsageFooter } from "./usage.js"
```

Insert this branch into `onEvent` after the `text`/`tool` branch:

```ts
    } else if (e.kind === "usage") {
      db.threads.addUsage(threadId, { cost: e.cost, tokensIn: e.tokensIn, tokensOut: e.tokensOut, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite })
      const totals = db.usage.thread(threadId)
      const renderer = await this.rendererFor(threadId)
      renderer.setFooter(formatUsageFooter(totals))
      await renderer.tick()
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/usage.test.ts test/runner.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/usage.ts test/usage.test.ts src/runner.ts test/runner.test.ts
git commit -m "feat: track usage in the runner with a cost footer"
```

---

### Task 5: Session budget enforcement

**Files:**
- Modify: `src/config.ts:5-14` (interface), `src/config.ts:56-80` (`loadConfig`)
- Modify: `src/runner.ts:155-164` (`RunnerDeps`), `src/runner.ts:287-317` (`onEvent`), add `budgetFor`
- Modify: `src/index.ts:198-247` (Runner wiring)
- Test: `test/config.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `formatCost`, `resolveBudget` (Task 4); `usage` event + `db.usage` (Tasks 1–2).
- Produces: `Config.sessionBudgetUsd: number`; `RunnerDeps.budgetUsd?: number` (default 0) and `RunnerDeps.notify?(channelId: string, text: string): Promise<void> | void`; a run at `cost >= budget` appends `[budget] session budget reached ($X of $Y)`, warns the channel, and aborts. A per-channel `budget_usd:<channelId>` setting overrides the env seed.

- [ ] **Step 1: Write the failing config test**

Add to `test/config.test.ts`:

```ts
test("SESSION_BUDGET_USD defaults to 0 and rejects negatives and non-numbers", () => {
  expect(loadConfig(base).sessionBudgetUsd).toBe(0)
  expect(loadConfig({ ...base, SESSION_BUDGET_USD: "5.5" }).sessionBudgetUsd).toBe(5.5)
  expect(loadConfig({ ...base, SESSION_BUDGET_USD: "0" }).sessionBudgetUsd).toBe(0)
  expect(() => loadConfig({ ...base, SESSION_BUDGET_USD: "-1" })).toThrow(/SESSION_BUDGET_USD/)
  expect(() => loadConfig({ ...base, SESSION_BUDGET_USD: "lots" })).toThrow(/SESSION_BUDGET_USD/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `sessionBudgetUsd` is `undefined`; negative values are not rejected.

- [ ] **Step 3: Implement the config**

In `src/config.ts` add `sessionBudgetUsd: number` to `Config` and parse it in `loadConfig` before the return:

```ts
  const sessionBudgetUsd = num(env, "SESSION_BUDGET_USD", 0)
  if (sessionBudgetUsd < 0) throw new Error(`SESSION_BUDGET_USD must be >= 0, got "${env.SESSION_BUDGET_USD}"`)
```

Add to the returned object (next to `maxConcurrentRuns`):

```ts
    sessionBudgetUsd,
```

- [ ] **Step 4: Run the config test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Runner budget tests**

Add to `test/runner.test.ts`:

```ts
test("reaching the session budget stops the run, notes it, and warns the channel", async () => {
  vi.useFakeTimers()
  try {
    const { db } = makeDb("running")
    const pushed: any[] = []
    const notices: Array<[string, string]> = []
    const aborted: string[] = []
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async () => {}, abort: async (a: any) => { aborted.push(a.path.id) } } }) as any,
      createRenderer: async () => ({ push: (e: any) => pushed.push(e), tick: async () => {}, finalize: async () => {}, setFooter: () => {} }) as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4, budgetUsd: 0.005,
      notify: (channelId, text) => { notices.push([channelId, text]) } })
    await runner.prompt("t1", "go", "u")
    await runner.onEvent("t1", { kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.006, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
    const note = "[budget] session budget reached ($0.0060 of $0.0050)"
    expect(pushed.some((p) => p.kind === "text" && p.text === note)).toBe(true)
    expect(notices).toEqual([["c1", note]])
    expect(aborted).toEqual(["s1"])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runner.activeCount).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test("a disabled budget (0) never stops a run", async () => {
  const { db } = makeDb("running")
  let aborts = 0
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {}, abort: async () => { aborts++ } } }) as any,
    createRenderer: async () => ({ push: () => {}, tick: async () => {}, finalize: async () => {}, setFooter: () => {} }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "go", "u")
  await runner.onEvent("t1", { kind: "usage", sessionId: "s1", messageId: "m1", cost: 999, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  expect(aborts).toBe(0)
})

test("a per-channel budget setting overrides the env budget", async () => {
  const { db, settings } = makeDb("running")
  settings.set("budget_usd:c1", "0.002")
  const aborted: string[] = []
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {}, abort: async (a: any) => { aborted.push(a.path.id) } } }) as any,
    createRenderer: async () => ({ push: () => {}, tick: async () => {}, finalize: async () => {}, setFooter: () => {} }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4, budgetUsd: 100 })
  await runner.prompt("t1", "go", "u")
  await runner.onEvent("t1", { kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.003, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  expect(aborted).toEqual(["s1"])
})
```

- [ ] **Step 6: Run the Runner tests to verify they fail**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — no abort occurs, no `[budget]` line is pushed, `notices` is empty.

- [ ] **Step 7: Implement the budget**

In `src/runner.ts` update the import and `RunnerDeps`:

```ts
import { formatCost, formatUsageFooter, resolveBudget } from "./usage.js"
```

```ts
export interface RunnerDeps {
  db: Db
  clientFor(threadId: string): OpencodeClient
  createRenderer(threadId: string, liveMessageId?: string | null, liveMessageIds?: string[] | null): Promise<Renderer>
  sessionFor(threadId: string): Promise<string>
  log(msg: string, fields?: Record<string, unknown>): void
  maxQueue: number
  maxConcurrentRuns: number
  budgetUsd?: number
  notify?(channelId: string, text: string): Promise<void> | void
  onThreadIdle?(threadId: string): void
}
```

Add the private resolver near `idle`:

```ts
  private budgetFor(threadId: string): number {
    const thread = this.deps.db.threads.get(threadId)
    if (!thread) return this.deps.budgetUsd ?? 0
    return resolveBudget(this.deps.db.settings, thread.channelId, this.deps.budgetUsd ?? 0)
  }
```

Replace the Task 4 usage branch with the full version:

```ts
    } else if (e.kind === "usage") {
      db.threads.addUsage(threadId, { cost: e.cost, tokensIn: e.tokensIn, tokensOut: e.tokensOut, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite })
      const totals = db.usage.thread(threadId)
      const renderer = await this.rendererFor(threadId)
      renderer.setFooter(formatUsageFooter(totals))
      await renderer.tick()
      const budget = this.budgetFor(threadId)
      if (budget > 0 && totals.cost >= budget && db.threads.get(threadId)?.renderState !== "aborting") {
        const note = `[budget] session budget reached (${formatCost(totals.cost)} of ${formatCost(budget)})`
        renderer.push({ kind: "text", sessionId: e.sessionId, messageId: "", partId: `budget-${e.sessionId}`, text: note })
        await renderer.finalize()
        const thread = db.threads.get(threadId)
        if (thread) await this.deps.notify?.(thread.channelId, note)
        await this.abort(threadId)
      }
    }
```

- [ ] **Step 8: Run the Runner tests to verify they pass**

Run: `npx vitest run test/runner.test.ts test/config.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire the Runner in `src/index.ts`**

In the `new Runner({ ... })` call, add after `maxConcurrentRuns`:

```ts
    budgetUsd: cfg.sessionBudgetUsd,
    notify: async (channelId, text) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (channel && "send" in channel) await scheduleWithBucket(channelId, () => (channel as any).send(renderPayload(text))).catch(() => {})
    },
```

- [ ] **Step 10: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/config.ts src/runner.ts src/index.ts test/config.test.ts test/runner.test.ts
git commit -m "feat: enforce a session budget in the runner"
```

---

### Task 6: `/cost`

**Files:**
- Modify: `src/commands.ts:6-28` (`commandData`), `src/commands.ts:34-49` (`CommandDeps`), `src/commands.ts:106-226` (`handleCommand`)
- Modify: `src/index.ts:386-400` (`commandDeps`)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `db.usage.thread/channel` (Task 2); `formatCost`, `formatUsageSummary`, `resolveBudget` (Task 4); `Config.sessionBudgetUsd` (Task 5).
- Produces: `/cost` (ephemeral, thread or channel); `CommandDeps.sessionBudgetUsd?: number`. Output lines are exactly:
  - in a thread: `session: <summary>` / `channel: <summary>` / `budget: <cost>/session` or `budget: off`;
  - in a channel: the same without the `session:` line;
  - non-project channel: `this channel is not a project`.

- [ ] **Step 1: Write the failing tests**

In `test/commands.test.ts`, update the command-set assertion (existing test at line 57) and add cost tests:

```ts
test("declares the providers and cost command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "cost", "model", "new", "project", "resume"])
})

test("/cost in a thread reports session, channel, and budget", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  db.threads.addUsage("t1", { cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 0, cacheWrite: 0 })
  const i = interaction({ commandName: "cost", channelId: "t1", channel: { isThread: () => true } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, sessionBudgetUsd: 5 })
  expect(editOf(i)).toBe([
    "session: $0.0123 · 1.2k in / 3.4k out",
    "channel: $0.0123 · 1.2k in / 3.4k out",
    "budget: $5.0000/session",
  ].join("\n"))
})

test("/cost in a project channel reports the channel total and budget off", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  db.threads.addUsage("t1", { cost: 0.5, tokensIn: 500, tokensOut: 100, cacheRead: 0, cacheWrite: 0 })
  const i = interaction({ commandName: "cost", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toBe("channel: $0.5000 · 500 in / 100 out\nbudget: off")
})

test("/cost outside a project is rejected", async () => {
  const i = interaction({ commandName: "cost", channelId: "other" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("this channel is not a project")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — the command list lacks `cost`; `/cost` replies `not implemented in this build`.

- [ ] **Step 3: Implement**

In `src/commands.ts`, add imports:

```ts
import { formatCost, formatUsageSummary, resolveBudget } from "./usage.js"
```

Add the command to `commandData()` after the `agent` entry:

```ts
    { name: "cost", description: "Show session and channel cost" },
```

Add `sessionBudgetUsd?: number` to `CommandDeps`.

Add the channel resolver above `handleCommand`:

```ts
function commandProjectChannel(interaction: any, db: Db): string | undefined {
  if (interaction.channel?.isThread?.() === true) return db.threads.get(interaction.channelId)?.channelId
  return db.projects.getByChannel(interaction.channelId) ? interaction.channelId : undefined
}
```

Add the handler inside `handleCommand` (after the `abort` block, before the final fallback):

```ts
    if (interaction.commandName === "cost") {
      const channelId = commandProjectChannel(interaction, deps.db)
      if (!channelId) return void await interaction.editReply(noMentions("this channel is not a project"))
      const thread = interaction.channel?.isThread?.() === true ? deps.db.usage.thread(interaction.channelId) : undefined
      const budget = resolveBudget(deps.db.settings, channelId, deps.sessionBudgetUsd ?? 0)
      const lines = [
        thread ? formatUsageSummary("session", thread) : "",
        formatUsageSummary("channel", deps.db.usage.channel(channelId)),
        budget > 0 ? `budget: ${formatCost(budget)}/session` : "budget: off",
      ].filter(Boolean)
      return void await interaction.editReply(noMentions(lines.join("\n")))
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the config seed in `src/index.ts`**

Add `sessionBudgetUsd: cfg.sessionBudgetUsd,` to the `commandDeps` object (next to `listSessions, listModels, listAgents,`).

- [ ] **Step 6: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/commands.ts src/index.ts test/commands.test.ts
git commit -m "feat: add /cost"
```

---

### Task 7: `/budget show|set`

**Files:**
- Modify: `src/commands.ts:11-27` (`commandData`), `src/commands.ts:101-104` (`requiresOwner`), `src/commands.ts:106-226` (`handleCommand`)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `resolveBudget`, `formatCost` (Task 4); `CommandDeps.sessionBudgetUsd` (Task 6).
- Produces: `/budget show|set usd:<usd>` — owner-only via `requiresOwner`, channel-scoped through `commandProjectChannel`, stored in `settings` as `budget_usd:<channelId>`; `set 0` disables.

- [ ] **Step 1: Write the failing tests**

Update the command-set assertion in `test/commands.test.ts` to include `budget`, then add:

```ts
test("/budget set stores the channel override and show reports it", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const setI = interaction({ commandName: "budget", sub: "set", channelId: "c", numbers: { usd: 2.5 } })
  await handleCommand(setI, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, sessionBudgetUsd: 5 })
  expect(db.settings.get("budget_usd:c")).toBe("2.5")
  expect(editOf(setI)).toBe("budget set to $2.5000 per session")
  const showI = interaction({ commandName: "budget", sub: "show", channelId: "c" })
  await handleCommand(showI, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, sessionBudgetUsd: 5 })
  expect(editOf(showI)).toBe("session budget: $2.5000")
})

test("/budget set 0 disables the budget for the channel", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const setI = interaction({ commandName: "budget", sub: "set", channelId: "c", numbers: { usd: 0 } })
  await handleCommand(setI, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, sessionBudgetUsd: 5 })
  const showI = interaction({ commandName: "budget", sub: "show", channelId: "c" })
  await handleCommand(showI, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, sessionBudgetUsd: 5 })
  expect(editOf(showI)).toBe("session budget: off")
})

test("/budget is owner-only", async () => {
  const i = interaction({ commandName: "budget", sub: "show", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64, allowedMentions: { parse: [] } } })
})

test("requiresOwner covers the new owner-only commands", () => {
  expect(requiresOwner("budget", "show")).toBe(true)
  expect(requiresOwner("budget", "set")).toBe(true)
  expect(requiresOwner("login", null)).toBe(true)
  expect(requiresOwner("login-code", null)).toBe(true)
  expect(requiresOwner("cost", null)).toBe(false)
})
```

Also extend the `interaction` helper with `getNumber`:

```ts
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => strings[n],
      getNumber: (n: string) => (over.numbers ?? {})[n],
    },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `budget` is not in the command list, `/budget` is not gated and replies `not implemented in this build`.

- [ ] **Step 3: Implement**

In `src/commands.ts`, add the command after `cost`:

```ts
    { name: "budget", description: "Show or set this channel's session budget (owner-only)", options: [
      { type: ApplicationCommandOptionType.Subcommand, name: "show", description: "Show the current session budget" },
      { type: ApplicationCommandOptionType.Subcommand, name: "set", description: "Set the channel session budget in USD", options: [
        { type: ApplicationCommandOptionType.Number, name: "usd", description: "Budget in USD; 0 disables", required: true } ] },
    ] },
```

Update `requiresOwner`:

```ts
export function requiresOwner(commandName: string, sub: string | null | undefined): boolean {
  if (commandName === "project") return !!sub && OWNER_ONLY_PROJECT_SUBS.has(sub)
  return commandName === "budget" || commandName === "login" || commandName === "login-code"
}
```

Compute `sub` for budget too (currently only for project):

```ts
  const sub = interaction.commandName === "project" || interaction.commandName === "budget"
    ? interaction.options.getSubcommand(false)
    : null
```

Add the handler after the `cost` block:

```ts
    if (interaction.commandName === "budget") {
      const channelId = commandProjectChannel(interaction, deps.db)
      if (!channelId) return void await interaction.editReply(noMentions("this channel is not a project"))
      if (sub === "set") {
        const usd = interaction.options.getNumber("usd", true)
        if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return void await interaction.editReply(noMentions("error: usd must be a number >= 0"))
        deps.db.settings.set(`budget_usd:${channelId}`, String(usd))
        return void await interaction.editReply(noMentions(`budget set to ${formatCost(usd)} per session`))
      }
      const budget = resolveBudget(deps.db.settings, channelId, deps.sessionBudgetUsd ?? 0)
      return void await interaction.editReply(noMentions(budget > 0 ? `session budget: ${formatCost(budget)}` : "session budget: off"))
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/commands.ts test/commands.test.ts
git commit -m "feat: add /budget"
```

---

### Task 8: Provider OAuth `/login`

**Files:**
- Create: `src/oauth.ts`, `test/oauth.test.ts`
- Modify: `src/commands.ts:22-28` (`commandData`), `src/commands.ts:34-49` (`CommandDeps`), `src/commands.ts:106-226` (`handleCommand`)
- Modify: `src/index.ts:386-400` (`commandDeps`)
- Test: `test/oauth.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `@opencode-ai/sdk` types `Auth`, `ProviderAuthMethod`, `ProviderAuthAuthorization` (3.6 verified facts); the project client from `src/opencode.ts`.
- Produces:
  - `src/oauth.ts`: `interface OAuthClient { provider: { auth(options?: unknown): Promise<unknown>; oauth: { authorize(options: { path: { id: string }; body: { method: number } }): Promise<unknown>; callback(options: { path: { id: string }; body: { method: number; code?: string } }): Promise<unknown> } }; auth: { set(options: { path: { id: string }; body: Auth }): Promise<unknown> } }`, `interface OAuthDeps { client: OAuthClient; log(msg: string, fields?: Record<string, unknown>): void }`, `interface ProviderLogin { providerId: string; method: number; url: string; flow: "auto" | "code"; instructions: string }`, `selectOAuthMethod(methods: ProviderAuthMethod[] | undefined): number` (−1 when none), `startProviderLogin(deps: OAuthDeps, providerId: string): Promise<ProviderLogin>`.
  - `CommandDeps.startLogin?(channelId: string, providerId: string): Promise<{ url: string; instructions: string; flow: "auto" | "code" }>` and `/login provider:<id>`.

- [ ] **Step 1: Write the failing OAuth tests**

Create `test/oauth.test.ts`:

```ts
// test/oauth.test.ts
import { expect, test } from "vitest"
import { selectOAuthMethod, startProviderLogin } from "../src/oauth.ts"
import type { OAuthClient } from "../src/oauth.ts"

function fakeClient(over: any = {}) {
  const calls: any[] = []
  const client: OAuthClient = {
    provider: {
      auth: async () => over.authResponse ?? { anthropic: [{ type: "oauth", label: "Claude Pro" }, { type: "api", label: "API key" }] },
      oauth: {
        authorize: async (o) => { calls.push({ op: "authorize", o }); return over.authorizeResponse ?? { data: { url: "https://example.test/auth", method: "code", instructions: "Paste the code" } } },
        callback: async (o) => { calls.push({ op: "callback", o }); return over.callbackResponse ?? { data: true } },
      },
    },
  }
  return { client, calls }
}

test("selectOAuthMethod returns the oauth method index or -1", () => {
  expect(selectOAuthMethod([{ type: "api", label: "API key" }, { type: "oauth", label: "Pro" }])).toBe(1)
  expect(selectOAuthMethod([{ type: "api", label: "API key" }])).toBe(-1)
  expect(selectOAuthMethod(undefined)).toBe(-1)
})

test("startProviderLogin picks the oauth method and returns the authorization", async () => {
  const { client, calls } = fakeClient()
  const login = await startProviderLogin({ client, log: () => {} }, "anthropic")
  expect(login).toEqual({ providerId: "anthropic", method: 0, url: "https://example.test/auth", flow: "code", instructions: "Paste the code" })
  expect(calls).toEqual([{ op: "authorize", o: { path: { id: "anthropic" }, body: { method: 0 } } }])
})

test("startProviderLogin recognizes auto-method flows", async () => {
  const { client } = fakeClient({ authorizeResponse: { data: { url: "https://example.test/auth", method: "auto", instructions: "A browser window opened" } } })
  const login = await startProviderLogin({ client, log: () => {} }, "anthropic")
  expect(login.flow).toBe("auto")
})

test("startProviderLogin errors when the provider has no oauth method", async () => {
  const { client } = fakeClient({ authResponse: { anthropic: [{ type: "api", label: "API key" }] } })
  await expect(startProviderLogin({ client, log: () => {} }, "anthropic")).rejects.toThrow("no oauth method for anthropic")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/oauth.test.ts`
Expected: FAIL — `Failed to resolve import "../src/oauth.ts"`.

- [ ] **Step 3: Implement `src/oauth.ts`**

```ts
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk"

export interface OAuthClient {
  provider: {
    auth(options?: unknown): Promise<unknown>
    oauth: {
      authorize(options: { path: { id: string }; body: { method: number } }): Promise<unknown>
      callback(options: { path: { id: string }; body: { method: number; code?: string } }): Promise<unknown>
    }
  }
}

export interface OAuthDeps {
  client: OAuthClient
  log(msg: string, fields?: Record<string, unknown>): void
}

export interface ProviderLogin {
  providerId: string
  method: number
  url: string
  flow: "auto" | "code"
  instructions: string
}

function unwrap(response: unknown): any {
  return (response as any)?.data ?? response
}

export function selectOAuthMethod(methods: ProviderAuthMethod[] | undefined): number {
  return (methods ?? []).findIndex((m) => m?.type === "oauth")
}

export async function startProviderLogin(deps: OAuthDeps, providerId: string): Promise<ProviderLogin> {
  const methods = unwrap(await deps.client.provider.auth()) as Record<string, ProviderAuthMethod[]> | undefined
  const method = selectOAuthMethod(methods?.[providerId])
  if (method < 0) throw new Error(`no oauth method for ${providerId}`)
  const authorization = unwrap(await deps.client.provider.oauth.authorize({ path: { id: providerId }, body: { method } })) as ProviderAuthAuthorization
  if (!authorization?.url) throw new Error(`provider ${providerId} returned no authorization URL`)
  const flow: ProviderLogin["flow"] = authorization.method === "auto" ? "auto" : "code"
  deps.log("provider login started", { providerId, flow })
  return { providerId, method, url: authorization.url, flow, instructions: authorization.instructions ?? "" }
}
```

- [ ] **Step 4: Run the OAuth tests to verify they pass**

Run: `npx vitest run test/oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `/login` tests**

In `test/commands.test.ts`, update the command-set assertion to `["abort", "agent", "budget", "cost", "login", "login-code", "model", "new", "project", "resume"]` and add:

```ts
test("/login posts the authorization URL and the code hint", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = interaction({ commandName: "login", channelId: "c", strings: { provider: "anthropic" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true,
    startLogin: async () => ({ url: "https://example.test/auth", instructions: "Paste the code", flow: "code" }) })
  expect(editOf(i)).toBe("Authorize anthropic:\nhttps://example.test/auth\nPaste the code\nThen run `/login-code anthropic <code>` with the code shown by the provider.")
})

test("/login tells the user to verify an auto flow in the browser", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = interaction({ commandName: "login", channelId: "c", strings: { provider: "anthropic" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true,
    startLogin: async () => ({ url: "https://example.test/auth", instructions: "A browser window opened", flow: "auto" }) })
  expect(editOf(i)).toContain("Finish in the browser, then run `/login anthropic` again to verify.")
})

test("/login surfaces the no-oauth error", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = interaction({ commandName: "login", channelId: "c", strings: { provider: "anthropic" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true,
    startLogin: async () => { throw new Error("no oauth method for anthropic") } })
  expect(editOf(i)).toBe("error: no oauth method for anthropic")
})

test("/login is owner-only", async () => {
  const i = interaction({ commandName: "login", channelId: "c", strings: { provider: "anthropic" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only." } })
})
```

- [ ] **Step 6: Run the command tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — command list lacks `login`/`login-code`; `/login` replies `not implemented in this build`.

- [ ] **Step 7: Implement the command and wiring**

In `src/commands.ts`, add both commands to `commandData()`:

```ts
    { name: "login", description: "Authorize a provider with OAuth (owner-only)", options: [
      { type: ApplicationCommandOptionType.String, name: "provider", description: "Provider id, e.g. anthropic", required: true } ] },
    { name: "login-code", description: "Finish OAuth login with an authorization code (owner-only)", options: [
      { type: ApplicationCommandOptionType.String, name: "provider", description: "Provider id", required: true },
      { type: ApplicationCommandOptionType.String, name: "code", description: "Authorization code", required: true } ] },
```

Add to `CommandDeps`:

```ts
  startLogin?(channelId: string, providerId: string): Promise<{ url: string; instructions: string; flow: "auto" | "code" }>
  finishLogin?(channelId: string, providerId: string, code: string): Promise<void>
```

Add the handler after the budget block:

```ts
    if (interaction.commandName === "login") {
      const channelId = commandProjectChannel(interaction, deps.db)
      if (!channelId) return void await interaction.editReply(noMentions("this channel is not a project"))
      const providerId = interaction.options.getString("provider", true)
      if (!deps.startLogin) return void await interaction.editReply(noMentions("login unavailable"))
      const login = await deps.startLogin(channelId, providerId)
      const lines = [
        `Authorize ${providerId}:`,
        login.url,
        login.instructions,
        login.flow === "auto"
          ? `Finish in the browser, then run \`/login ${providerId}\` again to verify.`
          : `Then run \`/login-code ${providerId} <code>\` with the code shown by the provider.`,
      ].filter(Boolean)
      return void await interaction.editReply(noMentions(lines.join("\n")))
    }
```

In `src/index.ts`, add the import and wire the deps:

```ts
import { startProviderLogin } from "./oauth.js"
```

```ts
    startLogin: async (channelId, providerId) => {
      const project = db.projects.getByChannel(channelId)
      if (!project) throw new Error(`unknown project channel ${channelId}`)
      await projects.ensureReady(channelId)
      return startProviderLogin({ client: resolveClient(project), log: (msg, fields) => log.info(msg, fields) }, providerId)
    },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/oauth.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/oauth.ts src/commands.ts src/index.ts test/oauth.test.ts test/commands.test.ts
git commit -m "feat: add provider OAuth /login"
```

---

### Task 9: OAuth code flow `/login-code`

**Files:**
- Modify: `src/oauth.ts` (add `finishProviderLogin`)
- Modify: `src/commands.ts:106-226` (`handleCommand`)
- Modify: `src/index.ts:386-400` (`commandDeps`)
- Test: `test/oauth.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `OAuthClient`, `OAuthDeps`, `selectOAuthMethod` (Task 8); `CommandDeps.finishLogin` (declared in Task 8).
- Produces: `finishProviderLogin(deps: OAuthDeps, providerId: string, code: string): Promise<void>` — re-selects the `oauth` method via `provider.auth()`, calls `provider.oauth.callback({ path, body: { method, code } })`, throws `oauth callback for <provider> failed` unless the boolean result is `true` (the server persists the credentials; `auth.set` is not used for OAuth), and logs only `providerId`. `/login-code provider:<id> code:<code>` confirms with `logged in to <provider>`.

- [ ] **Step 1: Write the failing OAuth code-flow tests**

Add to `test/oauth.test.ts` (extend the import to include `finishProviderLogin`):

```ts
test("finishProviderLogin exchanges the code and reports success", async () => {
  const { client, calls } = fakeClient()
  await finishProviderLogin({ client, log: () => {} }, "anthropic", "the-code")
  expect(calls).toEqual([
    { op: "callback", o: { path: { id: "anthropic" }, body: { method: 0, code: "the-code" } } },
  ])
})

test("finishProviderLogin errors when the callback reports failure", async () => {
  const { client } = fakeClient({ callbackResponse: { data: false } })
  await expect(finishProviderLogin({ client, log: () => {} }, "anthropic", "the-code")).rejects.toThrow("oauth callback for anthropic failed")
})

test("finishProviderLogin errors when the provider has no oauth method", async () => {
  const { client } = fakeClient({ authResponse: { anthropic: [{ type: "api", label: "API key" }] } })
  await expect(finishProviderLogin({ client, log: () => {} }, "anthropic", "the-code")).rejects.toThrow("no oauth method for anthropic")
})

test("provider login never logs credentials", async () => {
  const lines: string[] = []
  const log = (msg: string, fields?: Record<string, unknown>) => { lines.push(JSON.stringify({ msg, fields })) }
  const { client } = fakeClient()
  await startProviderLogin({ client, log }, "anthropic")
  await finishProviderLogin({ client, log }, "anthropic", "FAKE_CODE")
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.join("\n")).not.toMatch(/FAKE_(REFRESH|ACCESS)_TOKEN|FAKE_CODE/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/oauth.test.ts`
Expected: FAIL — `finishProviderLogin` is not exported.

- [ ] **Step 3: Implement `finishProviderLogin`**

Append to `src/oauth.ts`:

```ts
export async function finishProviderLogin(deps: OAuthDeps, providerId: string, code: string): Promise<void> {
  const methods = unwrap(await deps.client.provider.auth()) as Record<string, ProviderAuthMethod[]> | undefined
  const method = selectOAuthMethod(methods?.[providerId])
  if (method < 0) throw new Error(`no oauth method for ${providerId}`)
  const ok = unwrap(await deps.client.provider.oauth.callback({ path: { id: providerId }, body: { method, code } }))
  if (ok !== true) throw new Error(`oauth callback for ${providerId} failed`)
  deps.log("provider login completed", { providerId })
}
```

- [ ] **Step 4: Run the OAuth tests to verify they pass**

Run: `npx vitest run test/oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `/login-code` tests**

Add to `test/commands.test.ts`:

```ts
test("/login-code completes the flow and confirms", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const finished: Array<[string, string, string]> = []
  const i = interaction({ commandName: "login-code", channelId: "c", strings: { provider: "anthropic", code: "abc123" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true,
    finishLogin: async (channelId, providerId, code) => { finished.push([channelId, providerId, code]) } })
  expect(finished).toEqual([["c", "anthropic", "abc123"]])
  expect(editOf(i)).toBe("logged in to anthropic")
})

test("/login-code replies error when the callback fails", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = interaction({ commandName: "login-code", channelId: "c", strings: { provider: "anthropic", code: "abc123" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true,
    finishLogin: async () => { throw new Error("oauth callback for anthropic failed") } })
  expect(editOf(i)).toBe("error: oauth callback for anthropic failed")
})

test("/login-code is owner-only", async () => {
  const i = interaction({ commandName: "login-code", channelId: "c", strings: { provider: "anthropic", code: "abc123" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only." } })
})
```

- [ ] **Step 6: Run the command tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `/login-code` replies `not implemented in this build`.

- [ ] **Step 7: Implement the command and wiring**

In `src/commands.ts`, add the handler after the `login` block:

```ts
    if (interaction.commandName === "login-code") {
      const channelId = commandProjectChannel(interaction, deps.db)
      if (!channelId) return void await interaction.editReply(noMentions("this channel is not a project"))
      const providerId = interaction.options.getString("provider", true)
      const code = interaction.options.getString("code", true)
      if (!deps.finishLogin) return void await interaction.editReply(noMentions("login unavailable"))
      await deps.finishLogin(channelId, providerId, code)
      return void await interaction.editReply(noMentions(`logged in to ${providerId}`))
    }
```

In `src/index.ts`, extend the import and add the dep:

```ts
import { finishProviderLogin, startProviderLogin } from "./oauth.js"
```

```ts
    finishLogin: async (channelId, providerId, code) => {
      const project = db.projects.getByChannel(channelId)
      if (!project) throw new Error(`unknown project channel ${channelId}`)
      await projects.ensureReady(channelId)
      await finishProviderLogin({ client: resolveClient(project), log: (msg, fields) => log.info(msg, fields) }, providerId, code)
    },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/oauth.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npm test && npm run typecheck && npm run build
git add src/oauth.ts src/commands.ts src/index.ts test/oauth.test.ts test/commands.test.ts
git commit -m "feat: add /login-code"
```

---

### Task 10: Docs and changeset

**Files:**
- Modify: `docs-site/reference/commands.mdx`
- Modify: `docs-site/guides/providers.mdx`
- Modify: `docs-site/guides/configuration.mdx`
- Modify: `docs-site/reference/security.mdx`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `.changeset/providers-and-cost.md`

**Interfaces:**
- Consumes: every command/config/behavior from Tasks 1–9.
- Produces: user-facing documentation, including the documented `sbx secret` deferral (no code).

- [ ] **Step 1: Update `docs-site/reference/commands.mdx`**

Insert a new section after the Sessions table (after the `/agent` row):

```markdown
## Cost and providers

| Command | Access | Behavior |
| --- | --- | --- |
| `/cost` | authorized | Show this thread's and channel's accumulated cost, tokens, and the session budget (ephemeral). |
| `/budget show` | owner | Show this channel's session budget (ephemeral). |
| `/budget set usd:<usd>` | owner | Set this channel's session budget in USD; `0` disables it (ephemeral). |
| `/login provider:<id>` | owner | Start a provider OAuth flow and post the authorization URL (ephemeral). |
| `/login-code provider:<id> code:<code>` | owner | Finish an OAuth flow with the provider's authorization code (ephemeral). |
```

In the "Deferred to v1.1" list, remove `OAuth subscription login, ` so the feature sentence reads:

```markdown
Features: worktree-per-thread, `/btw` forks, queue UI (`. queue`),
permission-approval buttons, `question` rendered as Discord components, voice
messages, image attachments, OpenCode web UI, tunnels/screenshare, multi-guild,
cloud sandboxes, `--clone` sandbox mode, and Linux/macOS deployment docs.
```

- [ ] **Step 2: Update `docs-site/guides/providers.mdx`**

Add before "## Verify":

```markdown
## Login from Discord

Owner-only `/login <provider>` asks the sandbox's OpenCode server for that
provider's auth methods, starts the **oauth** method, and posts the
authorization URL. Complete the browser step, then:

- if the flow returned a `code` method, run `/login-code <provider> <code>` with
  the code the provider showed;
- if it returned `auto`, finish in the browser and run `/login <provider>` again
  to verify.

Authorization codes and tokens go straight to the sandbox server over the
loopback API. Celly never logs, audits, or echoes them. A provider with no OAuth
method answers `error: no oauth method for <provider>`; use `sbx secret` on the
host for that provider.

<Note>
Managing `sbx secret` from Discord is **deferred and host-only**. Doing it safely
needs a host spike on `sbx secret ls/set-custom` output and stdin behavior; until
then, register credentials on the host as described above.
</Note>
```

- [ ] **Step 3: Update `docs-site/guides/configuration.mdx` and `.env.example`**

In `configuration.mdx`, add a row after `MAX_CONCURRENT_RUNS`:

```markdown
| `SESSION_BUDGET_USD` | `0` | Per-session cost budget in USD; `0` disables. Per-channel override with `/budget set`. |
```

Add a note below the table:

```markdown
`SESSION_BUDGET_USD` is the global seed. `/budget set <usd>` stores
`budget_usd:<channelId>` in the `settings` table; that value wins for the
channel, and `/budget set 0` disables the budget for it.
```

In `.env.example`, add after `# MAX_CONCURRENT_RUNS=4`:

```dotenv
# # Cost control. 0 disables the per-session budget (override per channel with /budget).
# SESSION_BUDGET_USD=0
```

- [ ] **Step 4: Update `docs-site/reference/security.mdx`**

In the "## Secrets" list, after the `sbx secret` bullet, add:

```markdown
- OAuth credentials from `/login` / `/login-code` are sent only to the sandbox's
  loopback OpenCode server; the bot never logs, audits, or echoes the
  authorization code or the returned tokens.
- Managing `sbx secret` from Discord is deferred; credentials for non-OAuth
  providers stay host-only.
```

- [ ] **Step 5: Update `README.md`**

In the commands table, add after the `/agent` row:

```markdown
| `/cost` | thread or channel | Show accumulated cost, tokens, and the session budget. |
| `/budget show\|set <usd>` | channel (owner) | Show or set the per-channel session budget. |
| `/login <provider>` | channel or thread (owner) | Start a provider OAuth flow. |
| `/login-code <provider> <code>` | channel or thread (owner) | Finish a provider OAuth flow. |
```

In the Features list, add after the "Hardened permission policy" bullet:

```markdown
- **Cost tracking and budgets.** `/cost` reports per-thread and per-channel
  usage, and a session budget (env or `/budget`) stops a run that exceeds it.
- **Provider OAuth login.** Owner-only `/login` and `/login-code` complete
  provider authorization without leaving Discord.
```

In "Status / roadmap", remove `, OAuth subscription login` from the deferred sentence. In "Limitations", replace:

```markdown
- **The finalization token/duration footer is descoped.**
```

with:

```markdown
- **The finalization footer shows cost and in/out tokens.** Cache reads/writes
  are tracked in `/cost` but not rendered in the footer.
```

- [ ] **Step 6: Add the changeset**

Create `.changeset/providers-and-cost.md`:

```markdown
---
"celly": minor
---

Add per-session usage and cost tracking (`/cost`), per-channel session budgets
(`/budget`, `SESSION_BUDGET_USD`), and owner-only provider OAuth login from
Discord (`/login`, `/login-code`). Provider `sbx secret` management from Discord
remains deferred and host-only.
```

- [ ] **Step 7: Verify docs and suite**

Run: `npm run docs:validate && npm run docs:links`
Expected: PASS (Mintlify validates every page and finds no broken links).

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add docs-site/reference/commands.mdx docs-site/guides/providers.mdx docs-site/guides/configuration.mdx docs-site/reference/security.mdx .env.example README.md .changeset/providers-and-cost.md
git commit -m "docs: document cost, budgets, and provider login"
```

---

## Self-Review

**1. Spec coverage**

- §3.2 usage events (`step-finish` + `message.updated`, field names) → Task 1.
- §3.3 `Renderer.setFooter`, `startedAt`/`endedAt`, `elapsedMs()` → Task 3.
- §4.8 migration columns, `db.threads.addUsage`, `db.usage.{thread,channel,totals}` → Task 2.
- §4.8 Runner usage persistence + `$0.0123 · 1.2k in / 3.4k out` footer → Task 4.
- §4.8 `SESSION_BUDGET_USD` (≥ 0, default 0), abort + `[budget]` line + channel warning, fake-usage tests → Task 5.
- §4.8 `/cost` (thread + channel + budget, ephemeral) → Task 6.
- §4.8 `/budget show|set` (owner-only, `budget_usd:<channelId>`) → Task 7.
- §4.8 `/login` (owner-only, `provider.auth` → oauth method → `provider.oauth.authorize`, error when none) and `/login-code` (callback boolean → confirm, auto-method instructions) → Tasks 8–9.
- §4.8 deferred `sbx secret` documented in `providers.mdx`/`security.mdx`, no code → Task 10.
- §2 docs updates (commands/config/security/README/.env.example) and changeset, no new deps → Task 10.
- §3.6 SDK facts: `ProviderAuthMethod` (`oauth|api`), `ProviderAuthAuthorization` (`url`, `method: auto|code`, `instructions`), `Auth.set`; callback is passed through `unwrap` (see open questions).

**2. Placeholder scan**

No "TBD"/"TODO"/"add error handling"/"similar to Task N" patterns. Every step has exact code, an exact run command, and an exact expected result.

**3. Identifier consistency**

- `UsageTotals` is defined once (`src/types.ts`) and used by `db.ts`, `usage.ts`, `runner.ts`; event fields (`tokensIn`, `tokensOut`, `cacheRead`, `cacheWrite`) match the `addUsage` delta keys.
- `db.usage.thread/channel/totals`, `db.threads.addUsage`, `Renderer.setFooter/elapsedMs`, `formatTokens/formatCost/formatUsageFooter/formatUsageSummary/resolveBudget`, `OAuthClient/OAuthDeps/ProviderLogin/selectOAuthMethod/startProviderLogin/finishProviderLogin`, `CommandDeps.startLogin/finishLogin/sessionBudgetUsd`, `RunnerDeps.budgetUsd/notify` are spelled identically in every task.
- Owner gating goes through the existing `requiresOwner` (Task 7 extends it; Tasks 8–9 rely on it), matching the repo pattern.
- `budget_usd:<channelId>` is the single setting key in Task 5 (read), Task 7 (write), and Task 10 (docs).

**Open questions**

1. `ProviderOauthCallbackResponses` is typed `boolean` (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2723-2727`): the server persists OAuth credentials, so `finishProviderLogin` treats `true` as success and does **not** call `auth.set`. Spec §3.6 was corrected to match.
2. `step-finish` costs are incremental while `message.updated` `info.cost` is cumulative; both are emitted per spec §3.2 and summed by the runner, so a server that emits both for one assistant message can over-count. The budget/`/cost` tests use explicit fake events; confirm real behavior on the host.
3. The current main checkout has an unresolved `docs-site/docs.json` merge conflict in the working tree (`UU`); the worktree created from `main` is unaffected, but do not merge that conflict into this branch.
