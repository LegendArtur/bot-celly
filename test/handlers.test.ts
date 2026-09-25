import { expect, test, vi } from "vitest"
import { openDb } from "../src/db.ts"
import { createMessageHandler, createProjectDownHandler, createProjectMissingHandler, createReadyHandler, createReconcileThreads, createShutdown } from "../src/handlers.ts"
import type { Project, Thread } from "../src/types.ts"

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as any

function fresh() { const db = openDb(":memory:"); db.migrate(); return db }

const project = (over: Partial<Project> = {}): Project => ({
  channelId: "c", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null,
  sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", status: "ready", createdAt: 1, ...over,
})
const thread = (over: Partial<Thread> = {}): Thread => ({
  threadId: "t1", channelId: "c", sessionId: "s1", title: "hello", model: null, agent: null,
  worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1, ...over,
})

function fakeMessage(over: any = {}) {
  const sent: any[] = []
  const replies: any[] = []
  const attachments = over.attachments ?? []
  const channel: any = {
    id: over.channelId ?? "c",
    parentId: over.parentId ?? null,
    isThread: over.isThread ?? (() => false),
    send: async (o: any) => { sent.push(o); return { id: "live" } },
  }
  const message: any = {
    inGuild: () => true,
    guild: { ownerId: "owner" },
    member: { id: "u1", permissions: { has: () => true }, roles: { cache: new Map() } },
    author: { id: "u1", bot: false },
    content: over.content ?? "hello",
    channel,
    channelId: channel.id,
    webhookId: null,
    system: false,
    attachments: { values: () => attachments[Symbol.iterator](), first: () => attachments[0] },
    reply: async (o: any) => { replies.push(o); return { id: "reply" } },
  }
  return { message, sent, replies }
}

function baseDeps(db: any, over: any = {}) {
  return {
    db, log: silent,
    projects: { ensureReady: async () => {} },
    runner: { prompt: vi.fn(async () => undefined) },
    bucketFor: () => ({ schedule: (fn: any) => fn() }),
    subscribeProject: vi.fn(),
    isAuthorized: () => true,
    ingestAttachments: vi.fn(async () => []),
    runShell: vi.fn(async () => []),
    startTyping: vi.fn(),
    createThread: vi.fn(async () => ({ threadId: "tnew", sessionId: "snew" })),
    registerSession: vi.fn(),
    ...over,
  } as any
}

test("message in a project channel creates a thread and prompts", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db)
  const { message } = fakeMessage({ content: "build the thing" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).not.toHaveBeenCalled()
  expect(deps.createThread).toHaveBeenCalledWith({ channelId: "c", title: "build the thing", prompt: "build the thing", authorId: "u1" })
})

test("a queued first message that created a thread surfaces the notice", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { createThread: vi.fn(async () => ({ threadId: "tnew", sessionId: "snew", notice: "queued (1)" })) })
  const { message, replies } = fakeMessage({ content: "build the thing" })
  await createMessageHandler(deps)(message)
  expect(replies.map((r) => r.content)).toEqual(["queued (1)"])
  expect(replies.every((r) => r.allowedMentions?.parse?.length === 0)).toBe(true)
  expect(deps.startTyping).toHaveBeenCalledWith("tnew")
})

test("a 'queue full' first message that created a thread surfaces the notice without typing", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { createThread: vi.fn(async () => ({ threadId: "tnew", sessionId: "snew", notice: "queue full" })) })
  const { message, replies } = fakeMessage({ content: "build the thing" })
  await createMessageHandler(deps)(message)
  expect(replies.map((r) => r.content)).toEqual(["queue full"])
  expect(deps.startTyping).not.toHaveBeenCalled()
})

test("a handler failure posts a plain error notice without mentions", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { projects: { ensureReady: vi.fn(async () => { throw new Error("sandbox down") }) } })
  const { message, replies } = fakeMessage({ content: "hello" })
  await createMessageHandler(deps)(message)
  expect(replies.length).toBe(1)
  expect(replies[0].content).toMatch(/went wrong/i)
  expect(replies[0].allowedMentions).toEqual({ parse: [] })
})

test("message in a registered thread continues the session", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(thread())
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "t1", parentId: "c", isThread: () => true, content: "more" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t1", "more", "u1")
  expect(deps.registerSession).toHaveBeenCalledWith("t1", "s1")
  expect(deps.createThread).not.toHaveBeenCalled()
})

test("archived thread with null parentId is routed by the DB record", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(thread())
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "t1", parentId: null, isThread: () => true, content: "after 24h" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t1", "after 24h", "u1")
})

test("messages outside a project channel are ignored", async () => {
  const db = fresh()
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "other" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).not.toHaveBeenCalled()
  expect(deps.createThread).not.toHaveBeenCalled()
})

test("unauthorized messages are ignored", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { isAuthorized: () => false })
  const { message } = fakeMessage()
  await createMessageHandler(deps)(message)
  expect(deps.createThread).not.toHaveBeenCalled()
})

test("!shell streams the command output through the channel bucket", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { runShell: vi.fn(async () => ["out1", "out2"]) })
  const { message, sent } = fakeMessage({ content: "!echo hi" })
  await createMessageHandler(deps)(message)
  expect(deps.runShell).toHaveBeenCalledWith("c", "echo hi")
  expect(sent.map((s) => s.content)).toEqual(["out1", "out2"])
  expect(sent.every((s) => s.allowedMentions?.parse?.length === 0)).toBe(true)
})

