// test/commands.test.ts
import { readFileSync } from "node:fs"
import { expect, test, vi } from "vitest"
import { ApplicationCommandOptionType, ComponentType } from "discord.js"
import { ANSWER_MODAL_INPUT, SELECT_OPTION_MAX, SELECT_OPTIONS_MAX, commandData, deployCommandsToGuilds, handleApprovalButton, handleButton, handleCommand, handleModalSubmit, handleRejectQuestionButton, handleSelect, parseCustomIdFull, requiresOwner, sanitizeSelectOptions } from "../src/commands.ts"
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
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => strings[n],
      getInteger: (n: string) => (over.integers ?? {})[n],
      getBoolean: (n: string) => (over.booleans ?? {})[n],
      getNumber: (n: string) => (over.numbers ?? {})[n],
    },
    deferReply: async (o: any) => {
      if (over.deferError) throw new Error(over.deferError)
      i.deferred = true
      calls.push({ kind: "defer", o })
    },
    editReply: async (c: any) => { i.replied = true; calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { i.replied = true; calls.push({ kind: "reply", c }) },
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

test("declares the providers and cost command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "attach", "btw", "budget", "compact", "context-usage", "cost", "diff", "fork", "last-sessions", "mode", "model", "new", "project", "queue", "redo", "resume", "session-id", "share", "task", "thinking", "undo", "unshare", "worktree"])
})
test("project has the expected subcommands", () => {
  const project = commandData().find((c) => c.name === "project")!
  const subs = project.options.map((o: any) => o.name).sort()
  expect(subs).toEqual(["add", "create", "list", "remove", "restart", "start", "status", "stop"])
})
test("command data and select rows use named Discord type constants", () => {
  const source = readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8")
  expect(source).not.toMatch(/type:\s*[13]\b/)

  const project = commandData().find((c) => c.name === "project")!
  const create = project.options.find((o: any) => o.name === "create")!
  expect(create.type).toBe(ApplicationCommandOptionType.Subcommand)
  expect(create.options[0].type).toBe(ApplicationCommandOptionType.String)

  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "resume", channelId: "c" })
  return handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    listSessions: async () => [{ id: "s1", title: "First" }] }).then(() => {
    expect(editOf(i).components[0].type).toBe(ComponentType.ActionRow)
    expect(editOf(i).components[0].components[0].type).toBe(ComponentType.StringSelect)
  })
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
  return { threadId, channelId, sessionId: "s1", title: null, model: null, agent: null, variant: null,
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

test("selecting for an unknown action still answers unknown selection", async () => {
  const i = select({ customId: "celly:nope:c", values: ["x"] })
  await handleSelect(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(i.calls[1].c).toMatchObject({ content: "unknown selection", components: [] })
})

test("requiresOwner covers the owner-only commands", () => {
  expect(requiresOwner("budget", "show")).toBe(true)
  expect(requiresOwner("budget", "set")).toBe(true)
  expect(requiresOwner("cost", null)).toBe(false)
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

test("model shows a provider select then a model select; agent shows a select", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  const modelInteraction = interaction({ commandName: "model", channelId: "t1" })
  await handleCommand(modelInteraction, { projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude" }, { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" }] })
  const providerMenu = editOf(modelInteraction).components[0].components[0]
  expect(providerMenu.custom_id).toBe("celly:model-provider:t1")
  expect(providerMenu.options).toEqual([{ label: "anthropic (1)", value: "anthropic" }, { label: "deepseek (1)", value: "deepseek" }])

  const providerSelect = select({ customId: "celly:model-provider:t1", values: ["deepseek"] })
  await handleSelect(providerSelect, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude" }, { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" }] })
  const modelMenu = editOf(providerSelect).components[0].components[0]
  expect(modelMenu.custom_id).toBe("celly:model:t1")
  expect(modelMenu.options).toEqual([{ label: "DeepSeek Chat", value: "deepseek/deepseek-chat" }])

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

test("project start resubscribes before waking the sandbox", async () => {
  const i = interaction({ sub: "start", strings: { name: "demo" } })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const order: string[] = []
  await handleCommand(i, { projects: { start: async () => { order.push("ready") } } as any,
    runner: {} as any, db, authorized: () => true, isOwner: () => true, startSubscription: (channelId: string) => { order.push(`sub:${channelId}`) } })
  expect(order).toEqual(["sub:c", "ready"])
})

