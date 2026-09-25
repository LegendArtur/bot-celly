// test/commands.test.ts
import { expect, test } from "vitest"
import { commandData, handleCommand, handleSelect, requiresOwner } from "../src/commands.ts"
import { isOwner } from "../src/discord.ts"
import { openDb } from "../src/db.ts"

function fresh() { const db = openDb(":memory:"); db.migrate(); return db }

const proj = { channelId: "c", guildId: "g", name: "demo", directory: "C:\\p",
  sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 }

function interaction(over: any = {}) {
  const calls: any[] = []
  const strings = over.strings ?? {}
  const i: any = {
    commandName: over.commandName ?? "project",
    guildId: over.guildId ?? "g",
    channelId: over.channelId ?? "c",
    channel: over.channel,
    user: over.user ?? { id: "u1" },
    calls,
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => strings[n],
    },
    deferReply: async (o: any) => { calls.push({ kind: "defer", o }) },
    editReply: async (c: any) => { calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}

function select(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    customId: over.customId,
    values: over.values ?? [],
    channelId: over.channelId ?? "c",
    user: over.user ?? { id: "u1" },
    inGuild: () => true, member: {}, memberPermissions: {},
    calls,
    deferUpdate: async () => { calls.push({ kind: "deferUpdate" }) },
    update: async (o: any) => { calls.push({ kind: "update", o }) },
    editReply: async (c: any) => { calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}
const editOf = (i: any) => {
  const c = i.calls.find((c: any) => c.kind === "edit")?.c
  if (c == null || typeof c === "string") return c
  return c.components ? c : c.content
}

test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "model", "new", "project", "resume"])
})
test("project has the expected subcommands", () => {
  const project = commandData().find((c) => c.name === "project")!
  const subs = project.options.map((o: any) => o.name).sort()
  expect(subs).toEqual(["add", "create", "list", "remove", "start", "status", "stop"])
})
test("handleCommand defers ephemerally and answers status", async () => {
  const i = interaction({ sub: "status", strings: { name: "demo" } })
  const db = fresh()
  db.projects.insertProvisioning(proj)
  db.projects.setReady("c", "C:\\p")
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(i.calls[0].kind).toBe("defer")
  expect(i.calls[0].o).toEqual({ flags: 64 })
  expect(editOf(i)).toMatch(/ready/)
})
test("project status reports health and the session count", async () => {
  const i = interaction({ sub: "status", strings: { name: "demo" } })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1"))
  await handleCommand(i, { projects: { health: async () => true } as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toContain("healthy")
  expect(editOf(i)).toContain("1 session")
})
test("project status reports unhealthy when the health probe fails", async () => {
  const i = interaction({ sub: "status", strings: { name: "demo" } })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  await handleCommand(i, { projects: { health: async () => { throw new Error("down") } } as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toContain("unhealthy")
  expect(editOf(i)).toContain("0 sessions")
})
test("project list includes sandbox status and health", async () => {
  const i = interaction({ sub: "list" })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  await handleCommand(i, { projects: { health: async () => true } as any, runner: {} as any, db, authorized: () => true })
  const out = editOf(i)
  expect(out).toContain("demo")
  expect(out).toContain("ready")
  expect(out).toContain("healthy")
})
test("project list reports unhealthy projects without hiding them", async () => {
  const i = interaction({ sub: "list" })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  await handleCommand(i, { projects: { health: async () => false } as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toContain("unhealthy")
})
test("unauthorized interactions are rejected before defer", async () => {
  const i = interaction({ sub: "status", strings: { name: "demo" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "You are not authorized.", flags: 64, allowedMentions: { parse: [] } } })
})
test("add reply never contains the server password", async () => {
  const i = interaction({ sub: "add", strings: { name: "demo", path: "C:\\p" } })
  const added = { ...proj, serverPassword: "SUPERSECRET" }
  await handleCommand(i, { projects: { addProject: async () => added } as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(editOf(i)).toContain("demo")
  expect(editOf(i)).not.toContain("SUPERSECRET")
})
test("add stages progress into the deferred reply and posts a connected notice", async () => {
  const i = interaction({ sub: "add", strings: { name: "demo", path: "C:\\p" } })
  const stages: string[] = []
  const connected: Array<[string, string]> = []
  const projects: any = {
    addProject: async (_input: any, onProgress: any) => {
      for (const s of ["creating sandbox…", "installing…", "waiting for server…"]) { stages.push(s); await onProgress?.(s) }
      return { ...proj, channelId: "chan-demo" }
    },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true,
    postConnected: async (channelId: string, name: string) => { connected.push([channelId, name]) } })
  const edits = i.calls.filter((c) => c.kind === "edit").map((c) => c.c)
  expect(edits).toEqual([
    { content: "creating sandbox…", allowedMentions: { parse: [] } },
    { content: "installing…", allowedMentions: { parse: [] } },
    { content: "waiting for server…", allowedMentions: { parse: [] } },
    { content: "added demo", allowedMentions: { parse: [] } },
  ])
  expect(stages).toEqual(["creating sandbox…", "installing…", "waiting for server…"])
  expect(connected).toEqual([["chan-demo", "demo"]])
})

test("every interaction edit and reply suppresses mentions", async () => {
  const i = interaction({ sub: "status", strings: { name: "demo" } })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  for (const call of i.calls) {
    if (call.kind === "defer") continue
    expect(call.c.allowedMentions).toEqual({ parse: [] })
  }
})

test("start/stop/remove on an unknown project reply not found", async () => {
  for (const sub of ["start", "stop", "remove"]) {
    const i = interaction({ sub, strings: { name: "ghost", confirm: "ghost" } })
    const projects: any = {
      ensureReady: async () => { throw new Error("ensureReady should not be called") },
      stop: async () => { throw new Error("stop should not be called") },
      remove: async () => { throw new Error("remove should not be called") },
    }
    await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
    expect(editOf(i)).toBe("not found")
  }
})
test("stop and remove park-clear runner state then tear down the subscription", async () => {
  for (const sub of ["stop", "remove"] as const) {
    const i = interaction({ sub, strings: { name: "demo", confirm: "demo" } })
    const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
    const order: string[] = []
    const deps: any = {
      projects: { stop: async () => { order.push("stop") }, remove: async () => { order.push("remove") } },
      runner: { resetChannel: async (channelId: string, opts: any) => { order.push(`reset:${channelId}:${opts?.notify}`) } },
      db, authorized: () => true, isOwner: () => true,
      stopSubscription: (channelId: string) => { order.push(`unsub:${channelId}`) },
    }
    await handleCommand(i, deps)
    expect(order).toEqual(["reset:c:true", "unsub:c", sub])
  }
})
test("abort in a project channel with no active thread says nothing to abort", async () => {
  const i = interaction({ commandName: "abort", channelId: "c" })
  const aborted: string[] = []
  await handleCommand(i, { projects: {} as any, runner: { abort: async (id: string) => { aborted.push(id) }, activeThreadsFor: () => [] } as any, db: fresh(), authorized: () => true })
  expect(aborted).toEqual([])
  expect(editOf(i)).toBe("nothing to abort")
})
test("abort in a project channel aborts its active threads", async () => {
  const i = interaction({ commandName: "abort", channelId: "c" })
  const aborted: string[] = []
  await handleCommand(i, { projects: {} as any, runner: { abort: async (id: string) => { aborted.push(id) }, activeThreadsFor: () => ["t1"] } as any, db: fresh(), authorized: () => true })
  expect(aborted).toEqual(["t1"])
  expect(editOf(i)).toBe("aborted")
})
test("abort inside a thread uses the runner's live signal", async () => {
  const i = interaction({ commandName: "abort", channelId: "t1", channel: { isThread: () => true } })
  const aborted: string[] = []
  await handleCommand(i, { projects: {} as any, runner: { abort: async (id: string) => { aborted.push(id) }, isActive: () => true, activeThreadsFor: () => [] } as any, db: fresh(), authorized: () => true })
  expect(aborted).toEqual(["t1"])
  expect(editOf(i)).toBe("aborted")
})
test("abort inside an idle thread says nothing to abort", async () => {
  const i = interaction({ commandName: "abort", channelId: "t1", channel: { isThread: () => true } })
  const aborted: string[] = []
  await handleCommand(i, { projects: {} as any, runner: { abort: async (id: string) => { aborted.push(id) }, isActive: () => false, activeThreadsFor: () => [] } as any, db: fresh(), authorized: () => true })
  expect(aborted).toEqual([])
  expect(editOf(i)).toBe("nothing to abort")
})

function threadRow(threadId = "t1", channelId = "c", over: any = {}) {
  return { threadId, channelId, sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1, ...over }
}

test("project create makes a sanitized directory then adds the project", async () => {
  const i = interaction({ sub: "create", strings: { name: "My App" } })
  const order: string[] = []
  const projects: any = {
    createProjectDirectory: async (name: string) => { order.push("mkdir:" + name); return "C:\\projects\\my-app" },
    addProject: async (input: any) => { order.push("add:" + input.directory); return { ...proj, name: "My App" } },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(order).toEqual(["mkdir:My App", "add:C:\\projects\\my-app"])
  expect(editOf(i)).toBe("created My App")
})

test("new creates a thread in the project channel and prompts", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = interaction({ commandName: "new", channelId: "c", strings: { prompt: "hello" }, user: { id: "u1" } })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    createThread: async (input: any) => { captured = input; return { threadId: "t1", sessionId: "s1" } } })
  expect(captured).toEqual({ channelId: "c", title: "hello", prompt: "hello", authorId: "u1" })
  expect(editOf(i)).toBe("created <#t1>")
})

test("new outside a project channel is rejected", async () => {
  const i = interaction({ commandName: "new", channelId: "other" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, createThread: async () => { throw new Error("should not run") } })
  expect(editOf(i)).toBe("this channel is not a project")
})

test("resume lists sessions and shows an ephemeral select", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = interaction({ commandName: "resume", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    listSessions: async () => [{ id: "s1", title: "First" }, { id: "s2", title: "Second" }] })
  const edit = editOf(i)
  expect(edit.content).toMatch(/Choose a session/)
  const menu = edit.components[0].components[0]
  expect(menu.custom_id).toBe("celly:resume:c")
  expect(menu.options).toEqual([{ label: "First", value: "s1" }, { label: "Second", value: "s2" }])
})

test("model and agent show selects for the current thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  const modelInteraction = interaction({ commandName: "model", channelId: "t1" })
  await handleCommand(modelInteraction, { projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude" }] })
  const modelMenu = editOf(modelInteraction).components[0].components[0]
  expect(modelMenu.custom_id).toBe("celly:model:t1")
  expect(modelMenu.options).toEqual([{ label: "Claude", value: "anthropic/claude" }])

  const agentInteraction = interaction({ commandName: "agent", channelId: "t1" })
  await handleCommand(agentInteraction, { projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listAgents: async () => [{ id: "build", name: "build" }] })
  const agentMenu = editOf(agentInteraction).components[0].components[0]
  expect(agentMenu.custom_id).toBe("celly:agent:t1")
  expect(agentMenu.options).toEqual([{ label: "build", value: "build" }])
})

test("model and agent ensureReady the sandbox before listing", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  for (const commandName of ["model", "agent"] as const) {
    const i = interaction({ commandName, channelId: "t1" })
    const order: string[] = []
    const list = async () => { order.push("list"); return [] }
    await handleCommand(i, {
      projects: { ensureReady: async (id: string) => { order.push("ready:" + id) } } as any,
      runner: {} as any, db, authorized: () => true,
      listModels: list, listAgents: list,
    })
    expect(order).toEqual(["ready:c", "list"])
  }
})

test("model outside a thread is rejected", async () => {
  const i = interaction({ commandName: "model", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("use /model inside a thread")
})

test("project start resubscribes before waking the sandbox", async () => {
  const i = interaction({ sub: "start", strings: { name: "demo" } })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const order: string[] = []
  await handleCommand(i, { projects: { start: async () => { order.push("ready") } } as any,
    runner: {} as any, db, authorized: () => true, isOwner: () => true, startSubscription: (channelId: string) => { order.push(`sub:${channelId}`) } })
  expect(order).toEqual(["sub:c", "ready"])
})

test("selecting a session resumes it in a new thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = select({ customId: "celly:resume:c", values: ["s1"] })
  let captured: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    createThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s1" } } })
  expect(i.calls[0]).toEqual({ kind: "deferUpdate" })
  expect(captured).toMatchObject({ channelId: "c", sessionId: "s1" })
  expect(i.calls[1].c).toMatchObject({ content: "resumed in <#t9>", components: [] })
})

test("selecting a model updates the thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  const i = select({ customId: "celly:model:t1", values: ["openai/gpt"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setThreadModel: (id: string, m: string | null) => { set = [id, m] } })
  expect(set).toEqual(["t1", "openai/gpt"])
  expect(i.calls[1].c).toMatchObject({ content: "model set to openai/gpt", components: [] })
})

test("selecting an agent updates the thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = select({ customId: "celly:agent:t1", values: ["build"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setThreadAgent: (id: string, a: string | null) => { set = [id, a] } })
  expect(set).toEqual(["t1", "build"])
  expect(i.calls[1].c).toMatchObject({ content: "agent set to build", components: [] })
})

test("unauthorized selects are rejected before deferUpdate", async () => {
  const i = select({ customId: "celly:model:t1", values: ["x"] })
  await handleSelect(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "You are not authorized.", flags: 64, allowedMentions: { parse: [] } } })
})

test("requiresOwner scopes project mutations", () => {
  for (const sub of ["add", "create", "start", "stop", "remove"]) expect(requiresOwner("project", sub)).toBe(true)
  for (const sub of ["list", "status"]) expect(requiresOwner("project", sub)).toBe(false)
  expect(requiresOwner("new", null)).toBe(false)
  expect(requiresOwner("model", "resume")).toBe(false)
})

test("authorized non-owners are denied owner-only project subcommands before defer", async () => {
  for (const sub of ["add", "create", "start", "stop", "remove"]) {
    const i = interaction({ sub, strings: { name: "demo", path: "C:\\p", confirm: "demo" } })
    await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
    expect(i.calls).toHaveLength(1)
    expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64, allowedMentions: { parse: [] } } })
  }
})

test("authorized non-owners can still use non-owner subcommands", async () => {
  const i = interaction({ sub: "status", strings: { name: "demo" } })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => false })
  expect(editOf(i)).toMatch(/ready/)
})

test("isOwner accepts the guild owner or a configured owner role", () => {
  expect(isOwner({ id: "o", roles: [] }, "o", {})).toBe(true)
  expect(isOwner({ id: "u", roles: ["own"] }, "o", { ownerRoleId: "own" })).toBe(true)
  expect(isOwner({ id: "u", roles: [] }, "o", { ownerRoleId: "own" })).toBe(false)
  expect(isOwner({ id: "u", roles: [] }, "o", {})).toBe(false)
})
