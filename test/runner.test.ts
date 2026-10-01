// test/runner.test.ts
import { expect, test, vi } from "vitest"
import { Runner, withDirectory } from "../src/runner.ts"
import { Renderer } from "../src/render.ts"

function makeDb(state = "running", threads: any[] = [], liveMessageId: string | null = null, liveMessageIds: string[] = []) {
  const states: string[] = []
  const ids = liveMessageIds.length ? liveMessageIds : (liveMessageId ? [liveMessageId] : [])
  let renderState = state
  const usage = { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 }
  const settings = new Map<string, string>()
  const db = {
    threads: {
      setRenderState(_t: string, s: string) { renderState = s; states.push(s) },
      touch() {},
      get() { return { renderState, liveMessageId, channelId: "c1" } },
      liveMessageIds() { return ids },
      setLiveMessages() {},
      byChannel() { return threads },
      addUsage(_t: string, d: any) {
        usage.cost += d.cost; usage.tokensIn += d.tokensIn; usage.tokensOut += d.tokensOut
        usage.cacheRead += d.cacheRead; usage.cacheWrite += d.cacheWrite
      },
    },
    projects: { touch() {} },
    usage: {
      thread() { return { ...usage } },
      channel() { return { ...usage } },
      totals() { return { ...usage } },
    },
    settings: { get: (k: string) => settings.get(k), set: (k: string, v: string) => { settings.set(k, v) } },
  } as any
  return { db, states, usage, settings }
}

function makeRenderer(calls: any[] = []) {
  return { push: (e: any) => calls.push(e), tick: async () => {}, finalize: async () => { calls.push({ finalize: true }) } }
}

test("prompt queues a second message while active", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  expect(await runner.prompt("t1", "a", "u")).toBeUndefined()
  expect(await runner.prompt("t1", "b", "u")).toBe("queued (1)")
})

test("rejects further prompts when the queue is full", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 1, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  expect(await runner.prompt("t1", "b", "u")).toBe("queued (1)")
  expect(await runner.prompt("t1", "c", "u")).toBe("queue full")
})

test("per-thread lock: two overlapping prompts start only one run", async () => {
  let releaseSession!: (v: string) => void
  const gate = new Promise<string>((r) => { releaseSession = r })
  const sent: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => gate, log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  const first = runner.prompt("t1", "a", "u")
  expect(await runner.prompt("t1", "b", "u")).toBe("queued (1)")
  releaseSession("s1")
  await first
  expect(sent).toEqual(["a"])
})

test("a prompt over the global concurrency cap is queued instead of dropped", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1 })
  expect(await runner.prompt("t1", "a", "u")).toBeUndefined()
  expect(await runner.prompt("t2", "b", "u")).toBe("queued (1)")
})

test("global cap is enforced atomically across overlapping prompts", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => { await gate } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1 })
  const first = runner.prompt("t1", "a", "u")
  expect(await runner.prompt("t2", "b", "u")).toBe("queued (1)")
  release()
  await first
})

test("a queued prompt drains once a global slot frees up", async () => {
  const sent: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 1 })
  expect(await runner.prompt("t1", "one", "u")).toBeUndefined()
  expect(await runner.prompt("t2", "two", "u")).toBe("queued (1)")
  expect(sent).toEqual(["one"])
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(sent).toEqual(["one", "two"])
})

test("queued prompts preserve FIFO order across drains", async () => {
  const sent: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 1 })
  await runner.prompt("t1", "a", "u")
  await runner.prompt("t1", "b", "u")
  await runner.prompt("t1", "c", "u")
  expect(sent).toEqual(["a"])
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(sent).toEqual(["a", "b"])
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(sent).toEqual(["a", "b", "c"])
})

test("idle drains the queue", async () => {
  const sent: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } }, postSessionIdPermissionsPermissionId: async () => {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u"); await runner.prompt("t1", "second", "u")
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(sent).toEqual(["first", "second"])
  expect(runner.activeCount).toBe(1)
})

