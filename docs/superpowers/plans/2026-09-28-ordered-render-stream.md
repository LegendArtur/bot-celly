# Ordered Render Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Celly's streamed run message render OpenCode parts in their real arrival order (text and tool calls interleaved), quote the run's prompt at the top, and label tools/notices with clear status glyphs.

**Architecture:** Replace the `Renderer`'s two independent buckets (a text map plus a tool map that is always rendered first) with a single ordered `Segment[]` upserted by part id. `body()` walks segments in order and joins consecutive quote-class segments with a newline and everything else with a blank line. The run prompt is seeded through the `Renderer` constructor so the first flush starts with a formatted quote. Error/budget/project notices become a first-class `notice` event instead of ad-hoc `text` pushes.

**Tech Stack:** TypeScript, Node 24.x, discord.js 14, vitest.

**Spec:** This document (§ Problem Statement) is self-contained.

## Global Constraints

- No new runtime dependencies.
- Every Discord body still goes through `renderPayload` (mentions suppressed, embeds suppressed) and `chunkMessage(text, 1900)`.
- Keep the send/edit/delete/chunk-spill/elapsed/footer behavior of `Renderer` intact; only the body composition and event ingestion change.
- `npm test` (currently 619 tests), `npm run typecheck`, and `npm run build` must pass at every checkpoint.
- Tool lines are a user-visible format change; update their tests in the same task.
- Do NOT commit unless the user explicitly authorizes it. Treat each task's final step as a checkpoint; offer the commit instead of running it.

## Problem Statement

Observed live message:

```
[question] completed · Asked 1 question
[edit] completed · test/commands.test.ts
[bash] completed · npx vitest run … | tail -35
[edit] completed · src/commands.ts
[bash] running
```

OpenCode emits an ordered part stream (text, tool, text, tool…). Celly discards that order:

- `src/render.ts:104-108` keeps `parts`/`order` for text and a separate `tools` map.
- `src/render.ts:126-130` composes `body()` as `[toolLines, this.text, footer].join("\n\n")`, so every tool is hoisted above all text and the chronological order is lost.
- The user prompt is never rendered, so a run has no visible framing.
- Tool status is printed as the raw OpenCode enum (`completed`, `running`).
- Synthetic notes (`[error] …`, `[budget] …`, `[project stopped]`) are pushed as ordinary text with bracket tags.
- `src/events.ts:60-74` ignores `reasoning` parts (out of scope here).

Duplicate-looking lines in the example are most likely two real tool calls, but the upsert-by-part-id behavior is preserved and tested so resyncs cannot duplicate rows.

### Out of scope

- Components V2 cards/color (separate follow-on; it should be layered onto this segment model).
- Reasoning/thinking part rendering.
- Interleaving approval/question messages; those are separate Discord messages by design.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/render.ts` | Segment model, ordering, glyphs, prompt/notice formatting | Modify (class internals + helpers) |
| `src/events.ts` | `NormalizedEvent` union | Add `notice` variant |
| `src/runner.ts` | Prompt seeding, notice pushes, renderer factory signature | Modify |
| `src/index.ts` | Renderer construction | Pass `prompt` |
| `test/render.test.ts` | Renderer contract | Update tool tests, add ordering/prompt/notice tests |
| `test/runner.test.ts` | Runner contract | Add prompt-seed test, update error/budget expectations |
| `docs-site/reference/architecture.mdx` | Module map | One-line renderer description update |

---

### Task 1: Interleaved ordered segments (text + tools)

**Files:**
- Modify: `src/render.ts:98-204` (from `export const TOOL_TITLE_MAX` to end of file)
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` text/tool variants from `src/events.ts` (unchanged).
- Produces: `toolGlyph(status: string): string`, and a `Renderer` whose `push`/`body` order text and tool segments by first arrival. Later tasks add `prompt` and `notice` to the same `Segment` union.

- [ ] **Step 1: Write the failing ordering tests**

Append to `test/render.test.ts`:

```ts
test("renderer interleaves text and tool segments in arrival order", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p1", text: "before" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p2", name: "bash", status: "completed", title: "npm test" })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p3", text: "after" })
  await r.finalize()
  expect(sends).toEqual(["before\n\n> ✅ `bash` · npm test\n\nafter"])
})

test("renderer keeps a tool segment in place when its status updates", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "running", title: "npm test" })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p1", text: "mid" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "completed", title: "npm test" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t2", name: "edit", status: "completed", title: "src/x.ts" })
  await r.finalize()
  expect(sends).toEqual(["> ✅ `bash` · npm test\n\nmid\n\n> ✅ `edit` · src/x.ts"])
})

test("renderer upserts duplicate part ids instead of duplicating lines", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "pending", title: "npm test" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "completed", title: "npm test" })
  await r.finalize()
  expect(sends).toEqual(["> ✅ `bash` · npm test"])
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run test/render.test.ts -t "interleaves"`
Expected: FAIL — actual body starts with `> [bash] …` and hoists the tool above `before`.

- [ ] **Step 3: Update the two existing tool-format tests**

Replace the body of `renderer renders tool lines with a title truncated to 120 chars` (`test/render.test.ts:269-277`) with:

```ts
test("renderer renders tool lines with a title truncated to 120 chars", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p1", name: "bash", status: "running", title: "npm test" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p2", name: "edit", status: "completed", title: "x".repeat(200) })
  await r.finalize()
  expect(sends).toEqual([`> 🔄 \`bash\` · npm test\n> ✅ \`edit\` · ${"x".repeat(119)}…`])
})
```

Replace `renderer tool lines without a title stay byte-compatible` (`test/render.test.ts:279-286`) with:

```ts
test("renderer tool lines without a title omit the separator", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p1", name: "bash", status: "running" })
  await r.finalize()
  expect(sends).toEqual(["> 🔄 `bash`"])
})
```

- [ ] **Step 4: Replace the renderer implementation**

In `src/render.ts`, replace everything from `export const TOOL_TITLE_MAX` (line 98) to the end of the file with:

```ts
export const TOOL_TITLE_MAX = 120
function truncateToolTitle(title: string, max = TOOL_TITLE_MAX): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title
}

export function toolGlyph(status: string): string {
  if (status === "pending") return "⏳"
  if (status === "running") return "🔄"
  if (status === "completed") return "✅"
  if (status === "error") return "❌"
  return "•"
}

type Segment =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; status: string; title?: string }

function renderSegment(segment: Segment): string {
  if (segment.kind === "text") return segment.text
  const title = segment.title ? ` · ${truncateToolTitle(segment.title)}` : ""
  return `> ${toolGlyph(segment.status)} \`${segment.name}\`${title}`
}
function isQuote(segment: Segment): boolean {
  return segment.kind === "tool"
}

