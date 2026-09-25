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

test("prompt queues a second message while active", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => {} }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  expect(await runner.prompt("t1", "a", "u")).toBeUndefined()
  expect(await runner.prompt("t1", "b", "u")).toBe("queued (1)")
})

test("rejects further prompts when the queue is full", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => {} }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 1, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  expect(await runner.prompt("t1", "b", "u")).toBe("queued (1)")
  expect(await runner.prompt("t1", "c", "u")).toBe("queue full")
})

test("returns busy when the global concurrency cap is reached", async () => {
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => {} }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1 })
  expect(await runner.prompt("t1", "a", "u")).toBeUndefined()
  expect(await runner.prompt("t2", "b", "u")).toBe("busy")
})

test("idle drains the queue", async () => {
  const sent: string[] = []
  const { db } = makeDb()
  const runner = new Runner({ db, clientFor: () => ({ session: { promptAsync: async (a: any) => { sent.push(a.body.parts[0].text) } }, postSessionIdPermissionsPermissionId: async () => {} }) as any,
    rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => {} }) as any,
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
    rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => {} }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", tool: "bash", patterns: ["git push origin main"] })
  expect(responses).toEqual([{ path: { id: "s1", permissionID: "p1" }, body: { response: "reject" } }])
})

test("error event finalizes, marks errored, and clears active", async () => {
  const finalized: number[] = []
  const { db, states } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {} } }) as any,
    rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => { finalized.push(1) } }) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  await runner.onEvent("t1", { kind: "error", sessionId: "s1", message: "boom" })
  expect(states).toContain("errored")
  expect(finalized.length).toBe(1)
  expect(runner.activeCount).toBe(0)
})

test("abort sets aborting, aborts the session, clears queue, then force-idles after 10s", async () => {
  vi.useFakeTimers()
  try {
    const aborted: string[] = []
    const { db, states } = makeDb("aborting")
    const runner = new Runner({ db,
      clientFor: () => ({ session: { promptAsync: async () => {}, abort: async (a: any) => { aborted.push(a.path.id) } } }) as any,
      rendererFor: async () => ({ push() {}, tick: async () => {}, finalize: async () => {} }) as any,
      sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
    await runner.prompt("t1", "first", "u")
    await runner.abort("t1")
    expect(states).toEqual(["running", "aborting"])
    expect(aborted).toEqual(["s1"])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(states[states.length - 1]).toBe("idle")
    expect(runner.activeCount).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test("recover lists session messages and resets render state to idle", async () => {
  const { db, states } = makeDb()
  let listed: any
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async (a: any) => { listed = a; return { data: [1, 2, 3] } } } }) as any,
    rendererFor: async () => ({}) as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(listed.path.id).toBe("s1")
  expect(states).toEqual(["idle"])
})