test("queued drains seed their own prompt", async () => {
  const seen: (string | null | undefined)[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async (_threadId, _liveId, _liveIds, prompt) => { seen.push(prompt); return makeRenderer() as any },
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p", text: "a" })
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p2", text: "b" })
  expect(seen).toEqual(["first", "second"])
})

test("permission event responds with the evaluated decision", async () => {
  const responses: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {}, postSessionIdPermissionsPermissionId: async (a: any) => { responses.push(a) } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", source: "v1", tool: "bash", patterns: ["git push origin main"] })
  expect(responses).toEqual([{ path: { id: "s1", permissionID: "p1" }, body: { response: "reject" } }])
})

test("session.error posts the error, sets idle, and drains the queue", async () => {
  const sent: string[] = []
  const pushed: any[] = []
  const { db, states } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => makeRenderer(pushed) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  await runner.onEvent("t1", { kind: "error", sessionId: "s1", message: "boom" })
  expect(pushed.some((p) => p.kind === "notice" && p.text === "boom" && p.tone === "error")).toBe(true)
  expect(states).toContain("idle")
  expect(states).not.toContain("errored")
  expect(sent).toEqual(["first", "second"])
  expect(runner.activeCount).toBe(1)
})

test("abort sets aborting, aborts the session, clears queue, then force-finalizes after 10s", async () => {
  vi.useFakeTimers()
  try {
    const aborted: string[] = []
    const finalized: number[] = []
    const { db, states } = makeDb("aborting")
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async () => {}, abort: async (a: any) => { aborted.push(a.path.id) } } }) as any,
      createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "first", "u")
    await runner.prompt("t1", "queued", "u")
    await runner.abort("t1")
    expect(states).toEqual(["running", "aborting"])
    expect(aborted).toEqual(["s1"])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(states[states.length - 1]).toBe("idle")
    expect(finalized.length).toBe(1)
    expect(runner.activeCount).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test("session.idle during abort clears the force-idle timer and clears the queue", async () => {
  vi.useFakeTimers()
  try {
    const finalized: number[] = []
    const { db } = makeDb("aborting")
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async () => {}, abort: async () => {} } }) as any,
      createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "a", "u")
    await runner.abort("t1")
    await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
    expect(finalized.length).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(finalized.length).toBe(1)
    expect(runner.activeCount).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test("a 4xx from promptAsync surfaces and resets the run to idle", async () => {
  const { db, states } = makeDb()
  const idle: string[] = []
  const statuses: string[] = []
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => { throw new Error("opencode server POST /session → 400 Bad Request: bad request") } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1,
    onThreadState: (_id, s) => statuses.push(s),
    onThreadIdle: (threadId) => { idle.push(threadId) } })
  await expect(runner.prompt("t1", "a", "u")).rejects.toThrow(/400/)
  expect(states).toContain("idle")
  expect(statuses).toEqual(["working", "idle"])
  expect(runner.activeCount).toBe(0)
  expect(idle).toEqual(["t1"])
})

test("an error event leaves the thread status at error, not idle", async () => {
  const { db } = makeDb()
  const statuses: string[] = []
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    onThreadState: (_id, s) => statuses.push(s) })
  await runner.prompt("t1", "a", "u")
  await runner.onEvent("t1", { kind: "error", sessionId: "s1", message: "boom" })
  expect(statuses).toContain("error")
  expect(statuses.at(-1)).toBe("error")
  expect(statuses).not.toContain("idle")
})

test("prompt releases the concurrency slot when starting the run throws", async () => {
  const { db } = makeDb()
  db.threads.setRenderState = () => { throw new Error("db down") }
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1 })
  await expect(runner.prompt("t1", "a", "u")).rejects.toThrow("db down")
  expect(runner.activeCount).toBe(0)
})

test("abort re-checks activity after awaiting the session", async () => {
  let release!: (v: string) => void
  const gate = new Promise<string>((r) => { release = r })
  let calls = 0
  const aborted: string[] = []
  const { db, states } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: () => new Promise<void>(() => {}), abort: async (a: any) => { aborted.push(a.path.id) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: () => { calls++; return calls === 1 ? Promise.resolve("s1") : gate },
    log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  void runner.prompt("t1", "a", "u")
  await Promise.resolve()
  const pendingAbort = runner.abort("t1")
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  release("s1")
  await pendingAbort
  expect(aborted).toEqual([])
  expect(states).not.toContain("aborting")
})

test("drain re-queues a message when prompt throws", async () => {
  let sessionCalls = 0
  const sent: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => { sessionCalls++; if (sessionCalls === 2) throw new Error("boom"); return "s1" },
    log() {}, maxQueue: 5, maxConcurrentRuns: 2 })
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(sent).toEqual(["first"])
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(sent).toEqual(["first", "second"])
})

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