test("project restart on an unknown project replies not found", async () => {
  const i = interaction({ sub: "restart", strings: { name: "ghost" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(editOf(i)).toBe("not found")
})

test("project restart resubscribes around the server restart", async () => {
  const i = interaction({ sub: "restart", strings: { name: "demo" } })
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const order: string[] = []
  await handleCommand(i, {
    projects: { restartServer: async (channelId: string) => { order.push(`restart:${channelId}`) } } as any,
    runner: {} as any, db, authorized: () => true, isOwner: () => true,
    stopSubscription: (channelId: string) => { order.push(`stop:${channelId}`) },
    startSubscription: (channelId: string) => { order.push(`start:${channelId}`) },
  })
  expect(order).toEqual(["stop:c", "restart:c", "start:c"])
  expect(editOf(i)).toBe("restarted")
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
  db.threads.upsert(threadRow("t1"))
  const i = select({ customId: "celly:agent:t1", values: ["build"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setThreadAgent: (id: string, a: string | null) => { set = [id, a] } })
  expect(set).toEqual(["t1", "build"])
  expect(i.calls[1].c).toMatchObject({ content: "agent set to build", components: [] })
})

test("/thinking lists the current model's variants as a select", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1", "c", { model: "anthropic/claude" }))
  const i = interaction({ commandName: "thinking", channelId: "t1" })
  const order: string[] = []
  await handleCommand(i, {
    projects: { ensureReady: async (id: string) => { order.push("ready:" + id) } } as any,
    runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude", variants: ["high", "max"] }],
  })
  expect(order).toEqual(["ready:c"])
  const edit = editOf(i)
  expect(edit.content).toBe("Choose a thinking depth for this thread:")
  const menu = edit.components[0].components[0]
  expect(menu.custom_id).toBe("celly:thinking:t1")
  expect(menu.options).toEqual([{ label: "default (no override)", value: "default" }, { label: "high", value: "high" }, { label: "max", value: "max" }])
})

test("/thinking without a model asks for one first", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "thinking", channelId: "t1" })
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude", variants: ["high"] }],
  })
  expect(editOf(i)).toBe("set a model with /model first")
})

test("/thinking reports a model without variants", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1", "c", { model: "deepseek/deepseek-chat" }))
  const i = interaction({ commandName: "thinking", channelId: "t1" })
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "deepseek/deepseek-chat", name: "DeepSeek Chat", variants: [] }],
  })
  expect(editOf(i)).toBe("deepseek/deepseek-chat has no thinking depths")
})

test("/thinking with a direct value sets the thread override", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1", "c", { model: "anthropic/claude" }))
  const i = interaction({ commandName: "thinking", channelId: "t1", strings: { depth: "high" } })
  let set: any
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude", variants: ["high", "max"] }],
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] },
  })
  expect(set).toEqual(["t1", "high"])
  expect(editOf(i)).toBe("thinking depth set to high")
})

test("/thinking rejects a depth the model does not support", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1", "c", { model: "anthropic/claude" }))
  const i = interaction({ commandName: "thinking", channelId: "t1", strings: { depth: "loww" } })
  let set: any
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude", variants: ["high", "max"] }],
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] },
  })
  expect(set).toBeUndefined()
  expect(editOf(i)).toBe("unknown thinking depth 'loww' for anthropic/claude; choose one of: default, high, max")
})

test("/thinking normalizes case and whitespace", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1", "c", { model: "anthropic/claude" }))
  const i = interaction({ commandName: "thinking", channelId: "t1", strings: { depth: "  MAX " } })
  let set: any
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude", variants: ["high", "max"] }],
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] },
  })
  expect(set).toEqual(["t1", "max"])
  expect(editOf(i)).toBe("thinking depth set to max")
})

test("/thinking with a direct value and no model asks for a model", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "thinking", channelId: "t1", strings: { depth: "high" } })
  let set: any
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] },
  })
  expect(set).toBeUndefined()
  expect(editOf(i)).toBe("set a model with /model first")
})

test("/thinking rejects a depth when the model has no variants", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1", "c", { model: "deepseek/deepseek-chat" }))
  const i = interaction({ commandName: "thinking", channelId: "t1", strings: { depth: "low" } })
  let set: any
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "deepseek/deepseek-chat", name: "DeepSeek Chat", variants: [] }],
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] },
  })
  expect(set).toBeUndefined()
  expect(editOf(i)).toBe("deepseek/deepseek-chat has no thinking depths")
})

test("/thinking default clears the thread override", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1", "c", { variant: "high" }))
  const i = interaction({ commandName: "thinking", channelId: "t1", strings: { depth: "default" } })
  let set: any
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] },
  })
  expect(set).toEqual(["t1", null])
  expect(editOf(i)).toBe("thinking depth reset to default")
})

test("/thinking in a project channel sets the channel default", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.settings.set("default_model:c", "anthropic/claude")
  const i = interaction({ commandName: "thinking", channelId: "c", strings: { depth: "max" } })
  let set: any
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude", variants: ["high", "max"] }],
    setChannelVariant: (id: string, v: string | null) => { set = [id, v] },
  })
  expect(set).toEqual(["c", "max"])
  expect(editOf(i)).toBe("channel thinking depth set to max")
})

