import { createServer } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"
import { ProjectService } from "../src/projects.ts"

function makeCfg(portStart: number, portEnd: number): any {
  return { projectsRoot: "C:\\projects", sandboxTemplate: "opencode", sandboxCpus: 2, sandboxMemory: "4g",
    portRangeStart: portStart, portRangeEnd: portEnd, bootTimeoutMs: 100, healthTimeoutMs: 50, dataDir: "./data" }
}

const logger = () => ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this } }) as any

async function healthServer(healthy: boolean) {
  const server = createServer((_, res) => {
    if (healthy) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true }))
    else res.writeHead(503).end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

function makeChild() {
  const child: any = { killed: 0, stdoutData: 0, stderrData: 0, listeners: {} as Record<string, Function[]> }
  child.on = (ev: string, fn: Function) => { (child.listeners[ev] ??= []).push(fn) }
  child.kill = () => { child.killed++ }
  child.emitExit = () => { for (const fn of child.listeners.exit ?? []) fn() }
  child.stdout = { on: (ev: string) => { if (ev === "data") child.stdoutData++ } }
  child.stderr = { on: (ev: string) => { if (ev === "data") child.stderrData++ } }
  return child
}

function fakes() {
  const calls: string[][] = []
  const children: any[] = []
  const published = new Map<string, number>()
  const sbx: any = {
    list: async () => [],
    ports: async (name: string) => (published.has(name)
      ? [{ hostIp: "127.0.0.1", hostPort: published.get(name), sandboxPort: 4096, protocol: "tcp4" }]
      : []),
    create: async (o: any) => { calls.push(["create", o.name]); published.set(o.name, o.hostPort) },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    start: async (n: string) => { calls.push(["start", n]); return { code: 0, stdout: "", stderr: "" } },
    cp: async () => {}, stop: async (n: string) => { calls.push(["stop", n]) },
    remove: async (n: string) => { calls.push(["rm", n]) },
    execStream: () => { const c = makeChild(); children.push(c); return c },
  }
  return { calls, sbx, runner: { run: async () => ({ code: 0, stdout: "[]", stderr: "" }) }, children }
}

test("addProject rejects directories outside PROJECTS_ROOT", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\Windows" })).rejects.toThrow(/PROJECTS_ROOT/)
})

test("addProject rejects a prefix-sibling directory", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects-evil" })).rejects.toThrow(/PROJECTS_ROOT/)
})

test("createProjectDirectory sanitizes the name and creates it under PROJECTS_ROOT", async () => {
  const root = mkdtempSync(join(tmpdir(), "cely-root-"))
  try {
    const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
    const svc = new ProjectService({ sbx, runner: runner as any, db,
      config: { ...makeCfg(4600, 4600), projectsRoot: root }, log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    const dir = await svc.createProjectDirectory("My App/../evil")
    expect(dir.startsWith(root)).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect(dir).toContain("My App-..-evil")
    await expect(svc.createProjectDirectory("..")).rejects.toThrow(/invalid/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("addProject writes and verifies the cely bootstrap before starting the serve child", async () => {
  const db = openDb(":memory:"); db.migrate()
  const { sbx, runner, children } = fakes()
  const order: string[] = []
  let envContent = ""
  let configContent = ""
  const baseExec = sbx.exec
  sbx.exec = async (n: string, args: string[]) => { order.push("exec:" + args.join(" ")); return baseExec(n, args) }
  sbx.cp = async (from: string, to: string) => {
    const content = readFileSync(from, "utf8")
    if (to.endsWith("opencode.env")) envContent = content
    if (to.endsWith("opencode.json")) configContent = content
    order.push("cp:" + to)
  }
  sbx.execStream = () => { order.push("serve"); const c = makeChild(); children.push(c); return c }
  const server = await healthServer(true)
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(order.findIndex((o) => o === "serve")).toBeGreaterThan(order.findIndex((o) => o.includes("cely-opencode.env")))
    expect(envContent).toContain("OPENCODE_CONFIG=$HOME/.config/cely/opencode.json")
    const password = envContent.match(/OPENCODE_SERVER_PASSWORD=(\w+)/)?.[1] ?? ""
    expect(password).not.toBe("")
    expect(order.some((o) => o.includes(password))).toBe(false)
    const parsed = JSON.parse(configContent)
    expect(parsed.permission).toEqual({
      "*": "allow",
      bash: { "*": "allow", "git push*": "deny", "git clean -fdx*": "deny", "npm publish*": "deny", "pnpm publish*": "deny", "yarn publish*": "deny" },
      external_directory: "deny", question: "deny",
    })
  } finally { await server.close() }
})

test("addProject fails the saga when sandbox bootstrap fails", async () => {
  const db = openDb(":memory:"); db.migrate()
  const { sbx, runner, calls } = fakes()
  sbx.exec = async (_n: string, args: string[]) => {
    if (args.some((a) => a.includes("cely-opencode"))) throw new Error("bootstrap failed")
    return { code: 0, stdout: "", stderr: "" }
  }
  const deleted: string[] = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/bootstrap failed/)
  expect(db.projects.list()).toEqual([])
  expect(calls).toContainEqual(["rm", "cely-demo"])
  expect(deleted).toEqual(["chan-demo"])
})

test("addProject rolls back on create failure", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, children } = fakes()
  sbx.create = async () => { throw new Error("create boom") }
  const created: string[] = [], deleted: string[] = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async (n: string) => { created.push(n); return "chan1" },
    deleteChannel: async (c: string) => { deleted.push(c) } } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/create boom/)
  expect(db.projects.list()).toEqual([])
  expect(created).toEqual(["demo"])
  expect(deleted).toEqual(["chan1"])
  expect(calls).toContainEqual(["rm", "cely-demo"])
  expect(children).toHaveLength(0)
})