test("isActive and activeThreadsFor reflect the real activity signal", async () => {
  const threads = [{ threadId: "t1", channelId: "c1", sessionId: "s1" }, { threadId: "t2", channelId: "c1", sessionId: "s2" }]
  const { db } = makeDb("running", threads)
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  expect(runner.isActive("t1")).toBe(true)
  expect(runner.isActive("t2")).toBe(false)
  expect(runner.activeThreadsFor("c1")).toEqual(["t1"])
})

test("abort on an idle thread is a no-op", async () => {
  const { db, states } = makeDb("idle")
  let aborts = 0
  const runner = new Runner({ db,
    clientFor: () => ({ session: { abort: async () => { aborts++ } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 1, maxConcurrentRuns: 1 })
  await runner.abort("t1")
  expect(states).toEqual([])
  expect(aborts).toBe(0)
})

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
  expect(runner.queuedFor("t1").map((q) => q.text)).toEqual(["b", "c"])
  expect(runner.removeQueued("t1", 1)).toBe(true)
  expect(runner.queuedFor("t1").map((q) => q.text)).toEqual(["b"])
  expect(runner.removeQueued("t1", 5)).toBe(false)
  expect(runner.removeQueued("t1", -1)).toBe(false)
  expect(runner.removeQueued("t1", 1.5)).toBe(false)
  expect(runner.removeQueued("t2", 0)).toBe(false)
  expect(runner.queuedFor("t1").map((q) => q.text)).toEqual(["b"])
})

test("clearQueued removes every entry and returns the count", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  await runner.prompt("t1", "b", "u")
  expect(runner.clearQueued("t1")).toBe(1)
  expect(runner.queuedFor("t1")).toEqual([])
  expect(runner.clearQueued("t1")).toBe(0)
})

test("recover seeds the renderer with every persisted chunk id", async () => {
  const edits: string[] = []
  const sends: string[] = []
  const body = "a".repeat(1800) + "b".repeat(1800)
  const { db } = makeDb("idle", [], null, ["m0", "m1"])
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async () => ({ data: [
      { info: { id: "m", role: "assistant" }, parts: [{ id: "p", type: "text", text: body }] },
    ] }) } }) as any,
    createRenderer: async (_threadId, _liveId, liveIds) => new Renderer({
      initialMessageIds: liveIds,
      send: async (c) => { sends.push(c); return "n" + sends.length },
      edit: async (id) => { edits.push(id) },
      now: () => 0, intervalMs: 1,
    }),
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(sends).toEqual([])
  expect(edits).toEqual(["m0", "m1"])
})

test("recover rebuilds and finalizes the renderer from the last assistant message", async () => {
  const pushed: any[] = []
  const { db, states } = makeDb()
  let listed: any
  const messages = [
    { info: { id: "m1", role: "user" }, parts: [{ id: "p1", type: "text", text: "hi" }] },
    { info: { id: "m2", role: "assistant" }, parts: [
      { id: "p2", type: "text", text: "hello" },
      { id: "p3", type: "tool", tool: "bash", state: { status: "completed" } },
    ] },
  ]
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async (a: any) => { listed = a; return { data: messages } } } }) as any,
    createRenderer: async () => makeRenderer(pushed) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(listed.path.id).toBe("s1")
  expect(pushed).toEqual([
    { kind: "text", sessionId: "s1", messageId: "m2", partId: "p2", text: "hello" },
    { kind: "tool", sessionId: "s1", messageId: "m2", partId: "p3", name: "bash", status: "completed" },
    { finalize: true },
  ])
  expect(states).toEqual(["idle"])
})

test("recover is idempotent: repeated recovers edit the live message instead of sending", async () => {
  const sends: string[] = []
  const edits: { id: string; content: string }[] = []
  const liveIds: (string | null | undefined)[] = []
  let n = 0, t = 0
  const { db } = makeDb("idle", [], "m0")
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async () => ({ data: [
      { info: { id: "m2", role: "assistant" }, parts: [{ id: "p2", type: "text", text: "recovered" }] },
    ] }) } }) as any,
    createRenderer: async (_threadId, liveId) => {
      liveIds.push(liveId)
      return new Renderer({ initialMessageId: liveId, send: async (c) => { sends.push(c); return "m" + (++n) }, edit: async (id, c) => { edits.push({ id, content: c }) }, now: () => t, intervalMs: 1000 })
    },
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(liveIds).toEqual(["m0", "m0"])
  expect(sends).toEqual([])
  expect(edits.length).toBe(2)
  expect(edits.every((e) => e.id === "m0")).toBe(true)
})