test("/thinking in a project channel offers a channel-scoped select using the channel model", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.settings.set("default_model:c", "anthropic/claude")
  const i = interaction({ commandName: "thinking", channelId: "c" })
  await handleCommand(i, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => [{ id: "anthropic/claude", name: "Claude", variants: ["high", "max"] }],
  })
  const edit = editOf(i)
  expect(edit.content).toBe("Choose a thinking depth for this channel:")
  expect(edit.components[0].components[0].custom_id).toBe("celly:thinking:c")
})

test("selecting a thinking depth updates the thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = select({ customId: "celly:thinking:t1", values: ["high"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] } })
  expect(set).toEqual(["t1", "high"])
  expect(i.calls[1].c).toMatchObject({ content: "thinking depth set to high", components: [] })
})

test("selecting the default thinking depth clears the thread override", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = select({ customId: "celly:thinking:t1", values: ["default"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setThreadVariant: (id: string, v: string | null) => { set = [id, v] } })
  expect(set).toEqual(["t1", null])
  expect(i.calls[1].c).toMatchObject({ content: "thinking depth set to default", components: [] })
})

test("selecting a channel thinking depth stores it as a channel default", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const i = select({ customId: "celly:thinking:c", values: ["max"] })
  let set: any
  await handleSelect(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    setChannelVariant: (id: string, v: string | null) => { set = [id, v] } })
  expect(set).toEqual(["c", "max"])
  expect(i.calls[1].c).toMatchObject({ content: "channel thinking depth set to max", components: [] })
})

test("unauthorized selects are rejected before deferUpdate", async () => {
  const i = select({ customId: "celly:model:t1", values: ["x"] })
  await handleSelect(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "You are not authorized.", flags: 64, allowedMentions: { parse: [] } } })
})

test("requiresOwner scopes project mutations", () => {
  for (const sub of ["add", "create", "start", "stop", "restart", "remove"]) expect(requiresOwner("project", sub)).toBe(true)
  for (const sub of ["list", "status"]) expect(requiresOwner("project", sub)).toBe(false)
  expect(requiresOwner("worktree", "merge")).toBe(true)
  for (const sub of ["status", "new", "remove"]) expect(requiresOwner("worktree", sub)).toBe(false)
  expect(requiresOwner("new", null)).toBe(false)
  expect(requiresOwner("model", "resume")).toBe(false)
})

