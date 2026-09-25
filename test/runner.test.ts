// test/runner.test.ts
import { expect, test, vi } from "vitest"
import { evaluatePermission, normalizeCommand, Runner } from "../src/runner.ts"
import { Renderer } from "../src/render.ts"

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
test("allows the real opencode tool ids surfaced in permission requests", () => {
  const tools = ["list", "patch", "todowrite", "todoread", "multiedit", "write", "glob", "grep",
    "webfetch", "websearch", "task", "skill", "lsp", "doom_loop", "edit"]
  for (const tool of tools) expect(evaluatePermission({ tool, patterns: [] })).toBe("once")
})
test("still rejects a genuinely unknown tool", () => {
  expect(evaluatePermission({ tool: "totally_unknown_tool", patterns: [] })).toBe("reject")
})

test("normalizes commands before deny matching", () => {
  expect(normalizeCommand("  git    -c   x=y   push  ")).toBe("git push")
  expect(normalizeCommand("env FOO=bar git push")).toBe("git push")
  expect(normalizeCommand("/usr/bin/git push")).toBe("git push")
})

test("wrapper and global-option bypasses are still rejected", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["git -c x=y push origin"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["command git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env FOO=bar git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["npx npm publish"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["/usr/bin/git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["git   push   origin"] })).toBe("reject")
})

test("adversarial wrapper and env-prefix variants cannot bypass the deny list", () => {
  const variants = [
    "env -i git push",
    "env -u FOO git push",
    "env FOO=bar git push",
    "FOO=bar git push",
    "sudo -u x git push",
    "nice -n 10 git push",
    "time -p git push",
    "command -p git push",
    "npx --yes npm publish",
    "bash -c 'git push'",
    "bash -lc 'git push'",
    "sh -c 'npm publish --access public'",
    "env -i bash -c 'git clean -fdx .'",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("reject")
  }
})

test("normalization keeps benign wrapped commands allowed", () => {
  const variants = [
    "env -i npm test",
    "FOO=bar npm test",
    "sudo -u x git status",
    "nice -n 10 git status",
    "time -p git status",
    "command -p git status",
    "npx --yes tsc --noEmit",
    "bash -c 'npm test'",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("once")
  }
})

test("wrapper commands with no payload still match their deny pattern", () => {
  expect(normalizeCommand("env")).toBe("env")
  expect(normalizeCommand("env -i")).toBe("env")
  expect(evaluatePermission({ tool: "bash", patterns: ["env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env -i"] })).toBe("reject")
})

test("normalization does not deny benign wrapped commands", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["npx tsc --noEmit"] })).toBe("once")
  expect(evaluatePermission({ tool: "bash", patterns: ["git status"] })).toBe("once")
})

test("rejects environment-inspection deny patterns", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["printenv"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["printenv PATH"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["cat ~/.config/celly/opencode.env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["cat /root/.config/celly/opencode.env"] })).toBe("reject")
})

test("rejects the broadened env-inspection utilities against the celly config", () => {
  const commands = [
    "head -n 5 ~/.config/celly/opencode.env",
    "tail -1 ~/.config/celly/opencode.env",
    "base64 ~/.config/celly/opencode.env",
    "xxd ~/.config/celly/opencode.env",
    "od -c ~/.config/celly/opencode.env",
    "strings ~/.config/celly/opencode.env",
    "cp ~/.config/celly/opencode.env /tmp/leak",
    "less ~/.config/celly/opencode.env",
    "grep OPENCODE_SERVER_PASSWORD ~/.config/celly/opencode.env",
    "sed -n 1p ~/.config/celly/opencode.env",
    "awk '{print}' ~/.config/celly/opencode.env",
    "head -n 5 /root/.config/celly/other.json",
    "env -i cat ~/.config/celly/opencode.env",
  ]
  for (const command of commands) {
    expect(evaluatePermission({ tool: "bash", patterns: [command] }), command).toBe("reject")
  }
})

test("rejects read and grep tool paths into the celly config directory", () => {
  expect(evaluatePermission({ tool: "read", patterns: ["/root/.config/celly/opencode.env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "grep", patterns: ["/home/u/.config/celly/*"] })).toBe("reject")
  expect(evaluatePermission({ tool: "read", patterns: ["opencode.env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "read", patterns: ["/srv/project/README.md"] })).toBe("once")
})

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
  } as any
  return { db, states }
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

test("permission event responds with the evaluated decision", async () => {
  const responses: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {}, postSessionIdPermissionsPermissionId: async (a: any) => { responses.push(a) } }) as any,
    createRenderer: async () => makeRenderer() as any,
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
    createRenderer: async () => makeRenderer(pushed) as any,
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
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => { throw new Error("opencode server POST /session → 400 Bad Request: bad request") } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 1,
    onThreadIdle: (threadId) => { idle.push(threadId) } })
  await expect(runner.prompt("t1", "a", "u")).rejects.toThrow(/400/)
  expect(states).toContain("idle")
  expect(runner.activeCount).toBe(0)
  expect(idle).toEqual(["t1"])
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
  expect(pushed.some((p) => p.kind === "text" && /stopped/.test(p.text))).toBe(true)
})
