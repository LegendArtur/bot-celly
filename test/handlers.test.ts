import { MessageFlags } from "discord.js"
import { expect, test, vi } from "vitest"
import { createForkThread, createMessageHandler, createProjectDownHandler, createProjectMissingHandler, createReadyHandler, createReconcileThreads, createShutdown, createThreadArchiveHandler } from "../src/handlers.ts"
import { describeDiscordStartupError, formatStartupBanner } from "../src/helpers.ts"
import type { Project } from "../src/types.ts"
import { freshDb, projectFixture, silentLogger, threadRow } from "./helpers/fixtures.ts"

const project = (over: Partial<Project> = {}) => projectFixture({ status: "ready", ...over })

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
    id: over.id ?? "msg1",
    inGuild: () => true,
    guild: { ownerId: "owner" },
    member: { id: "u1", permissions: { has: () => true }, roles: { cache: new Map() } },
    author: { id: "u1", bot: false },
    content: over.content ?? "hello",
    channel,
    channelId: channel.id,
    guildId: over.guildId ?? "g",
    webhookId: null,
    system: false,
    attachments: { values: () => attachments[Symbol.iterator](), first: () => attachments[0] },
    reply: async (o: any) => { replies.push(o); return { id: "reply" } },
  }
  return { message, sent, replies }
}

function baseDeps(db: any, over: any = {}) {
  return {
    db, log: silentLogger,
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
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db)
  const { message } = fakeMessage({ content: "build the thing" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).not.toHaveBeenCalled()
  expect(deps.createThread).toHaveBeenCalledWith({ channelId: "c", title: "build the thing", prompt: "build the thing", authorId: "u1", originMessageId: "msg1" })
})

test("an archived thread posts a remove-session notice replying to its origin message", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow({ originMessageId: "m1" }))
  const sends: any[] = []
  const handler = createThreadArchiveHandler({
    db, isActive: () => false, now: () => 111, log: silentLogger,
    send: async (channelId, payload, replyTo) => { sends.push({ channelId, payload, replyTo }) },
  })
  await handler({ id: "t1", archived: false }, { id: "t1", archived: true })
  expect(sends).toHaveLength(1)
  expect(sends[0].channelId).toBe("c")
  expect(sends[0].replyTo).toBe("m1")
  expect(sends[0].payload.content).toContain("<#t1>")
  expect(sends[0].payload.components[0].components.map((b: any) => b.custom_id))
    .toEqual(["celly:archive:t1:keep", "celly:archive:t1:remove"])
  expect(db.threads.get("t1")?.archiveNoticeAt).toBe(111)
})

test("an archived thread without an origin posts a plain notice", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow())
  const sends: any[] = []
  const handler = createThreadArchiveHandler({
    db, isActive: () => false, now: () => 1, log: silentLogger,
    send: async (channelId, payload, replyTo) => { sends.push({ channelId, payload, replyTo }) },
  })
  await handler({ id: "t1", archived: false }, { id: "t1", archived: true })
  expect(sends[0].replyTo).toBeNull()
})

test("the archive handler ignores non-transitions, active runs, unmanaged threads, and repeats", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow())
  const sends: any[] = []
  const send = async (channelId: string, payload: any, replyTo: any) => { sends.push({ channelId, payload, replyTo }) }
  await createThreadArchiveHandler({ db, isActive: () => false, now: () => 1, log: silentLogger, send })({ id: "t1", archived: true }, { id: "t1", archived: true })
  await createThreadArchiveHandler({ db, isActive: () => false, now: () => 1, log: silentLogger, send })({ id: "t1", archived: false }, { id: "t1", archived: false })
  await createThreadArchiveHandler({ db, isActive: () => true, now: () => 1, log: silentLogger, send })({ id: "t1", archived: false }, { id: "t1", archived: true })
  await createThreadArchiveHandler({ db, isActive: () => false, now: () => 1, log: silentLogger, send })({ id: "nope", archived: false }, { id: "nope", archived: true })
  expect(sends).toEqual([])
  // a repeat archive after a notice was posted does not post again
  db.threads.setArchiveNotice("t1", 5)
  await createThreadArchiveHandler({ db, isActive: () => false, now: () => 9, log: silentLogger, send })({ id: "t1", archived: false }, { id: "t1", archived: true })
  expect(sends).toEqual([])
})