export class Renderer {
  private segments: Segment[] = []
  private segmentIndex = new Map<string, number>()
  private ids: string[] = []
  private lastEdit = Number.NEGATIVE_INFINITY
  private dirty = false
  private revision = 0
  private startedAt: number | null = null
  private endedAt: number | null = null
  private inFlight: Promise<void> | null = null
  private footer = ""
  constructor(private readonly deps: {
    send(content: string): Promise<string>; edit(messageId: string, content: string): Promise<void>
    delete?(messageId: string): Promise<void>
    now(): number; intervalMs: number; onMessageId?(id: string): void; onMessageIds?(ids: string[]): void
    initialMessageId?: string | null
    initialMessageIds?: string[] | null
  }) {
    if (deps.initialMessageIds && deps.initialMessageIds.length > 0) this.ids = [...deps.initialMessageIds]
    else if (deps.initialMessageId) this.ids = [deps.initialMessageId]
  }
  private upsert(segment: Segment): void {
    const existing = this.segmentIndex.get(segment.id)
    if (existing === undefined) {
      this.segmentIndex.set(segment.id, this.segments.length)
      this.segments.push(segment)
      return
    }
    this.segments[existing] = segment
  }
  private body(): string {
    let body = ""
    let previousQuote = false
    let first = true
    for (const segment of this.segments) {
      const rendered = renderSegment(segment)
      if (!rendered) continue
      const quote = isQuote(segment)
      if (first) body = rendered
      else body += (previousQuote && quote ? "\n" : "\n\n") + rendered
      previousQuote = quote
      first = false
    }
    if (this.footer) body = body ? `${body}\n\n-# ${this.footer}` : `-# ${this.footer}`
    return body
  }
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
    if (e.kind === "text") this.upsert({ kind: "text", id: e.partId, text: e.text })
    else if (e.kind === "tool") this.upsert({ kind: "tool", id: e.partId, name: e.name, status: e.status, ...(e.title ? { title: e.title } : {}) })
    else return
    this.dirty = true
    this.revision++
  }
  private async runFlush(): Promise<void> {
    const revision = this.revision
    const chunks = chunkMessage(this.body(), 1900)
    if (chunks.length === 0) {
      if (this.ids.length > 0) {
        const surplus = this.ids.splice(0)
        if (this.deps.delete) for (const id of surplus) await this.deps.delete(id)
      }
      this.lastEdit = this.deps.now()
      this.deps.onMessageIds?.([...this.ids])
      if (this.revision === revision) this.dirty = false
      return
    }
    for (const [i, content] of chunks.entries()) {
      const existing = this.ids[i]
      if (existing !== undefined) await this.deps.edit(existing, content)
      else {
        const id = await this.deps.send(content)
        this.ids.push(id)
        this.deps.onMessageId?.(id)
      }
    }
    if (this.ids.length > chunks.length) {
      const surplus = this.ids.splice(chunks.length)
      if (this.deps.delete) for (const id of surplus) await this.deps.delete(id)
    }
    this.lastEdit = this.deps.now()
    this.deps.onMessageIds?.([...this.ids])
    if (this.revision === revision) this.dirty = false
  }
  async flush(): Promise<void> {
    while (this.dirty) {
      if (this.inFlight) { await this.inFlight; continue }
      this.inFlight = this.runFlush()
      try { await this.inFlight } finally { this.inFlight = null }
    }
  }
  async tick(): Promise<void> {
    if (this.ids.length > 0 && this.deps.now() - this.lastEdit < this.deps.intervalMs) return
    await this.flush()
  }
  async finalize(): Promise<void> {
    if (this.endedAt === null) this.endedAt = this.deps.now()
    await this.flush()
  }
}
```

- [ ] **Step 5: Run the renderer tests**

Run: `npx vitest run test/render.test.ts`
Expected: PASS (all 27+ tests, including the pre-existing chunking/spill/footer/elapsed tests).

- [ ] **Step 6: Run the full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green (other suites do not assert rendered bodies).

- [ ] **Step 7: Checkpoint**

Show `git diff --stat`. Offer to commit:

```bash
git add src/render.ts test/render.test.ts
git commit -m "fix(render): interleave text and tool parts in arrival order"
```

---

### Task 2: Prompt framing

**Files:**
- Modify: `src/render.ts` (constructor, `Segment` union, `formatPrompt`, `renderSegment`, `isQuote`, `push`)
- Modify: `src/runner.ts` (`RunnerDeps.createRenderer`, `prompts` map, `prompt()`, `idle()`, `rendererFor()`)
- Modify: `src/index.ts:322` (renderer factory)
- Test: `test/render.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `Renderer` from Task 1.
- Produces: `Renderer` constructor accepts `prompt?: string | null`; `RunnerDeps.createRenderer(threadId, liveMessageId?, liveMessageIds?, prompt?)`. Runner seeds the renderer with the current run's prompt text.

- [ ] **Step 1: Write the failing prompt tests**

Append to `test/render.test.ts`:

```ts
test("renderer seeds the prompt as the first segment", async () => {
  const sends: string[] = []
  const r = new Renderer({ prompt: "  fix   the bug ", send: async (c) => { sends.push(c); return "m1" },
    edit: async () => {}, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "on it" })
  await r.finalize()
  expect(sends).toEqual(["> **you** · fix the bug\n\non it"])
})

test("renderer clamps a long prompt", async () => {
  const sends: string[] = []
  const r = new Renderer({ prompt: "x".repeat(400), send: async (c) => { sends.push(c); return "m1" },
    edit: async () => {}, now: () => 0, intervalMs: 1000 })
  await r.finalize()
  expect(sends).toEqual([`> **you** · ${"x".repeat(299)}…`])
})

test("renderer ignores a blank prompt", async () => {
  const sends: string[] = []
  const r = new Renderer({ prompt: "   ", send: async (c) => { sends.push(c); return "m1" },
    edit: async () => {}, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "only" })
  await r.finalize()
  expect(sends).toEqual(["only"])
})
```

Append to `test/runner.test.ts`:

```ts
test("prompt seeds the renderer with the run's prompt text", async () => {
  const seen: (string | null | undefined)[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async (_threadId, _liveId, _liveIds, prompt) => { seen.push(prompt); return makeRenderer() as any },
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "hello", "u")
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p", text: "a" })
  expect(seen).toEqual(["hello"])
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run test/render.test.ts -t "prompt" && npx vitest run test/runner.test.ts -t "seeds the renderer"`
Expected: FAIL — `prompt` is not an accepted option and is not passed to `createRenderer`.

- [ ] **Step 3: Add the prompt segment to `src/render.ts`**

Add `PROMPT_TEXT_MAX` and `formatPrompt` above `type Segment`:

```ts
const PROMPT_TEXT_MAX = 300
export function formatPrompt(text: string, max = PROMPT_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return ""
  const clipped = flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat
  return `> **you** · ${clipped}`
}
```

Extend the union and renderer:

```ts
type Segment =
  | { kind: "prompt"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; status: string; title?: string }

function renderSegment(segment: Segment): string {
  if (segment.kind === "prompt") return formatPrompt(segment.text)
  if (segment.kind === "text") return segment.text
  const title = segment.title ? ` · ${truncateToolTitle(segment.title)}` : ""
  return `> ${toolGlyph(segment.status)} \`${segment.name}\`${title}`
}
```

In the constructor deps type add `prompt?: string | null`, and after seeding `ids` add:

```ts
    if (deps.prompt && deps.prompt.trim()) this.upsert({ kind: "prompt", id: "__prompt__", text: deps.prompt })
```

- [ ] **Step 4: Seed the prompt from `src/runner.ts`**

Add a field next to `private renderers`:

```ts
  private prompts = new Map<string, string>()
```

In `prompt()`, after `this.owner.set(threadId, epoch)` add:

```ts
    this.prompts.set(threadId, text)
```

In the same method's `catch` block, inside `if (this.ownsEpoch(threadId, epoch))`, add:

```ts
        this.prompts.delete(threadId)
```

In `idle()`, after `this.owner.delete(threadId)`, add:

```ts
    this.prompts.delete(threadId)
```

Change `rendererFor`:

```ts
      renderer = this.deps.createRenderer(threadId, liveMessageId, liveMessageIds, this.prompts.get(threadId))
```

Change the `RunnerDeps` signature:

```ts
  createRenderer(threadId: string, liveMessageId?: string | null, liveMessageIds?: string[] | null, prompt?: string | null): Promise<Renderer>