test("authorized non-owners are denied owner-only project subcommands before defer", async () => {
  for (const sub of ["add", "create", "start", "stop", "restart", "remove"]) {
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

test("sanitizeSelectOptions enforces Discord's 100-char, unique, non-empty, 25-option limits", () => {
  expect(sanitizeSelectOptions([{ label: "A", value: "a" }, { label: "dup", value: "a" }, { label: "", value: "" }]))
    .toEqual([{ label: "A", value: "a" }])
  const long = "x".repeat(150)
  const [option] = sanitizeSelectOptions([{ label: long, value: long }])
  expect(option.value.length).toBeLessThanOrEqual(SELECT_OPTION_MAX)
  expect(option.label.length).toBeLessThanOrEqual(SELECT_OPTION_MAX)
  const many = Array.from({ length: 40 }, (_, i) => ({ label: `l${i}`, value: `v${i}` }))
  expect(sanitizeSelectOptions(many)).toHaveLength(SELECT_OPTIONS_MAX)
})

test("deployCommandsToGuilds deploys to every guild and logs the ids", async () => {
  const calls: string[] = []
  const info = vi.fn()
  const guilds = ["g1", "g2"].map((id) => ({ id, commands: { set: async (data: any[]) => { calls.push(`${id}:${data.length}`) } } }))
  const deployed = await deployCommandsToGuilds(guilds, commandData(), { log: { info, warn: () => {} } })
  expect(calls).toEqual([`g1:${commandData().length}`, `g2:${commandData().length}`])
  expect(deployed).toEqual(["g1", "g2"])
  expect(info).toHaveBeenCalledWith("commands deployed", { guilds: ["g1", "g2"] })
})
test("deployCommandsToGuilds isolates a single guild failure", async () => {
  const warn = vi.fn()
  const set = vi.fn(async () => {})
  const guilds = [
    { id: "g1", commands: { set: async () => { throw new Error("Missing Access") } } },
    { id: "g2", commands: { set } },
  ]
  const deployed = await deployCommandsToGuilds(guilds, [], { log: { info: () => {}, warn } })
  expect(deployed).toEqual(["g2"])
  expect(set).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith("command deploy failed for guild", { guildId: "g1", error: "Missing Access" })
})
test("deployCommandsToGuilds throws when every guild fails", async () => {
  const guilds = [{ id: "g1", commands: { set: async () => { throw new Error("Missing Access") } } }]
  await expect(deployCommandsToGuilds(guilds, [], { log: { info: () => {}, warn: () => {} } })).rejects.toThrow(/every guild/)
})
test("deployCommandsToGuilds treats an invalid token as fatal immediately", async () => {
  const set = vi.fn(async () => {})
  const guilds = [
    { id: "g1", commands: { set: async () => { throw new Error("An invalid token was provided.") } } },
    { id: "g2", commands: { set } },
  ]
  await expect(deployCommandsToGuilds(guilds, [], { log: { info: () => {}, warn: () => {} } })).rejects.toThrow(/invalid token/)
  expect(set).not.toHaveBeenCalled()
})

test("project add forwards the invoking guild id to addProject", async () => {
  const i = interaction({ sub: "add", strings: { name: "demo", path: "C:\\p" }, guildId: "g2" })
  const seen: any[] = []
  await handleCommand(i, {
    projects: { addProject: async (input: any) => { seen.push(input); return { ...proj, guildId: input.guildId } } } as any,
    runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true,
  })
  expect(seen).toEqual([{ guildId: "g2", name: "demo", directory: "C:\\p" }])
})

test("model selection survives malformed and oversized model lists without throwing", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert(threadRow("t1"))
  const oversized = "deepseek/" + "m".repeat(150)
  const models: any[] = [
    { id: "anthropic/claude", name: "Claude" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
    { id: oversized, name: "DeepSeek Oversized" },
    { id: "", name: "" },
    { id: undefined, name: "broken" },
  ]
  const providerInteraction = interaction({ commandName: "model", channelId: "t1" })
  await expect(handleCommand(providerInteraction, {
    projects: { ensureReady: async () => {} } as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => models,
  })).resolves.toBeUndefined()
  const providerMenu = editOf(providerInteraction).components[0].components[0]
  expect(providerMenu.custom_id).toBe("celly:model-provider:t1")
  expect(providerMenu.options.some((o: any) => o.value === "deepseek")).toBe(true)
  for (const option of providerMenu.options) {
    expect(option.value.length).toBeGreaterThan(0)
    expect(option.value.length).toBeLessThanOrEqual(SELECT_OPTION_MAX)
    expect(option.label.length).toBeLessThanOrEqual(SELECT_OPTION_MAX)
  }

  const modelInteraction = select({ customId: "celly:model-provider:t1", values: ["deepseek"] })
  await expect(handleSelect(modelInteraction, {
    projects: {} as any, runner: {} as any, db, authorized: () => true,
    listModels: async () => models,
  })).resolves.toBeUndefined()
  const modelMenu = editOf(modelInteraction).components[0].components[0]
  expect(modelMenu.custom_id).toBe("celly:model:t1")
  expect(modelMenu.options.some((o: any) => o.value === "deepseek/deepseek-chat")).toBe(true)
  for (const option of modelMenu.options) {
    expect(option.value.length).toBeGreaterThan(0)
    expect(option.value.length).toBeLessThanOrEqual(SELECT_OPTION_MAX)
  }
})

test("session-id replies with the bare id and the spoiler command from a thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "session-id", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(i.calls[0]).toEqual({ kind: "defer", o: { flags: 64 } })
  expect(editOf(i)).toBe("`s1`\n||sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s s1'||")
})

test("session-id outside a thread is rejected", async () => {
  const i = interaction({ commandName: "session-id", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("use /session-id inside a thread")
})

test("session-id reports a missing project row", async () => {
  // threads.channel_id is FK-bound to projects(channel_id), so this dangling
  // thread cannot exist in a real db; stub it to exercise the guard.
  const db = { threads: { get: () => threadRow("t1") }, projects: { getByChannel: () => undefined } } as any
  const i = interaction({ commandName: "session-id", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toBe("project not found")
})

test("a failed defer reports error: <message> as an ephemeral reply", async () => {
  const i = interaction({ commandName: "session-id", channelId: "t1", deferError: "defer failed" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "error: defer failed", flags: 64, allowedMentions: { parse: [] } } })
})

test("attach replies with the code-block command from a thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "attach", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(i.calls[0]).toEqual({ kind: "defer", o: { flags: 64 } })
  expect(editOf(i)).toBe("```\nsbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s s1'\n```")
})

test("attach outside a thread is rejected", async () => {
  const i = interaction({ commandName: "attach", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("use /attach inside a thread")
})

test("attach reports a missing project row", async () => {
  // threads.channel_id is FK-bound to projects(channel_id), so this dangling
  // thread cannot exist in a real db; stub it to exercise the guard.
  const db = { threads: { get: () => threadRow("t1") }, projects: { getByChannel: () => undefined } } as any
  const i = interaction({ commandName: "attach", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toBe("project not found")
})

function taskInteraction(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    commandName: "task",
    guildId: "g",
    channelId: over.channelId ?? "c",
    user: over.user ?? { id: "u1" },
    calls,
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => (over.strings ?? {})[n],
      getInteger: (n: string) => (over.integers ?? {})[n],
      getChannel: (n: string) => (over.channels ?? {})[n],
    },
    deferReply: async (o: any) => { calls.push({ kind: "defer", o }) },
    editReply: async (c: any) => { calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}

test("parseCustomIdFull reads action, id, and extra", () => {
  expect(parseCustomIdFull("celly:resume:c1")).toEqual({ action: "resume", id: "c1", extra: undefined })
  expect(parseCustomIdFull("celly:approval:r1:once")).toEqual({ action: "approval", id: "r1", extra: "once" })
  expect(parseCustomIdFull("celly:answer:r1:2.3")).toEqual({ action: "answer", id: "r1", extra: "2.3" })
  expect(parseCustomIdFull("nope")).toEqual({ action: "" })
})

function fakeApprovals(over: any = {}) {
  const calls: any[] = []
  const manager = {
    calls,
    resolvePermission: (id: string, decision: string, actor: string) => { calls.push(["resolvePermission", id, decision, actor]); return over.permissionKnown ?? true },
    answerOption: (id: string, q: number, o: number, actor: string) => { calls.push(["answerOption", id, q, o, actor]); return over.optionKnown ?? true },
    answerQuestion: (id: string, q: number, answers: string[], actor: string) => { calls.push(["answerQuestion", id, q, answers, actor]); return over.questionKnown ?? true },
    rejectQuestion: (id: string, actor: string) => { calls.push(["rejectQuestion", id, actor]); return over.questionKnown ?? true },
    hasPending: () => over.pending ?? true,
    requestPermission: async () => "reject" as const,
    askQuestion: async () => null,
    cancel: () => {},
  }
  return { manager: manager as any, calls }
}

function button(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    customId: over.customId,
    channelId: over.channelId ?? "c",
    user: over.user ?? { id: "u1" },
    inGuild: () => true, member: {}, memberPermissions: {},
    calls,
    deferUpdate: async () => { calls.push({ kind: "deferUpdate" }) },
    showModal: async (m: any) => { calls.push({ kind: "showModal", m: m?.toJSON ? m.toJSON() : m }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
    editReply: async (c: any) => { calls.push({ kind: "edit", c }) },
  }
  return i
}

function modal(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    customId: over.customId,
    user: over.user ?? { id: "u1" },
    inGuild: () => true, member: {}, memberPermissions: {},
    fields: { getTextInputValue: (_id: string) => over.value },
    calls,
    deferUpdate: async () => { calls.push({ kind: "deferUpdate" }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}

test("task declares add, list, and remove subcommands", () => {
  const task = commandData().find((c) => c.name === "task")!
  expect(task.options.map((o: any) => o.name).sort()).toEqual(["add", "list", "remove"])
  const add = task.options.find((o: any) => o.name === "add")!
  expect(add.options.map((o: any) => o.name)).toEqual(["channel", "prompt", "every_minutes"])
})

test("task add schedules a prompt in a project channel and audits it", async () => {
  const db = fresh()
  db.projects.insertProvisioning({ ...proj, channelId: "c", name: "demo" })
  const audits: any[] = []
  const i = taskInteraction({ sub: "add", channels: { channel: { id: "c" } }, strings: { prompt: "standup" }, integers: { every_minutes: 60 } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, audit: (e: any) => audits.push(e) })
  const tasks = db.tasks.list()
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ channelId: "c", prompt: "standup", everyMinutes: 60, enabled: true })
  expect(editOf(i)).toContain("scheduled task")
  expect(editOf(i)).toContain("every 60m")
  expect(audits).toEqual([{ kind: "task", channelId: "c", threadId: "c", actorId: "u1", detail: `add:${tasks[0]!.id} every 60m`, decision: "add" }])
})

test("task add rejects a channel that is not a project", async () => {
  const db = fresh()
  const i = taskInteraction({ sub: "add", channels: { channel: { id: "other" } }, strings: { prompt: "p" }, integers: { every_minutes: 5 } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true })
  expect(db.tasks.list()).toEqual([])
  expect(editOf(i)).toBe("channel is not a project")
})

test("task list renders tasks and remove deletes by id with audit entries", async () => {
  const db = fresh()
  const id = db.tasks.add({ channelId: "c", prompt: "standup", everyMinutes: 60, nextRunAt: 1000, createdAt: 1 })
  const list = taskInteraction({ sub: "list" })
  await handleCommand(list, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(list)).toContain(`#${id}`)
  const audits: any[] = []
  const remove = taskInteraction({ sub: "remove", integers: { id } })
  await handleCommand(remove, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, audit: (e: any) => audits.push(e) })
  expect(editOf(remove)).toBe(`removed task ${id}`)
  expect(db.tasks.list()).toEqual([])
  const missing = taskInteraction({ sub: "remove", integers: { id } })
  await handleCommand(missing, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, audit: (e: any) => audits.push(e) })
  expect(editOf(missing)).toBe(`task ${id} not found`)
  expect(audits).toEqual([
    { kind: "task", channelId: "c", threadId: "c", actorId: "u1", detail: `remove:${id}`, decision: "remove" },
    { kind: "task", channelId: "c", threadId: "c", actorId: "u1", detail: `remove:${id}`, decision: "missing" },
  ])
})

test("requiresOwner covers task add and remove only", () => {
  expect(requiresOwner("task", "add")).toBe(true)
  expect(requiresOwner("task", "remove")).toBe(true)
  expect(requiresOwner("task", "list")).toBe(false)
})

test("authorized non-owners are denied task add and remove before defer", async () => {
  for (const sub of ["add", "remove"]) {
    const i = taskInteraction({ sub, channels: { channel: { id: "c" } }, strings: { prompt: "p" }, integers: { every_minutes: 1, id: 1 } })
    await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
    expect(i.calls).toHaveLength(1)
    expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64, allowedMentions: { parse: [] } } })
  }
})

test("approval buttons resolve the decision and acknowledge the interaction", async () => {
  const { manager, calls } = fakeApprovals()
  const i = button({ customId: "celly:approval:r1:once" })
  await handleApprovalButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["resolvePermission", "r1", "once", "u1"]])
  expect(i.calls).toEqual([{ kind: "deferUpdate" }])
})

test("stale approval buttons answer that the request is no longer active", async () => {
  const { manager } = fakeApprovals({ permissionKnown: false })
  const i = button({ customId: "celly:approval:r1:reject" })
  await handleApprovalButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "this request is no longer active", flags: 64 } })
})