test("a queued first message that created a thread surfaces the notice", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { createThread: vi.fn(async () => ({ threadId: "tnew", sessionId: "snew", notice: "queued (1)" })) })
  const { message, replies } = fakeMessage({ content: "build the thing" })
  await createMessageHandler(deps)(message)
  expect(replies.map((r) => r.content)).toEqual(["queued (1)"])
  expect(replies.every((r) => r.allowedMentions?.parse?.length === 0)).toBe(true)
  expect(deps.startTyping).toHaveBeenCalledWith("tnew")
})

test("a 'queue full' first message that created a thread surfaces the notice without typing", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { createThread: vi.fn(async () => ({ threadId: "tnew", sessionId: "snew", notice: "queue full" })) })
  const { message, replies } = fakeMessage({ content: "build the thing" })
  await createMessageHandler(deps)(message)
  expect(replies.map((r) => r.content)).toEqual(["queue full"])
  expect(deps.startTyping).not.toHaveBeenCalled()
})

test("a handler failure posts an error card without mentions", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { projects: { ensureReady: vi.fn(async () => { throw new Error("sandbox down") }) } })
  const { message, replies } = fakeMessage({ content: "hello" })
  await createMessageHandler(deps)(message)
  expect(replies.length).toBe(1)
  expect(replies[0].flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2)
  expect(JSON.stringify(replies[0].components[0].toJSON())).toMatch(/went wrong/i)
  expect(replies[0].allowedMentions).toEqual({ parse: [] })
})

test("message in a registered thread continues the session", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow())
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "t1", parentId: "c", isThread: () => true, content: "more" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t1", "more", "u1")
  expect(deps.registerSession).toHaveBeenCalledWith("t1", "s1")
  expect(deps.createThread).not.toHaveBeenCalled()
})

test("archived thread with null parentId is routed by the DB record", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow())
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "t1", parentId: null, isThread: () => true, content: "after 24h" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t1", "after 24h", "u1")
})

test("messages outside a project channel are ignored", async () => {
  const db = freshDb()
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "other" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).not.toHaveBeenCalled()
  expect(deps.createThread).not.toHaveBeenCalled()
})

test("unauthorized messages are ignored", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { isAuthorized: () => false })
  const { message } = fakeMessage()
  await createMessageHandler(deps)(message)
  expect(deps.createThread).not.toHaveBeenCalled()
})

test("!shell streams the command output through the channel bucket", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { runShell: vi.fn(async () => ["out1", "out2"]) })
  const { message, sent } = fakeMessage({ content: "!echo hi" })
  await createMessageHandler(deps)(message)
  expect(deps.runShell).toHaveBeenCalledWith("c", "echo hi")
  expect(sent.map((s) => s.content)).toEqual(["out1", "out2"])
  expect(sent.every((s) => s.allowedMentions?.parse?.length === 0)).toBe(true)
})

test("attachment ingest feeds the sandbox path into the prompt", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow())
  const deps = baseDeps(db, { ingestAttachments: vi.fn(async () => [{ hostPath: "C:\\p\\.celly\\inbox\\a", sandboxPath: "/sandbox/.celly/inbox/a" }]) })
  const { message } = fakeMessage({ channelId: "t1", parentId: "c", isThread: () => true, content: "see file" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t1", "see file\n\n[attachment] /sandbox/.celly/inbox/a", "u1")
})

test("a run notice is replied to the message", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow())
  const deps = baseDeps(db, { runner: { prompt: vi.fn(async () => "queued (1)") } })
  const { message, replies } = fakeMessage({ channelId: "t1", parentId: "c", isThread: () => true })
  await createMessageHandler(deps)(message)
  expect(replies.map((r) => r.content)).toEqual(["queued (1)"])
})

test("a message in a thread resolves its owning project across guilds", async () => {
  const db = freshDb()
  db.projects.insertProvisioning(project({ channelId: "c1", guildId: "g1", name: "one", sandboxName: "celly-one", hostPort: 4300 })); db.projects.setReady("c1", "C:\\p1")
  db.projects.insertProvisioning(project({ channelId: "c2", guildId: "g2", name: "two", sandboxName: "celly-two", hostPort: 4301 })); db.projects.setReady("c2", "C:\\p2")
  db.threads.upsert(threadRow({ threadId: "t2", channelId: "c2", sessionId: "s2" }))
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "t2", parentId: null, isThread: () => true, guildId: "g2", content: "hello" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t2", "hello", "u1")
})