test("recover sends once when there is no persisted live message", async () => {
  const sends: string[] = []
  let n = 0
  const { db } = makeDb("idle", [], null)
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async () => ({ data: [
      { info: { id: "m2", role: "assistant" }, parts: [{ id: "p2", type: "text", text: "recovered" }] },
    ] }) } }) as any,
    createRenderer: async (_threadId, liveId) => new Renderer({ initialMessageId: liveId, send: async (c) => { sends.push(c); return "m" + (++n) }, edit: async () => {}, now: () => 0, intervalMs: 1000 }),
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(sends).toEqual(["recovered"])
})

test("recover seeds the renderer with the last user prompt", async () => {
  const seen: (string | null | undefined)[] = []
  const { db } = makeDb("idle", [], null)
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async () => ({ data: [
      { info: { id: "m1", role: "user" }, parts: [{ id: "p1", type: "text", text: "fix it" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ id: "p2", type: "text", text: "done" }] },
    ] }) } }) as any,
    createRenderer: async (_threadId, _liveId, _liveIds, prompt) => { seen.push(prompt); return makeRenderer() as any },
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(seen).toEqual(["fix it"])
})

test("recover ignores a user prompt sent after the recovered assistant message", async () => {
  const seen: (string | null | undefined)[] = []
  const { db } = makeDb("idle", [], null)
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async () => ({ data: [
      { info: { id: "m1", role: "user" }, parts: [{ id: "p1", type: "text", text: "first task" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ id: "p2", type: "text", text: "working" }] },
      { info: { id: "m3", role: "user" }, parts: [{ id: "p3", type: "text", text: "second task" }] },
    ] }) } }) as any,
    createRenderer: async (_threadId, _liveId, _liveIds, prompt) => { seen.push(prompt); return makeRenderer() as any },
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(seen).toEqual(["first task"])
})

test("recover skips user messages without text parts", async () => {
  const seen: (string | null | undefined)[] = []
  const { db } = makeDb("idle", [], null)
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async () => ({ data: [
      { info: { id: "m1", role: "user" }, parts: [{ id: "p1", type: "text", text: "has text" }] },
      { info: { id: "m2", role: "user" }, parts: [{ id: "p2", type: "file", filename: "a.png" }] },
      { info: { id: "m3", role: "assistant" }, parts: [{ id: "p3", type: "text", text: "done" }] },
    ] }) } }) as any,
    createRenderer: async (_threadId, _liveId, _liveIds, prompt) => { seen.push(prompt); return makeRenderer() as any },
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(seen).toEqual(["has text"])
})

test("a stale idle frame cannot terminate a newer run (epoch ownership)", async () => {
  const sent: string[] = []
  let releaseFinalize!: () => void
  const finalizeGate = new Promise<void>((r) => { releaseFinalize = r })
  const { db } = makeDb("running")
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { await finalizeGate } }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  const h1 = runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  const h2 = runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  await Promise.resolve()
  releaseFinalize()
  await Promise.all([h1, h2])
  expect(sent).toEqual(["first", "second"])
  expect(runner.isActive("t1")).toBe(true)
})

test("a late abort acknowledgement does not wedge a newer run", async () => {
  vi.useFakeTimers()
  try {
    const sent: string[] = []
    let releaseAbort!: () => void
    const abortGate = new Promise<void>((r) => { releaseAbort = r })
    const { db } = makeDb("running")
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) }, abort: async () => { await abortGate } } }) as any,
      createRenderer: async () => makeRenderer() as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "first", "u")
    const pending = runner.abort("t1")
    await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
    await runner.prompt("t1", "newer", "u")
    releaseAbort()
    await pending
    expect(sent).toEqual(["first", "newer"])
    expect(runner.isActive("t1")).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runner.isActive("t1")).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

test("abort arms force-idle even when session.abort rejects", async () => {
  vi.useFakeTimers()
  try {
    const finalized: number[] = []
    const { db } = makeDb("aborting")
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async () => {}, abort: async () => { throw new Error("nope") } } }) as any,
      createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "a", "u")
    await runner.abort("t1")
    expect(runner.activeCount).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runner.activeCount).toBe(0)
    expect(finalized.length).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