test("option buttons map through the manager and custom buttons open a modal", async () => {
  const { manager, calls } = fakeApprovals()
  const option = button({ customId: "celly:answer:r1:0.2" })
  await handleButton(option, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["answerOption", "r1", 0, 2, "u1"]])
  expect(option.calls).toEqual([{ kind: "deferUpdate" }])

  const custom = button({ customId: "celly:answer:r1:1" })
  await handleButton(custom, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  const shown = custom.calls[0]
  expect(shown.kind).toBe("showModal")
  expect(shown.m.custom_id).toBe("celly:answer:r1:1")
  expect(shown.m.components[0].components[0].custom_id).toBe(ANSWER_MODAL_INPUT)
})

test("answer selects submit the selected values to the manager", async () => {
  const { manager, calls } = fakeApprovals()
  const i = select({ customId: "celly:answer:r1:1", values: ["b", "c"] })
  await handleSelect(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(i.calls[0]).toEqual({ kind: "deferUpdate" })
  expect(calls).toEqual([["answerQuestion", "r1", 1, ["b", "c"], "u1"]])
})

test("modal submits route the text input to the manager", async () => {
  const { manager, calls } = fakeApprovals()
  const i = modal({ customId: "celly:answer:r1:1", value: "  custom text  " })
  await handleModalSubmit(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["answerQuestion", "r1", 1, ["custom text"], "u1"]])
  expect(i.calls).toEqual([{ kind: "deferUpdate" }])
})