test("project-down handler fans out to the runner and notifies the channel once", async () => {
  const handleProjectDown = vi.fn(async () => {})
  const send = vi.fn(async () => ({}))
  const handler = createProjectDownHandler({
    runner: { handleProjectDown },
    client: { channels: { cache: { get: (id: string) => (id === "c" ? { send } : undefined) } } },
    bucketFor: () => ({ schedule: (fn: any) => fn() }),
    log: silentLogger,
  })
  handler("c")
  await new Promise((r) => setTimeout(r, 0))
  expect(handleProjectDown).toHaveBeenCalledWith("c")
  expect(send).toHaveBeenCalledTimes(1)
  const payload = send.mock.calls[0][0]
  expect(payload.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2)
  expect(JSON.stringify(payload.components[0].toJSON())).toMatch(/stopped unexpectedly|Project server stopped/)
  expect(payload.allowedMentions).toEqual({ parse: [] })
})

test("project-missing handler notifies the channel with a recreate action", async () => {
  const handleProjectDown = vi.fn(async () => {})
  const send = vi.fn(async () => ({}))
  const handler = createProjectMissingHandler({
    runner: { handleProjectDown },
    client: { channels: { cache: { get: (id: string) => (id === "c" ? { send } : undefined) } } },
    bucketFor: () => ({ schedule: (fn: any) => fn() }),
    log: silentLogger,
  })
  handler("c", "demo")
  await new Promise((r) => setTimeout(r, 0))
  expect(handleProjectDown).toHaveBeenCalledWith("c")
  const payload = send.mock.calls[0][0]
  const card = JSON.stringify(payload.components[0].toJSON())
  expect(card).toMatch(/demo/)
  expect(card).toMatch(/\/project start/)
  expect(payload.allowedMentions).toEqual({ parse: [] })
})

test("shutdown aborts subscriptions, stops projects, closes db, releases the lock, then exits", async () => {
  const order: string[] = []
  const controller = new AbortController()
  const shutdown = createShutdown({
    log: silentLogger,
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
    log: silentLogger,
    subscribeReadyProjects: () => { order.push("subscribe") },
    reconcileThreads: async () => { order.push("reconcile") },
  })
  ready()
  await new Promise((r) => setTimeout(r, 0))
  expect(order).toEqual(["subscribe", "reconcile"])
})

test("ready handler runs subscribe and reconcile only once", async () => {
  const subscribe = vi.fn()
  const reconcile = vi.fn(async () => {})
  const ready = createReadyHandler({ log: silentLogger, subscribeReadyProjects: subscribe, reconcileThreads: reconcile })
  ready()
  ready()
  await new Promise((r) => setTimeout(r, 0))
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(reconcile).toHaveBeenCalledTimes(1)
})

test("boot reconcile recovers live runs and resets stale states", async () => {
  const db = freshDb()
  db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow({ threadId: "t-run", renderState: "running" }))
  db.threads.upsert(threadRow({ threadId: "t-abort", renderState: "aborting" }))
  db.threads.upsert(threadRow({ threadId: "t-err", renderState: "errored" }))
  const recovered: string[] = []
  const reconcile = createReconcileThreads({ db, runner: { recover: async (t: any) => { recovered.push(t.threadId) } }, log: silentLogger })
  await reconcile()
  expect(recovered.sort()).toEqual(["t-abort", "t-run"])
  expect(db.threads.get("t-err")?.renderState).toBe("idle")
})

test("boot reconcile resets threads whose project is not ready", async () => {
  const db = freshDb()
  db.projects.insertProvisioning(project())
  db.projects.setStatus("c", "degraded")
  db.threads.upsert(threadRow({ threadId: "t1", renderState: "running" }))
  const recover = vi.fn(async () => {})
  const reconcile = createReconcileThreads({ db, runner: { recover }, log: silentLogger })
  await reconcile()
  expect(recover).not.toHaveBeenCalled()
  expect(db.threads.get("t1")?.renderState).toBe("idle")
})

test("concurrent reconcile calls share one pass", async () => {
  const db = freshDb()
  db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow({ threadId: "t-run", renderState: "running" }))
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let calls = 0
  const reconcile = createReconcileThreads({ db, runner: { recover: async () => { calls++; await gate } }, log: silentLogger })
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
    log: silentLogger,
  })
  expect(() => handler("c")).not.toThrow()
  await new Promise((r) => setTimeout(r, 0))
  expect(send).toHaveBeenCalledTimes(1)
})

test("an authorized message touches the project's activity clock", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db)
  vi.useFakeTimers()
  try {
    vi.setSystemTime(5000)
    const { message } = fakeMessage({ content: "hello" })
    await createMessageHandler(deps)(message)
    expect(db.projects.getByChannel("c")?.lastActiveAt).toBe(5000)
  } finally {
    vi.useRealTimers()
  }
})

