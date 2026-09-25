// test/commands.test.ts
import { expect, test } from "vitest"
import { commandData, handleCommand } from "../src/commands.ts"
import { openDb } from "../src/db.ts"

function fresh() { const db = openDb(":memory:"); db.migrate(); return db }

const proj = { channelId: "c", guildId: "g", name: "demo", directory: "C:\\p",
  sandboxPath: null, sandboxName: "cely-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 }

function interaction(over: any = {}) {
  const calls: any[] = []
  const strings = over.strings ?? {}
  const i: any = {
    commandName: over.commandName ?? "project",
    guildId: over.guildId ?? "g",
    channelId: over.channelId ?? "c",
    channel: over.channel,
    calls,
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => strings[n],
    },
    deferReply: async (o: any) => { calls.push({ kind: "defer", o }) },
    editReply: async (c: string) => { calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}
const editOf = (i: any) => i.calls.find((c: any) => c.kind === "edit")?.c

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
test("unauthorized interactions are rejected before defer", async () => {
  const i = interaction({ sub: "status", strings: { name: "demo" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toEqual({ kind: "reply", c: { content: "You are not authorized.", flags: 64 } })
})
test("add reply never contains the server password", async () => {
  const i = interaction({ sub: "add", strings: { name: "demo", path: "C:\\p" } })
  const added = { ...proj, serverPassword: "SUPERSECRET" }
  await handleCommand(i, { projects: { addProject: async () => added } as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toContain("demo")
  expect(editOf(i)).not.toContain("SUPERSECRET")
})
test("start/stop/remove on an unknown project reply not found", async () => {
  for (const sub of ["start", "stop", "remove"]) {
    const i = interaction({ sub, strings: { name: "ghost", confirm: "ghost" } })
    const projects: any = {
      ensureReady: async () => { throw new Error("ensureReady should not be called") },
      stop: async () => { throw new Error("stop should not be called") },
      remove: async () => { throw new Error("remove should not be called") },
    }
    await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true })
    expect(editOf(i)).toBe("not found")
  }
})
test("stop and remove tear down the event subscription first", async () => {
  for (const sub of ["stop", "remove"] as const) {
    const i = interaction({ sub, strings: { name: "demo", confirm: "demo" } })
    const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
    const order: string[] = []
    const deps: any = {
      projects: { stop: async () => { order.push("stop") }, remove: async () => { order.push("remove") } },
      runner: {} as any, db, authorized: () => true,
      stopSubscription: (channelId: string) => { order.push(`unsub:${channelId}`) },
    }
    await handleCommand(i, deps)
    expect(order).toEqual(["unsub:c", sub])
  }
})
test("abort in a project channel with no active thread says nothing to abort", async () => {
  const i = interaction({ commandName: "abort", channelId: "c" })
  const aborted: string[] = []
  await handleCommand(i, { projects: {} as any, runner: { abort: async (id: string) => { aborted.push(id) } } as any, db: fresh(), authorized: () => true })
  expect(aborted).toEqual([])
  expect(editOf(i)).toBe("nothing to abort")
})
test("abort in a project channel aborts its active threads", async () => {
  const i = interaction({ commandName: "abort", channelId: "c" })
  const db = fresh()
  db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "running", createdAt: 1, lastActiveAt: 1 })
  const aborted: string[] = []
  await handleCommand(i, { projects: {} as any, runner: { abort: async (id: string) => { aborted.push(id) } } as any, db, authorized: () => true })
  expect(aborted).toEqual(["t1"])
  expect(editOf(i)).toBe("aborted")
})