test("modal submits reject empty answers and stale requests", async () => {
  const { manager } = fakeApprovals({ questionKnown: false })
  const empty = modal({ customId: "celly:answer:r1:1", value: "   " })
  await handleModalSubmit(empty, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(empty.calls[0]).toMatchObject({ kind: "reply", c: { content: "answer cannot be empty", flags: 64 } })

  const staleButton = modal({ customId: "celly:answer:r1:1", value: "x" })
  await handleModalSubmit(staleButton, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(staleButton.calls[0]).toMatchObject({ kind: "reply", c: { content: "this request is no longer active", flags: 64 } })
})

test("question rejection resolves through the manager", async () => {
  const { manager, calls } = fakeApprovals()
  const i = button({ customId: "celly:reject-question:r1" })
  await handleRejectQuestionButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["rejectQuestion", "r1", "u1"]])
  expect(i.calls).toEqual([{ kind: "deferUpdate" }])
})

test("unauthorized button interactions are rejected before any manager call", async () => {
  const { manager, calls } = fakeApprovals()
  const i = button({ customId: "celly:approval:r1:once" })
  await handleButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => false, approvals: manager })
  expect(calls).toEqual([])
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "You are not authorized.", flags: 64 } })
})

test("mode is owner-only and declares the three approval modes", () => {
  const mode = commandData().find((c) => c.name === "mode")!
  expect(mode.options[0].choices.map((c: any) => c.value)).toEqual(["auto", "buttons", "plan"])
  expect(requiresOwner("mode", null)).toBe(true)
})

test("mode writes the channel setting and audits the change", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = interaction({ commandName: "mode", channelId: "c", strings: { mode: "plan" } })
  const audits: any[] = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, audit: (e: any) => audits.push(e) })
  expect(db.settings.get("approval_mode:c")).toBe("plan")
  expect(editOf(i)).toBe("approval mode set to plan")
  expect(audits).toEqual([{ kind: "mode", channelId: "c", threadId: "c", actorId: "u1", detail: "approval_mode:c", decision: "plan" }])
})

