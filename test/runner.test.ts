// test/runner.test.ts
import { expect, test, vi } from "vitest"
import { evaluatePermission, Runner } from "../src/runner.ts"

test("rejects deny-listed bash patterns", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["git push origin main"] }, ["git push*"])).toBe("reject")
})
test("allows non-matching patterns once", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["npm test"] }, ["git push*"])).toBe("once")
})
test("rejects non-bash tools by default (external_directory etc.)", () => {
  expect(evaluatePermission({ tool: "external_directory", patterns: [] }, [])).toBe("reject")
})
test("rejects default deny-listed publish and clean commands", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["npm publish --access public"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["git clean -fdx ."] })).toBe("reject")
})
test("allows an allowed tool with no deny matches", () => {
  expect(evaluatePermission({ tool: "read", patterns: [] })).toBe("once")
})

function makeDb(state = "running") {
  const states: string[] = []
  const db = {
    threads: {
      setRenderState(_t: string, s: string) { states.push(s) },
      touch() {},
      get() { return { renderState: state } },
    },
  } as any
  return { db, states }
}

function makeRenderer(calls: any[] = []) {
  return { push: (e: any) => calls.push(e), tick: async () => {}, finalize: async () => { calls.push({ finalize: true }) } }
}

test("prompt queues a second message while active", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    rendererFor: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  expect(await runner.prompt("t1", "a", "u")).toBeUndefined()
  expect(await runner.prompt("t1", "b", "u")).toBe("queued (1)")
})

test("rejects further prompts when the queue is full", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    rendererFor: async () => makeRenderer() as any,
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
    rendererFor: async () => makeRenderer() as any,
    sessionFor: async () => gate, log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  const first = runner.prompt("t1", "a", "u")
  expect(await runner.prompt("t1", "b", "u")).toBe("queued (1)")
  releaseSession("s1")
  await first
  expect(sent).toEqual(["a"])
})

test("returns busy when the global concurrency cap is reached", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    rendererFor: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1 })
  expect(await runner.prompt("t1", "a", "u")).toBeUndefined()
  expect(await runner.prompt("t2", "b", "u")).toBe("busy")
})

test("global cap is enforced atomically across overlapping prompts", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => { await gate } } }) as any,
    rendererFor: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1 })
  const first = runner.prompt("t1", "a", "u")
  expect(await runner.prompt("t2", "b", "u")).toBe("busy")
  release()
  await first
})

test("idle drains the queue", async () => {
  const sent: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } }, postSessionIdPermissionsPermissionId: async () => {} }) as any,
    rendererFor: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u"); await runner.prompt("t1", "second", "u")
  await runner.onEvent("t1", { kind: "idle", sessionId: "s1" })
  expect(sent).toEqual(["first", "second"])
  expect(runner.activeCount).toBe(1)
})

test("permission event responds with the evaluated decision", async () => {
  const responses: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {}, postSessionIdPermissionsPermissionId: async (a: any) => { responses.push(a) } }) as any,
    rendererFor: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", tool: "bash", patterns: ["git push origin main"] })
  expect(responses).toEqual([{ path: { id: "s1", permissionID: "p1" }, body: { response: "reject" } }])
})

test("session.error posts the error, sets idle, and drains the queue", async () => {
  const sent: string[] = []
  const pushed: any[] = []
  const { db, states } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } } }) as any,
    rendererFor: async () => makeRenderer(pushed) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "first", "u")
  await runner.prompt("t1", "second", "u")
  await runner.onEvent("t1", { kind: "error", sessionId: "s1", message: "boom" })
  expect(pushed.some((p) => p.kind === "text" && p.text === "[error] boom")).toBe(true)
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
      rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
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
      rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
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

test("abort on an idle thread is a no-op", async () => {
  const { db, states } = makeDb("idle")
  let aborts = 0
  const runner = new Runner({ db,
    clientFor: () => ({ session: { abort: async () => { aborts++ } } }) as any,
    rendererFor: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 1, maxConcurrentRuns: 1 })
  await runner.abort("t1")
  expect(states).toEqual([])
  expect(aborts).toBe(0)
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
    rendererFor: async () => makeRenderer(pushed) as any,
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