test("a !shell command touches the project's activity clock", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { runShell: vi.fn(async () => ["out"]) })
  vi.useFakeTimers()
  try {
    vi.setSystemTime(7000)
    const { message } = fakeMessage({ content: "!echo hi" })
    await createMessageHandler(deps)(message)
    expect(deps.runShell).toHaveBeenCalledWith("c", "echo hi")
    expect(db.projects.getByChannel("c")?.lastActiveAt).toBe(7000)
  } finally {
    vi.useRealTimers()
  }
})

test("an unauthorized message does not touch project activity", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const deps = baseDeps(db, { isAuthorized: () => false })
  const { message } = fakeMessage()
  await createMessageHandler(deps)(message)
  expect(db.projects.getByChannel("c")?.lastActiveAt).toBe(0)
})

test("describeDiscordStartupError explains the Message Content intent", () => {
  const message = describeDiscordStartupError(new Error("Used disallowed intents"))
  expect(message).toMatch(/Message Content Intent/)
  expect(message).toContain("discord.com/developers/applications")
})
test("describeDiscordStartupError explains an invalid token", () => {
  expect(describeDiscordStartupError(new Error("An invalid token was provided."))).toMatch(/DISCORD_TOKEN/)
})
test("describeDiscordStartupError passes through unknown errors", () => {
  expect(describeDiscordStartupError(new Error("boom"))).toBe("boom")
})
test("describeDiscordStartupError colors the headline only when asked", () => {
  const colored = describeDiscordStartupError(new Error("Used disallowed intents"), { color: true })
  expect(colored).toContain("\x1b[31mDiscord rejected the bot's privileged intents")
  expect(colored).toContain("\x1b[0m")
  const plain = describeDiscordStartupError(new Error("Used disallowed intents"), { color: false })
  expect(plain).not.toContain("\x1b[")
  expect(describeDiscordStartupError(new Error("boom"), { color: true })).toBe("boom")
})

test("formatStartupBanner lists every guild and flags its missing permissions", () => {
  const ok = formatStartupBanner({
    guilds: [
      { id: "g1", name: "Guild One", missingPermissions: [] },
      { id: "g2", name: "Guild Two", missingPermissions: [] },
    ],
    projects: 2, dataDir: "./data", model: "anthropic/x", adminUrl: "http://127.0.0.1:4560",
  }, { color: false })
  expect(ok).toContain("Celly is running")
  expect(ok).toContain("Projects  2")
  expect(ok).toContain("Model     anthropic/x")
  expect(ok).toContain("Console   http://127.0.0.1:4560")
  expect(ok).toContain("Guild     Guild One (g1)")
  expect(ok).toContain("Guild     Guild Two (g2)")
  expect(ok).toContain("Next")
  const bad = formatStartupBanner({
    guilds: [{ id: "g1", name: "Guild One", missingPermissions: ["Manage Channels"] }],
    projects: 0, dataDir: "./data",
  }, { color: false })
  expect(bad).toMatch(/MISSING\s+Manage Channels/)
  expect(bad).toContain("/project add")
  expect(bad).toContain("Console   disabled")
})
test("formatStartupBanner paints the title, rule, and missing permissions only when color is on", () => {
  const info = { guilds: [{ id: "g1", name: "Guild One", missingPermissions: ["Manage Channels"] }], projects: 1, dataDir: "./data" }
  const plain = formatStartupBanner(info, { color: false })
  expect(plain).not.toContain("\x1b[")
  const colored = formatStartupBanner(info, { color: true })
  expect(colored).toContain("\x1b[36mCelly is running\x1b[0m")
  expect(colored).toContain("\x1b[31mMISSING   Manage Channels\x1b[0m")
})