test("mode inside a thread writes the owning project setting", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "mode", channelId: "t1", strings: { mode: "auto" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true })
  expect(db.settings.get("approval_mode:c")).toBe("auto")
})

test("non-owner mode is rejected before defer", async () => {
  const i = interaction({ commandName: "mode", channelId: "c", strings: { mode: "auto" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64 } })
})

test("worktree outside a thread is rejected", async () => {
  const i = interaction({ commandName: "worktree", sub: "status", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("use /worktree inside a thread")
})

test("worktree status forwards the thread id", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "status", channelId: "t1" })
  const seen: string[] = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    worktree: { status: async (threadId: string) => { seen.push(threadId); return "worktree: /w" },
      create: async () => "", merge: async () => "", remove: async () => "" } })
  expect(seen).toEqual(["t1"])
  expect(editOf(i)).toBe("worktree: /w")
})

test("worktree new forwards the thread and optional name", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "new", channelId: "t1", strings: { name: "feature" } })
  const seen: Array<[string, string | undefined]> = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    worktree: { status: async () => "", create: async (threadId: string, name?: string) => { seen.push([threadId, name]); return "created" },
      merge: async () => "", remove: async () => "" } })
  expect(seen).toEqual([["t1", "feature"]])
  expect(editOf(i)).toBe("created")
})

test("worktree merge is owner-only", async () => {
  const i = interaction({ commandName: "worktree", sub: "merge", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64 } })
})

test("queue lists queued prompts with remove and clear buttons", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
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

  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const empty = interaction({ commandName: "queue", channelId: "t1" })
  await handleCommand(empty, { projects: {} as any, runner: { queuedFor: () => [] } as any, db, authorized: () => true })
  expect(editOf(empty)).toBe("queue is empty")
})

test("queue remove button removes the index and refreshes the list", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
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
  expect(editOf(i).content).toBe("queue changed; run /queue again")
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

test("undo reverts the thread's last user message", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
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

  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const empty = interaction({ commandName: "undo", channelId: "t1" })
  await handleCommand(empty, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { undo: async () => "nothing" } as any })
  expect(editOf(empty)).toBe("nothing to undo")
})

test("redo unreverts the thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const calls: string[] = []
  const i = interaction({ commandName: "redo", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { redo: async (threadId: string) => { calls.push(threadId); return "redone" } } as any })
  expect(calls).toEqual(["t1"])
  expect(editOf(i)).toBe("redone")
})

test("diff formats the file list", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
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
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
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

test("share posts the share url and unshare confirms", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
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

test("compact reports compacted, and the no-model error is exact", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const ok = interaction({ commandName: "compact", channelId: "t1" })
  await handleCommand(ok, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { compact: async () => "compacted" } as any })
  expect(editOf(ok)).toBe("compacted")

  const bad = interaction({ commandName: "compact", channelId: "t1" })
  await handleCommand(bad, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { compact: async () => { throw new Error("set a model with /model first") } } as any })
  expect(editOf(bad)).toBe("error: set a model with /model first")
})

test("context-usage renders the usage bar and the no-usage message", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const ok = interaction({ commandName: "context-usage", channelId: "t1" })
  await handleCommand(ok, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { contextUsage: async () => ({ used: 50000, limit: 100000 }) } as any })
  expect(editOf(ok)).toBe("50k/100k (50%)\n[██████████░░░░░░░░░░]")

  const empty = interaction({ commandName: "context-usage", channelId: "t1" })
  await handleCommand(empty, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    sessions: { contextUsage: async () => "no-usage" } as any })
  expect(editOf(empty)).toBe("no usage recorded for this thread yet")
})

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

test("model, agent, and thinking in a non-project channel are rejected", async () => {
  for (const commandName of ["model", "agent", "thinking"] as const) {
    const i = interaction({ commandName, channelId: "c" })
    await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
    expect(editOf(i)).toBe("this channel is not a project")
  }
})

test("worktree merge forwards the thread id", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "merge", channelId: "t1" })
  const seen: string[] = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true,
    worktree: { status: async () => "", create: async () => "",
      merge: async (threadId: string) => { seen.push(threadId); return "merged celly/t1 into the project root" }, remove: async () => "" } })
  expect(seen).toEqual(["t1"])
  expect(editOf(i)).toBe("merged celly/t1 into the project root")
})

test("worktree remove forwards the force flag", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "remove", channelId: "t1", booleans: { force: true } })
  const seen: Array<[string, boolean]> = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    worktree: { status: async () => "", create: async () => "", merge: async () => "",
      remove: async (threadId: string, force: boolean) => { seen.push([threadId, force]); return "removed" } } })
  expect(seen).toEqual([["t1", true]])
  expect(editOf(i)).toBe("removed")
})