test("attachment ingest feeds the sandbox path into the prompt", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(thread())
  const deps = baseDeps(db, { ingestAttachments: vi.fn(async () => [{ hostPath: "C:\\p\\.celly\\inbox\\a", sandboxPath: "/sandbox/.celly/inbox/a" }]) })
  const { message } = fakeMessage({ channelId: "t1", parentId: "c", isThread: () => true, content: "see file" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t1", "see file\n\n[attachment] /sandbox/.celly/inbox/a", "u1")
})

test("a run notice is replied to the message", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(thread())
  const deps = baseDeps(db, { runner: { prompt: vi.fn(async () => "queued (1)") } })
  const { message, replies } = fakeMessage({ channelId: "t1", parentId: "c", isThread: () => true })
  await createMessageHandler(deps)(message)
  expect(replies.map((r) => r.content)).toEqual(["queued (1)"])
})

test("project-down handler fans out to the runner and notifies the channel once", async () => {
  const handleProjectDown = vi.fn(async () => {})
  const send = vi.fn(async () => ({}))
  const handler = createProjectDownHandler({
    runner: { handleProjectDown },
    client: { channels: { cache: { get: (id: string) => (id === "c" ? { send } : undefined) } } },
    bucketFor: () => ({ schedule: (fn: any) => fn() }),
    log: silent,
  })
  handler("c")
  await new Promise((r) => setTimeout(r, 0))
  expect(handleProjectDown).toHaveBeenCalledWith("c")
  expect(send).toHaveBeenCalledTimes(1)
  const payload = send.mock.calls[0][0]
  expect(payload.content).toMatch(/stopped unexpectedly/)
  expect(payload.allowedMentions).toEqual({ parse: [] })
})

test("project-missing handler notifies the channel with a recreate action", async () => {
  const handleProjectDown = vi.fn(async () => {})
  const send = vi.fn(async () => ({}))
  const handler = createProjectMissingHandler({
    runner: { handleProjectDown },
    client: { channels: { cache: { get: (id: string) => (id === "c" ? { send } : undefined) } } },
    bucketFor: () => ({ schedule: (fn: any) => fn() }),
    log: silent,
  })
  handler("c", "demo")
  await new Promise((r) => setTimeout(r, 0))
  expect(handleProjectDown).toHaveBeenCalledWith("c")
  const payload = send.mock.calls[0][0]
  expect(payload.content).toMatch(/demo/)
  expect(payload.content).toMatch(/\/project start/)
  expect(payload.allowedMentions).toEqual({ parse: [] })
})

test("shutdown aborts subscriptions, stops projects, closes db, releases the lock, then exits", async () => {
  const order: string[] = []
  const controller = new AbortController()
  const shutdown = createShutdown({
    log: silent,
    abortControllers: () => [controller],
    stopProjects: async () => { order.push("stop") },
    destroyClient: () => { order.push("destroy") },
    closeDb: () => { order.push("db") },
    releaseLock: () => { order.push("lock") },
    exit: (code) => { order.push(`exit:${code}`) },
  })
  await shutdown()
  expect(controller.signal.aborted).toBe(true)
  expect(order).toEqual(["stop", "destroy", "db", "lock", "exit:0"])
  await shutdown()
  expect(order).toEqual(["stop", "destroy", "db", "lock", "exit:0"])
})

test("ready handler subscribes then reconciles", async () => {
  const order: string[] = []
  const ready = createReadyHandler({
    log: silent,
    subscribeReadyProjects: () => { order.push("subscribe") },
    reconcileThreads: async () => { order.push("reconcile") },
  })
  ready()
  await new Promise((r) => setTimeout(r, 0))
  expect(order).toEqual(["subscribe", "reconcile"])
})

test("boot reconcile recovers live runs and resets stale states", async () => {
  const db = fresh()
  db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(thread({ threadId: "t-run", renderState: "running" }))
  db.threads.upsert(thread({ threadId: "t-abort", renderState: "aborting" }))
  db.threads.upsert(thread({ threadId: "t-err", renderState: "errored" }))
  const recovered: string[] = []
  const reconcile = createReconcileThreads({ db, runner: { recover: async (t: any) => { recovered.push(t.threadId) } }, log: silent })
  await reconcile()
  expect(recovered.sort()).toEqual(["t-abort", "t-run"])
  expect(db.threads.get("t-err")?.renderState).toBe("idle")
})

test("boot reconcile resets threads whose project is not ready", async () => {
  const db = fresh()
  db.projects.insertProvisioning(project())
  db.projects.setStatus("c", "degraded")
  db.threads.upsert(thread({ threadId: "t1", renderState: "running" }))
  const recover = vi.fn(async () => {})
  const reconcile = createReconcileThreads({ db, runner: { recover }, log: silent })
  await reconcile()
  expect(recover).not.toHaveBeenCalled()
  expect(db.threads.get("t1")?.renderState).toBe("idle")
})

test("concurrent reconcile calls share one pass", async () => {
  const db = fresh()
  db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(thread({ threadId: "t-run", renderState: "running" }))
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let calls = 0
  const reconcile = createReconcileThreads({ db, runner: { recover: async () => { calls++; await gate } }, log: silent })
  const first = reconcile()
  const second = reconcile()
  release()
  await Promise.all([first, second])
  expect(calls).toBe(1)
  await reconcile()
  expect(calls).toBe(2)
})

test("project-down handler swallows a rejected runner reset", async () => {
  const handleProjectDown = vi.fn(async () => { throw new Error("boom") })
  const send = vi.fn(async () => ({}))
  const handler = createProjectDownHandler({
    runner: { handleProjectDown },
    client: { channels: { cache: { get: () => ({ send }) } } },
    bucketFor: () => ({ schedule: (fn: any) => fn() }),
    log: silent,
  })
  expect(() => handler("c")).not.toThrow()
  await new Promise((r) => setTimeout(r, 0))
  expect(send).toHaveBeenCalledTimes(1)
})