```

- [ ] **Step 5: Pass the prompt into the real renderer**

In `src/index.ts:322`, change the factory and constructor:

```ts
    createRenderer: async (threadId, liveMessageId, liveMessageIds, prompt) => {
```

and in the `new Renderer({ … })` options add:

```ts
        prompt,
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/render.test.ts test/runner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full suite + build**

Run: `npm test && npm run build`
Expected: all green.

- [ ] **Step 8: Checkpoint**

Offer to commit:

```bash
git add src/render.ts src/runner.ts src/index.ts test/render.test.ts test/runner.test.ts
git commit -m "feat(render): quote the run prompt at the top of the stream"
```

---

### Task 3: Notice events for errors, budget, and project state

**Files:**
- Modify: `src/events.ts:5-13` (`NormalizedEvent` union)
- Modify: `src/render.ts` (`Segment`, `renderSegment`, `isQuote`, `push`)
- Modify: `src/runner.ts:405-412` (error), `:371-379` (budget), `:475-495` (finalizeThread, handleProjectDown, resetChannel)
- Test: `test/render.test.ts`, `test/runner.test.ts:278-294`, `test/runner.test.ts:818-841`

**Interfaces:**
- Consumes: Task 1/2 `Renderer`.
- Produces: `NormalizedEvent` gains `{ kind: "notice"; sessionId: string; partId: string; text: string; tone: "info" | "warn" | "error" }`. Runner stops pushing bracket-tagged `text` events for errors/budget/project state.

- [ ] **Step 1: Write the failing notice tests**

Append to `test/render.test.ts`:

```ts
test("renderer renders notices with a tone glyph", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "notice", sessionId: "s", partId: "n1", text: "boom", tone: "error" })
  await r.finalize()
  expect(sends).toEqual(["> ❌ **Error** — boom"])
})

test("renderer flattens multiline notices", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "notice", sessionId: "s", partId: "n1", text: "line one\nline two", tone: "warn" })
  await r.finalize()
  expect(sends).toEqual(["> ⚠️ **Warning** — line one line two"])
})
```

Replace the expectation in `test/runner.test.ts:289` with:

```ts
  expect(pushed.some((p) => p.kind === "notice" && p.text === "boom" && p.tone === "error")).toBe(true)
```

Replace the budget assertions in `test/runner.test.ts:832-834` with:

```ts
    const note = "session budget reached ($0.0060 of $0.0050)"
    expect(pushed.some((p) => p.kind === "notice" && p.text === note && p.tone === "warn")).toBe(true)
    expect(notices).toEqual([["c1", `[budget] ${note}`]])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/render.test.ts -t "notice" && npx vitest run test/runner.test.ts -t "session.error"`
Expected: FAIL — `notice` is not a valid `NormalizedEvent`/`Segment` kind.

- [ ] **Step 3: Add the notice variant to `src/events.ts`**

In the `NormalizedEvent` union after the `tool` line add:

```ts
  | { kind: "notice"; sessionId: string; partId: string; text: string; tone: "info" | "warn" | "error" }
```

- [ ] **Step 4: Render notices in `src/render.ts`**

Add above `type Segment`:

```ts
const NOTICE_TEXT_MAX = 500
type NoticeTone = "info" | "warn" | "error"
function noticeLabel(tone: NoticeTone): string {
  if (tone === "error") return "Error"
  if (tone === "warn") return "Warning"
  return "Note"
}
function noticeGlyph(tone: NoticeTone): string {
  if (tone === "error") return "❌"
  if (tone === "warn") return "⚠️"
  return "ℹ️"
}
```

Extend the union:

```ts
  | { kind: "notice"; id: string; text: string; tone: NoticeTone }
```

Extend `renderSegment`:

```ts
  if (segment.kind === "notice") {
    const flat = segment.text.replace(/\s+/g, " ").trim()
    const clipped = flat.length > NOTICE_TEXT_MAX ? flat.slice(0, NOTICE_TEXT_MAX - 1).trimEnd() + "…" : flat
    return `> ${noticeGlyph(segment.tone)} **${noticeLabel(segment.tone)}** — ${clipped}`
  }
```

Extend `isQuote`:

```ts
  return segment.kind === "tool" || segment.kind === "notice"
```

Extend `push` before the final `else return`:

```ts
    else if (e.kind === "notice") this.upsert({ kind: "notice", id: e.partId, text: e.text, tone: e.tone })
```

- [ ] **Step 5: Push notices from `src/runner.ts`**

Error branch (`onEvent`, `:405-412`):

```ts
      try {
        const r = await this.rendererFor(threadId)
        r.push({ kind: "notice", sessionId: e.sessionId, partId: `err-${e.sessionId}`, text: e.message, tone: "error" })
        await r.finalize()
      } catch (err) {
        this.deps.log("error render finalize failed", { threadId, error: String(err) })
      }
```

Budget branch (`:371-379`):

```ts
      const budget = this.budgetFor(threadId)
      if (budget > 0 && totals.cost >= budget && db.threads.get(threadId)?.renderState !== "aborting") {
        const note = `session budget reached (${formatCost(totals.cost)} of ${formatCost(budget)})`
        renderer.push({ kind: "notice", sessionId: e.sessionId, partId: `budget-${e.sessionId}`, text: note, tone: "warn" })
        await renderer.finalize()
        const thread = db.threads.get(threadId)
        if (thread) await this.deps.notify?.(thread.channelId, `[budget] ${note}`)
        await this.abort(threadId)
      }
```

`finalizeThread` signature and push (`:475-482`):

```ts
  private async finalizeThread(thread: Thread, note?: { partId: string; text: string; tone: "info" | "warn" | "error" }): Promise<void> {
    const epoch = this.owner.get(thread.threadId)
    try {
      const renderer = await this.rendererFor(thread.threadId)
      if (note) renderer.push({ kind: "notice", sessionId: thread.sessionId, partId: note.partId, text: note.text, tone: note.tone })
      await renderer.finalize()
    } catch {}
    this.idle(thread.threadId, epoch)
  }
```

Call sites (`:488-503`):

```ts
      await this.finalizeThread(thread, { partId: `down-${thread.threadId}`, text: "project server stopped", tone: "warn" })
```

```ts
      await this.finalizeThread(thread, opts.notify ? { partId: `stop-${thread.threadId}`, text: "project stopped", tone: "warn" } : undefined)
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/render.test.ts test/runner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full suite + build**

Run: `npm test && npm run build`
Expected: all green.

- [ ] **Step 8: Checkpoint**

Offer to commit:

```bash
git add src/events.ts src/render.ts src/runner.ts test/render.test.ts test/runner.test.ts
git commit -m "feat(render): render errors, budget, and project notices as status blocks"
```

---

### Task 4: Docs and final verification

**Files:**
- Modify: `docs-site/reference/architecture.mdx` (module map row for `src/render.ts`)

- [ ] **Step 1: Update the renderer description**

Change the `src/render.ts` row in the module map table to:

```markdown
| `src/render.ts` | Pure event → text/chunk functions plus a throttled editor; parts render in OpenCode's arrival order (text and tool calls interleaved), the run prompt is quoted at the top, and all output goes through one send/edit chokepoint. |
```

- [ ] **Step 2: Add a covered-edge note to follow-ups**

Append to `docs/follow-ups.md`:

```markdown
6. **Reasoning parts and Components V2 cards.** The renderer now preserves
   OpenCode part order, but `reasoning` parts are still dropped and the run
   card/color idea is not implemented. Both should layer onto the `Segment`
   model in `src/render.ts` rather than the old two-bucket layout.
```

- [ ] **Step 3: Final verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all 626+ tests pass, typecheck and build clean.

- [ ] **Step 4: Checkpoint**

Offer to commit:

```bash
git add docs-site/reference/architecture.mdx docs/follow-ups.md
git commit -m "docs: describe the ordered render stream"
```

---

## Self-Review

**Spec coverage**

- Interleaved text/tool order → Task 1.
- Tool status glyphs → Task 1.
- Prompt framing → Task 2.
- Notices (error/budget/project) → Task 3.
- Recovery/resync dedupe → Task 1 upsert test; recovery tests in `test/runner.test.ts:498-579` remain unchanged and must stay green.
- Reasoning parts / V2 → explicitly out of scope, recorded in Task 4 follow-ups.

**Placeholder scan:** none — every code step has concrete code and exact commands.

**Type consistency:** `Segment.id`, `upsert`, `renderSegment`, `isQuote` are defined in Task 1 and reused verbatim in Tasks 2-3. `NoticeTone` is introduced in Task 1's union as an inline union and named in Task 3 before use; Task 3's `notice` variant matches the `NormalizedEvent` addition exactly. `createRenderer`'s 4th parameter is `prompt?: string | null` in both the interface and `index.ts`.

**Known risk:** Task 1 is a large single replacement of `src/render.ts:98-204`. It is covered by 30+ existing renderer tests plus the new ordering tests, so regressions surface immediately in Step 5.