test("resetChannel clears active, queued, and cached state without draining", async () => {
  const sent: string[] = []
  const finalized: number[] = []
  const { db, states } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 1 })
  db.threads.byChannel = () => [{ threadId: "t1", channelId: "c1", sessionId: "s1" }]
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  expect(runner.isActive("t1")).toBe(true)
  await runner.resetChannel("c1", { notify: true })
  expect(runner.isActive("t1")).toBe(false)
  expect(states).toContain("idle")
  expect(finalized.length).toBe(1)
  expect(await runner.prompt("t1", "third", "u")).toBeUndefined()
  expect(sent).toEqual(["first", "third"])
})

test("prompt applies the thread's model and agent overrides", async () => {
  const bodies: any[] = []
  const { db } = makeDb()
  db.threads.get = () => ({ renderState: "running", model: "anthropic/claude", agent: "build" })
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { bodies.push(a.body) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "hi", "u")
  expect(bodies[0]).toEqual({ parts: [{ type: "text", text: "hi" }], model: { providerID: "anthropic", modelID: "claude" }, agent: "build" })
})

test("prompt passes the thread's thinking depth as the model variant", async () => {
  const bodies: any[] = []
  const { db } = makeDb()
  db.threads.get = () => ({ renderState: "running", model: "anthropic/claude", agent: null, variant: "high" })
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { bodies.push(a.body) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "hi", "u")
  expect(bodies[0]).toEqual({ parts: [{ type: "text", text: "hi" }], model: { providerID: "anthropic", modelID: "claude" }, variant: "high" })
})

test("prompt omits a default thinking depth", async () => {
  const bodies: any[] = []
  const { db } = makeDb()
  db.threads.get = () => ({ renderState: "running", model: "anthropic/claude", agent: null, variant: "default" })
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { bodies.push(a.body) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "hi", "u")
  expect(bodies[0]).toEqual({ parts: [{ type: "text", text: "hi" }], model: { providerID: "anthropic", modelID: "claude" } })
})

test("Runner caches one renderer per thread: two text events yield one send and one edit", async () => {
  const sends: string[] = []
  const edits: string[] = []
  let n = 0, t = 0
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => new Renderer({
      send: async (c) => { sends.push(c); return "m" + (++n) },
      edit: async (_id, c) => { edits.push(c) },
      now: () => t, intervalMs: 1000,
    }),
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p", text: "a" })
  t = 2000
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p", text: "ab" })
  expect(sends).toEqual(["a"])
  expect(edits).toEqual(["ab"])
})

test("the renderer cache is cleared when a run goes idle", async () => {
  const sends: string[] = []
  let n = 0
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => new Renderer({ send: async (c) => { sends.push(c); return "m" + (++n) }, edit: async () => {}, now: () => 0, intervalMs: 1000 }),
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p", text: "a" })
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p2", text: "b" })
  expect(sends).toEqual(["a", "b"])
})

test("a finalize failure on idle still resets the run and drains the queue", async () => {
  const sent: string[] = []
  const { db, states } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { throw new Error("deleted") } }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  await expect(runner.onEvent("t1", { kind: "idle", sessionId: "s1" })).resolves.toBeUndefined()
  expect(states).toContain("idle")
  expect(sent).toEqual(["first", "second"])
})

test("a finalize failure on error still resets the run and drains the queue", async () => {
  const sent: string[] = []
  const { db, states } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { throw new Error("deleted") } }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  await expect(runner.onEvent("t1", { kind: "error", sessionId: "s1", message: "boom" })).resolves.toBeUndefined()
  expect(states).toContain("idle")
  expect(sent).toEqual(["first", "second"])
})

test("recover preserves the force-idle timer for an active aborting run", async () => {
  vi.useFakeTimers()
  try {
    const finalized: number[] = []
    const { db } = makeDb("aborting")
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async () => {}, abort: async () => {}, messages: async () => ({ data: [] }) } }) as any,
      createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "a", "u")
    await runner.abort("t1")
    await runner.recover({ threadId: "t1", sessionId: "s1" })
    expect(runner.activeCount).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runner.activeCount).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test("a failed run start kicks the global drain so a queued thread is not stranded", async () => {
  let rejectSession!: (e: Error) => void
  const gate = new Promise<string>((_, reject) => { rejectSession = reject })
  const sent: string[] = []
  let calls = 0
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: () => { calls++; return calls === 1 ? gate : Promise.resolve("s2") },
    log() {}, maxQueue: 5, maxConcurrentRuns: 1 })
  const first = runner.prompt("t1", "one", "u").catch(() => {})
  await Promise.resolve()
  expect(await runner.prompt("t2", "two", "u")).toBe("queued (1)")
  rejectSession(new Error("nope"))
  await first
  await new Promise((r) => setTimeout(r, 0))
  expect(sent).toEqual(["two"])
  expect(runner.isActive("t2")).toBe(true)
})