test("fork outside a thread is rejected", async () => {
  const i = interaction({ commandName: "fork", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true,
    forkThread: async () => { throw new Error("should not run") } })
  expect(editOf(i)).toBe("use /fork inside a thread")
})

test("fork forwards the source thread, title, and prompt", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "fork", channelId: "t1", strings: { prompt: "try this" } })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s9" } } })
  expect(captured).toEqual({ sourceThreadId: "t1", title: "try this", prompt: "try this", authorId: "u1" })
  expect(editOf(i)).toBe("forked into <#t9>")
})

test("fork without a prompt titles the new thread after the source", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "fork", channelId: "t1" })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s9" } } })
  expect(captured.title).toBe("fork of source")
  expect(captured.prompt).toBeUndefined()
})

test("btw prefixes the title and requires a prompt", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "btw", channelId: "t1", strings: { prompt: "be quick" } })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s9" } } })
  expect(captured.title).toBe("btw · be quick")
  expect(captured.prompt).toBe("be quick")
  expect(editOf(i)).toBe("forked into <#t9>")

  const missing = interaction({ commandName: "btw", channelId: "t1" })
  await handleCommand(missing, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async () => { throw new Error("should not run") } })
  expect(editOf(missing)).toBe("usage: /btw <prompt>")
})

test("fork surfaces the run notice when the forked prompt is queued", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "fork", channelId: "t1", strings: { prompt: "hi" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async () => ({ threadId: "t9", sessionId: "s9", notice: "queued (1)" }) })
  expect(editOf(i)).toBe("forked into <#t9> (queued (1))")
})

test("last-sessions lists recent threads, default 5, newest first", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  for (let i = 1; i <= 7; i++) db.threads.upsert(threadRow(`t${i}`, "c", { title: `Session ${i}`, lastActiveAt: i }))
  const i = interaction({ commandName: "last-sessions", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  const out = editOf(i)
  expect(out.split("\n")).toHaveLength(5)
  expect(out).toContain("<#t7> — Session 7")
  expect(out).not.toContain("<#t2>")
})

test("last-sessions honours a requested count and caps it at 10", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  for (let i = 1; i <= 12; i++) db.threads.upsert(threadRow(`t${i}`, "c", { title: `Session ${i}`, lastActiveAt: i }))
  const three = interaction({ commandName: "last-sessions", channelId: "c", integers: { count: 3 } })
  await handleCommand(three, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(three).split("\n")).toHaveLength(3)

  const forty = interaction({ commandName: "last-sessions", channelId: "c", integers: { count: 40 } })
  await handleCommand(forty, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(forty).split("\n")).toHaveLength(10)
})

test("last-sessions inside a thread uses the parent project channel", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1", "c", { title: "First" }))
  const i = interaction({ commandName: "last-sessions", channelId: "t1", channel: { isThread: () => true, parentId: "c" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toContain("<#t1> — First")
})

test("last-sessions outside a project is rejected", async () => {
  const i = interaction({ commandName: "last-sessions", channelId: "other" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("this channel is not a project")
})

test("last-sessions with no threads says so", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = interaction({ commandName: "last-sessions", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toBe("no sessions yet")
})

test("project create forwards clone and branch to the create saga", async () => {
  const i = interaction({ sub: "create", strings: { name: "demo", clone: "https://example.com/a.git", branch: "main" } })
  let captured: any
  const projects: any = {
    createProjectDirectory: async () => "C:\\projects\\demo",
    addProject: async (input: any) => { captured = input; return { ...proj, name: "demo" } },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(captured).toEqual({ guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    clone: { url: "https://example.com/a.git", branch: "main" } })
  expect(editOf(i)).toBe("created demo")
})

test("project create omits clone for a plain create", async () => {
  const i = interaction({ sub: "create", strings: { name: "demo" } })
  let captured: any
  const projects: any = {
    createProjectDirectory: async () => "C:\\projects\\demo",
    addProject: async (input: any) => { captured = input; return { ...proj, name: "demo" } },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(captured).toEqual({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
  expect(editOf(i)).toBe("created demo")
})

test("project create rejects branch without clone before creating a directory", async () => {
  const i = interaction({ sub: "create", strings: { name: "demo", branch: "main" } })
  const projects: any = {
    createProjectDirectory: async () => { throw new Error("should not run") },
    addProject: async () => { throw new Error("should not run") },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(editOf(i)).toBe("branch requires clone")
})

test("every declared command has a handler branch", async () => {
  for (const command of commandData()) {
    const subs = (command.options ?? [])
      .filter((o: any) => o.type === ApplicationCommandOptionType.Subcommand)
      .map((o: any) => o.name)
    for (const sub of subs.length ? subs : [undefined]) {
      const i = interaction({ commandName: command.name, channelId: "c", sub })
      await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
      expect(editOf(i), `${command.name} ${sub ?? ""}`).not.toBe("not implemented in this build")
    }
  }
})