test("addProject rolls back and kills the drained child when health never passes", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, children } = fakes()
  const server = await healthServer(false)
  const deleted: string[] = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
    await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/health/)
    expect(children).toHaveLength(1)
    expect(children[0].killed).toBe(1)
    expect(children[0].stdoutData).toBe(1)
    expect(children[0].stderrData).toBe(1)
    expect(svc.childFor("chan-demo")).toBeUndefined()
    expect(db.projects.list()).toEqual([])
    expect(calls).toContainEqual(["rm", "cely-demo"])
    expect(deleted).toEqual(["chan-demo"])
  } finally { await server.close() }
})

test("a second addProject with the same slug gets a -2 sandbox", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const s1 = await healthServer(true); const s2 = await healthServer(true)
  try {
    const start = Math.min(s1.port, s2.port), end = Math.max(s1.port, s2.port)
    const listening = new Set([s1.port, s2.port])
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(start, end), log: logger(),
      isPortFree: async (p: number) => listening.has(p), createChannel: (n: string) => Promise.resolve("chan-" + n), deleteChannel: async () => {} } as any)
    const a = await svc.addProject({ guildId: "g", name: "Demo", directory: "C:\\projects\\demo" })
    const b = await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo2" })
    expect(a.sandboxName).toBe("cely-demo")
    expect(b.sandboxName).toBe("cely-demo-2")
    expect(a.hostPort).not.toBe(b.hostPort)
  } finally { await s1.close(); await s2.close() }
})

test("addProject with existingChannelId preserves the channel on rollback", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  sbx.create = async () => { throw new Error("create boom") }
  const created: string[] = [], deleted: string[] = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async (n: string) => { created.push(n); return "new" },
    deleteChannel: async (c: string) => { deleted.push(c) } } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo", existingChannelId: "chan-existing" }))
    .rejects.toThrow(/create boom/)
  expect(created).toEqual([])
  expect(deleted).toEqual([])
  expect(db.projects.list()).toEqual([])
  expect(calls).toContainEqual(["rm", "cely-demo"])
})

test("ensureReady is single-flighted, restarts a stale child, and throws if still unhealthy", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, children } = fakes()
  const server = await healthServer(false)
  try {
    db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
      sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await expect(Promise.all([svc.ensureReady("chan1"), svc.ensureReady("chan1")])).rejects.toThrow(/not healthy/)
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(1)
    expect(children).toHaveLength(1)
    await expect(svc.ensureReady("chan1")).rejects.toThrow(/not healthy/)
    expect(children).toHaveLength(2)
    expect(children[0].killed).toBe(1)
    expect(svc.childFor("chan1")).toBe(children[1])
  } finally { await server.close() }
})

test("ensureReady does not start a child when health already passes", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, children } = fakes()
  const server = await healthServer(true)
  try {
    db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
      sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await svc.ensureReady("chan1")
    expect(children).toHaveLength(0)
    expect(svc.childFor("chan1")).toBeUndefined()
    expect(db.projects.getByChannel("chan1")?.status).toBe("ready")
  } finally { await server.close() }
})

test("an unexpected child exit marks the project degraded", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, children } = fakes()
  const server = await healthServer(true)
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    children[0].emitExit()
    expect(svc.childFor("chan-demo")).toBeUndefined()
    expect(db.projects.getByChannel("chan-demo")?.status).toBe("degraded")
  } finally { await server.close() }
})

test("stop kills the child but does not mark the project degraded", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, children } = fakes()
  const server = await healthServer(true)
  const deleted: string[] = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    await svc.stop("chan-demo")
    expect(children[0].killed).toBe(1)
    expect(calls).toContainEqual(["stop", "cely-demo"])
    expect(svc.childFor("chan-demo")).toBeUndefined()
    expect(db.projects.getByChannel("chan-demo")?.status).toBe("ready")
    children[0].emitExit()
    expect(db.projects.getByChannel("chan-demo")?.status).toBe("ready")
    expect(deleted).toEqual([])
  } finally { await server.close() }
})

test("remove kills the child, deletes the sandbox, row, and channel", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, children } = fakes()
  const server = await healthServer(true)
  const deleted: string[] = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(svc.childFor("chan-demo")).toBeDefined()
    await svc.remove("chan-demo")
    expect(children[0].killed).toBe(1)
    expect(svc.childFor("chan-demo")).toBeUndefined()
    expect(calls).toContainEqual(["rm", "cely-demo"])
    expect(db.projects.list()).toEqual([])
    expect(deleted).toEqual(["chan-demo"])
  } finally { await server.close() }
})