test("usage events persist totals and set the renderer footer", async () => {
  const { db, usage } = makeDb()
  const footers: string[] = []
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => ({ push: () => {}, tick: async () => {}, finalize: async () => {}, setFooter: (t: string) => { footers.push(t) }, elapsedMs: () => 2500 }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 10, cacheWrite: 20 })
  expect(usage).toMatchObject({ cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 10, cacheWrite: 20 })
  expect(footers).toEqual(["$0.0123 · 1.2k in / 3.4k out · 2.5s"])
})

test("reaching the session budget stops the run, notes it, and warns the channel", async () => {
  vi.useFakeTimers()
  try {
    const { db } = makeDb("running")
    const pushed: any[] = []
    const notices: Array<[string, string]> = []
    const aborted: string[] = []
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async () => {}, abort: async (a: any) => { aborted.push(a.path.id) } } }) as any,
      createRenderer: async () => ({ push: (e: any) => pushed.push(e), tick: async () => {}, finalize: async () => {}, setFooter: () => {}, elapsedMs: () => 0 }) as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4, budgetUsd: 0.005,
      notify: (channelId, text) => { notices.push([channelId, text]) } })
    await runner.prompt("t1", "go", "u")
    await runner.onEvent("t1", { kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.006, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
    const note = "session budget reached ($0.0060 of $0.0050)"
    expect(pushed.some((p) => p.kind === "notice" && p.text === note && p.tone === "warn")).toBe(true)
    expect(notices).toEqual([["c1", `[budget] ${note}`]])
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
    createRenderer: async () => ({ push: () => {}, tick: async () => {}, finalize: async () => {}, setFooter: () => {}, elapsedMs: () => 0 }) as any,
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
    createRenderer: async () => ({ push: () => {}, tick: async () => {}, finalize: async () => {}, setFooter: () => {}, elapsedMs: () => 0 }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4, budgetUsd: 100 })
  await runner.prompt("t1", "go", "u")
  await runner.onEvent("t1", { kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.003, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  expect(aborted).toEqual(["s1"])
})

test("handleProjectDown finalizes and idles active threads, freeing the concurrency budget", async () => {
  const threads = [{ threadId: "t1", channelId: "c1", sessionId: "s1" }]
  const { db, states } = makeDb("running", threads)
  const pushed: any[] = []
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => ({ push: (e: any) => pushed.push(e), tick: async () => {}, finalize: async () => { pushed.push({ finalize: true }) } }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  expect(runner.activeCount).toBe(1)
  await runner.handleProjectDown("c1")
  expect(runner.activeCount).toBe(0)
  expect(states).toContain("idle")
  expect(pushed.some((p) => p.finalize)).toBe(true)
  expect(pushed.some((p) => p.kind === "notice" && p.tone === "warn" && /stopped/.test(p.text))).toBe(true)
})

test("v1 and v2 permission replies go through the injected responder", async () => {
  const replies: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "auto",
    respondPermission: async (input: any) => { replies.push(input) },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", source: "v1", tool: "bash", patterns: ["npm test"] })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p2", source: "v2", tool: "bash", patterns: ["npm test"] })
  expect(replies).toEqual([
    { source: "v1", threadId: "t1", sessionId: "s1", requestId: "p1", reply: "once" },
    { source: "v2", threadId: "t1", sessionId: "s1", requestId: "p2", reply: "once" },
  ])
})

test("buttons mode delegates non-read-only permissions to the approval manager", async () => {
  const asked: any[] = []
  const replies: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "buttons",
    respondPermission: async (input: any) => { replies.push(input) },
    approvals: {
      requestPermission: async (input: any) => { asked.push(input); return "once" },
      askQuestion: async () => null,
      cancel: () => {},
      cancelThread: () => {},
    },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "r1", source: "v2", tool: "bash", patterns: ["npm test"] })
  expect(asked).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "r1", source: "v2", tool: "bash", patterns: ["npm test"], exact: true }])
  expect(replies).toEqual([])
})