test("!shell appends an audit entry with the verbatim command", async () => {
  const db = freshDb(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const audits: any[] = []
  const deps = baseDeps(db, { runShell: vi.fn(async () => ["ok"]), audit: (e: any) => audits.push(e) })
  const { message } = fakeMessage({ content: "!echo hi" })
  await createMessageHandler(deps)(message)
  expect(audits).toEqual([{ kind: "shell", channelId: "c", threadId: "c", actorId: "u1", detail: "echo hi", decision: "run" }])
})

test("createForkThread forks the session and copies model, agent, and worktree", async () => {
  const db = freshDb()
  db.projects.insertProvisioning({ channelId: "c", guildId: "g", name: "demo", directory: "C:\\p",
    sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 })
  db.threads.upsert({ threadId: "t1", channelId: "c", sessionId: "s1", title: "source", model: "anthropic/claude",
    agent: "build", variant: "high", worktreePath: "/sandbox/celly-demo/workspace/.celly/worktrees/t1",
    liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1 })
  const forkCalls: any[] = []
  const created: any[] = []
  const prompted: string[] = []
  const fork = createForkThread({
    db,
    client: { channels: { fetch: async () => ({ threads: { create: async (o: any) => { created.push(o); return { id: "t9", members: { add: async () => {} } } } } }) } },
    runner: { prompt: async (threadId: string) => { prompted.push(threadId); return undefined } },
    ensureReady: async () => {},
    resolveClient: () => ({ session: { fork: async (a: any) => { forkCalls.push(a); return { data: { id: "s9" } } } } }),
    registerSession: () => {},
    startTyping: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} } as any,
  })
  const result = await fork({ sourceThreadId: "t1", title: "btw · hi", prompt: "hi", authorId: "u1" })
  expect(forkCalls).toEqual([{ path: { id: "s1" }, query: { directory: "/sandbox/celly-demo/workspace/.celly/worktrees/t1" } }])
  expect(created).toEqual([{ name: "btw · hi" }])
  expect(db.threads.get("t9")).toMatchObject({ sessionId: "s9", model: "anthropic/claude", agent: "build", variant: "high",
    worktreePath: "/sandbox/celly-demo/workspace/.celly/worktrees/t1", channelId: "c" })
  expect(result).toEqual({ threadId: "t9", sessionId: "s9", notice: undefined })
  expect(prompted).toEqual(["t9"])
})

test("createForkThread with worktree:true forks into a fresh worktree", async () => {
  const db = freshDb()
  db.projects.insertProvisioning({ channelId: "c", guildId: "g", name: "demo", directory: "C:\\p",
    sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 })
  db.threads.upsert({ threadId: "t1", channelId: "c", sessionId: "s1", title: "source", model: null,
    agent: null, variant: null, worktreePath: "/sandbox/celly-demo/workspace/.celly/worktrees/t1",
    liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1 })
  const forkCalls: any[] = []
  const ensured: string[] = []
  const fork = createForkThread({
    db,
    client: { channels: { fetch: async () => ({ threads: { create: async () => ({ id: "t9", members: { add: async () => {} } }) } }) } },
    runner: { prompt: async () => undefined },
    ensureReady: async () => {},
    resolveClient: () => ({ session: { fork: async (a: any) => { forkCalls.push(a); return { data: { id: "s9" } } } } }),
    registerSession: () => {},
    startTyping: () => {},
    worktree: { ensure: async (_project, threadId) => { ensured.push(threadId); return "/sandbox/celly-demo/workspace/.celly/worktrees/t9" } },
    log: { info() {}, warn() {}, error() {}, debug() {} } as any,
  })
  await fork({ sourceThreadId: "t1", title: "fork", worktree: true })
  expect(ensured).toEqual(["t9"])
  expect(forkCalls).toEqual([{ path: { id: "s1" }, query: { directory: "/sandbox/celly-demo/workspace/.celly/worktrees/t9" } }])
  expect(db.threads.get("t9")?.worktreePath).toBe("/sandbox/celly-demo/workspace/.celly/worktrees/t9")
})

test("createForkThread with worktree:true falls back to the source root when ensure returns null", async () => {
  const db = freshDb()
  db.projects.insertProvisioning({ channelId: "c", guildId: "g", name: "demo", directory: "C:\\p",
    sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 })
  db.threads.upsert({ threadId: "t1", channelId: "c", sessionId: "s1", title: "source", model: null,
    agent: null, variant: null, worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1 })
  const forkCalls: any[] = []
  const fork = createForkThread({
    db,
    client: { channels: { fetch: async () => ({ threads: { create: async () => ({ id: "t9", members: { add: async () => {} } }) } }) } },
    runner: { prompt: async () => undefined },
    ensureReady: async () => {},
    resolveClient: () => ({ session: { fork: async (a: any) => { forkCalls.push(a); return { data: { id: "s9" } } } } }),
    registerSession: () => {},
    startTyping: () => {},
    worktree: { ensure: async () => null },
    log: { info() {}, warn() {}, error() {}, debug() {} } as any,
  })
  await fork({ sourceThreadId: "t1", title: "fork", worktree: true })
  expect(forkCalls).toEqual([{ path: { id: "s1" } }])
  expect(db.threads.get("t9")?.worktreePath).toBeNull()
})