test("plan mode replies directly without asking", async () => {
  const asked: any[] = []
  const replies: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "plan",
    respondPermission: async (input: any) => { replies.push(input) },
    approvals: { requestPermission: async (input: any) => { asked.push(input); return "once" }, askQuestion: async () => null, cancel: () => {}, cancelThread: () => {} },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "r1", source: "v1", tool: "read", patterns: ["src/a.ts"] })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "r2", source: "v1", tool: "write", patterns: ["src/a.ts"] })
  expect(replies).toEqual([
    { source: "v1", threadId: "t1", sessionId: "s1", requestId: "r1", reply: "once" },
    { source: "v1", threadId: "t1", sessionId: "s1", requestId: "r2", reply: "reject" },
  ])
  expect(asked).toEqual([])
})

test("policy decisions append an audit entry", async () => {
  const audits: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "auto",
    respondPermission: async () => {},
    audit: (entry: any) => { audits.push(entry) },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", source: "v1", tool: "bash", patterns: ["git push origin main"] })
  expect(audits).toEqual([{ kind: "permission", threadId: "t1", actorId: "policy", detail: "bash git push origin main", decision: "reject" }])
})

test("question events are routed to the approval manager", async () => {
  const asked: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject",
      askQuestion: async (input: any) => { asked.push(input); return null },
      cancel: () => {},
      cancelThread: () => {},
    },
  })
  const questions = [{ question: "Which DB?", header: "DB", options: [{ label: "sqlite", description: "" }] }]
  await runner.onEvent("t1", { kind: "question", sessionId: "s1", requestId: "q1", source: "v1", questions })
  expect(asked).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "q1", source: "v1", questions }])
})

test("onQuestionState paints the inline question into the thread renderer", async () => {
  const painted: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => {}, flush: async () => {}, upsertQuestion: (...args: any[]) => painted.push(args) }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
  })
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p", text: "hi" })
  runner.onQuestionState({ threadId: "t1", requestId: "q1", questions: [], text: "Which DB?", components: [{ type: 1 }] })
  await vi.waitFor(() => expect(painted).toHaveLength(1))
  expect(painted[0]).toEqual(["question:q1", "Which DB?", [{ type: 1 }]])
})

test("a question renders inline in the streamed reply and its controls clear when answered", async () => {
  const sends: Array<{ content: string; components: any[] }> = []
  const edits: Array<{ id: string; content: string; components: any[] }> = []
  const { db } = makeDb()
  let runner: Runner
  runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async (_t, liveId) => new Renderer({
      initialMessageId: liveId,
      send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return `m${sends.length}` },
      edit: async (id, c, components) => { edits.push({ id, content: c, components: components ?? [] }) },
      now: () => 0, intervalMs: 1,
    }),
    sessionFor: async () => "s1", log() {}, maxQueue: 5, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject" as const,
      askQuestion: async (input: any) => {
        runner.onQuestionState({ threadId: input.threadId, requestId: input.requestId, questions: input.questions, text: "**❓ The agent asked**\nWhich DB?", components: [{ type: 1 }] })
        await new Promise((r) => setTimeout(r, 0))
        runner.onQuestionState({ threadId: input.threadId, requestId: input.requestId, questions: input.questions, text: "**❓ The agent asked**\nWhich DB?\n**Answer:** sqlite", components: null })
        return [["sqlite"]]
      },
      cancel: () => {}, cancelThread: () => {},
    },
  })
  await runner.prompt("t1", "hi", "u")
  await runner.onEvent("t1", { kind: "text", sessionId: "s1", messageId: "m", partId: "p1", text: "Approaches A." })
  await runner.onEvent("t1", { kind: "question", sessionId: "s1", requestId: "q1", source: "v1", questions: [] })
  await vi.waitFor(() => expect(edits.at(-1)?.content).toContain("**Answer:** sqlite"))
  expect(sends[0]!.content).toBe("Approaches A.")
  expect(sends[0]!.components).toEqual([])
  const withControls = edits.find((e) => e.components.length > 0)!
  expect(withControls.content).toContain("Approaches A.")
  expect(withControls.content).toContain("Which DB?")
  expect(withControls.components).toEqual([{ type: 1 }])
  expect(edits.at(-1)!.components).toEqual([])
})

test("onQuestionState ignores threads without a live renderer", async () => {
  const painted: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => ({ push() {}, tick: async () => {}, finalize: async () => {}, flush: async () => {}, upsertQuestion: (...args: any[]) => painted.push(args) }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
  })
  runner.onQuestionState({ threadId: "other", requestId: "q1", questions: [], text: "Q", components: [] })
  await new Promise((r) => setTimeout(r, 0))
  expect(painted).toEqual([])
})

test("question events ensure the thread has a renderer before asking", async () => {
  let created = 0
  const asked: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => { created++; return makeRenderer() as any },
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject" as const,
      askQuestion: async (input: any) => { asked.push(input); return null },
      cancel: () => {}, cancelThread: () => {},
    },
  })
  await runner.onEvent("t1", { kind: "question", sessionId: "s1", requestId: "q1", source: "v1", questions: [] })
  expect(created).toBe(1)
  expect(asked).toHaveLength(1)
})

test("question.replied and question.rejected cancel the pending question", async () => {
  const cancelled: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject",
      askQuestion: async () => null,
      cancel: (sessionId: string, requestId: string) => { cancelled.push([sessionId, requestId]) },
      cancelThread: () => {},
    },
  })
  await runner.onEvent("t1", { kind: "question-replied", sessionId: "s1", requestId: "q1" })
  await runner.onEvent("t1", { kind: "question-rejected", sessionId: "s1", requestId: "q2" })
  expect(cancelled).toEqual([["s1", "q1"], ["s1", "q2"]])
})

test("permission.replied cancels a pending approval", async () => {
  const cancelled: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject",
      askQuestion: async () => null,
      cancel: (sessionId: string, requestId: string) => { cancelled.push([sessionId, requestId]) },
      cancelThread: () => {},
    },
  })
  await runner.onEvent("t1", { kind: "permission-replied", sessionId: "s1", requestId: "r9" })
  expect(cancelled).toEqual([["s1", "r9"]])
})

test("idle clears pending approvals for the thread", async () => {
  const cleared: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject",
      askQuestion: async () => null,
      cancel: () => {},
      cancelThread: (threadId: string) => { cleared.push(threadId) },
    },
  })
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(cleared).toEqual(["t1"])
})

test("withDirectory adds the query only when a directory is defined", () => {
  expect(withDirectory("/w/t1", { body: { title: "x" } })).toEqual({ body: { title: "x" }, query: { directory: "/w/t1" } })
  expect(withDirectory(null, { body: { title: "x" } })).toEqual({ body: { title: "x" } })
  expect(withDirectory(undefined, { path: { id: "s1" } })).toEqual({ path: { id: "s1" } })
})

test("prompt passes the thread worktree directory as query", async () => {
  const payloads: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { payloads.push(a) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1",
    directoryFor: (threadId: string) => (threadId === "t1" ? "/w/t1" : undefined),
    log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "hi", "u")
  await runner.prompt("t2", "hi", "u")
  expect(payloads[0].query).toEqual({ directory: "/w/t1" })
  expect(payloads[1].query).toBeUndefined()
})

test("abort passes the thread worktree directory as query", async () => {
  const aborts: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {}, abort: async (a: any) => { aborts.push(a) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", directoryFor: () => "/w/t1",
    log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  await runner.abort("t1")
  expect(aborts[0]).toEqual({ path: { id: "s1" }, query: { directory: "/w/t1" } })
})

test("recover passes the thread worktree directory to session.messages", async () => {
  const payloads: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async (a: any) => { payloads.push(a); return { data: [] } } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", directoryFor: () => "/w/t1",
    log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(payloads[0]).toEqual({ path: { id: "s1" }, query: { directory: "/w/t1" } })
})

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

test("runner keeps raw marker text for onFinalText and strips it from the rendered output", async () => {
  const statuses: string[] = []
  const finals: string[] = []
  const rendered: string[] = []
  const { db } = makeDb()
  let n = 0
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    createRenderer: async () => new Renderer({
      send: async (c) => { rendered.push(c); return "m" + (++n) },
      edit: async (_id, c) => { rendered.push(c) },
      now: () => 0, intervalMs: 1000,
    }),
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    onThreadState: (_id, s) => statuses.push(s),
    onFinalText: (_id, text) => finals.push(text),
  })
  await runner.prompt("t1", "go", "u")
  await runner.onEvent("t1", { kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "done\n:::celly-name Fix auth redirect loop\n" })
  await runner.onEvent("t1", { kind: "idle", sessionId: "s" })
  expect(statuses).toContain("working")
  expect(statuses).toContain("idle")
  expect(finals[0]).toContain(":::celly-name Fix auth redirect loop")
  expect(rendered.join("\n")).not.toContain(":::celly-name")
  expect(rendered[0]).toBe("done\n")
})
