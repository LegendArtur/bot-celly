import { createServer } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"
import { BOOTSTRAP_SCRIPT, celyPolicy } from "../src/opencode.ts"
import { ProjectService } from "../src/projects.ts"

function makeCfg(portStart: number, portEnd: number): any {
  return { projectsRoot: "C:\\projects", sandboxTemplate: "opencode", sandboxCpus: 2, sandboxMemory: "4g",
    portRangeStart: portStart, portRangeEnd: portEnd, bootTimeoutMs: 100, healthTimeoutMs: 50,
    dataDir: mkdtempSync(join(tmpdir(), "cely-data-")) }
}

const logger = () => ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this } }) as any

async function healthServer(healthy: boolean, config: any = celyPolicy(), honorPatch = true) {
  let current = config
  const server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/config")) {
      if (req.method === "PATCH" || req.method === "POST") {
        let body = ""
        req.on("data", (c) => { body += c })
        req.on("end", () => { if (honorPatch) { try { current = JSON.parse(body) } catch {} }; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(current)) })
        return
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(current))
      return
    }
    if (healthy) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true }))
    else res.writeHead(503).end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

function makeChild() {
  const child: any = { killed: 0, stdoutData: 0, stderrData: 0, listeners: {} as Record<string, Function[]>, stdoutListeners: {} as Record<string, Function[]>, stderrListeners: {} as Record<string, Function[]> }
  child.on = (ev: string, fn: Function) => { (child.listeners[ev] ??= []).push(fn) }
  child.kill = () => { child.killed++ }
  child.emitExit = () => { for (const fn of child.listeners.exit ?? []) fn() }
  child.stdout = { on: (ev: string, fn: Function) => { if (ev === "data") { child.stdoutData++; (child.stdoutListeners.data ??= []).push(fn) } } }
  child.stderr = { on: (ev: string, fn: Function) => { if (ev === "data") { child.stderrData++; (child.stderrListeners.data ??= []).push(fn) } } }
  child.emitStdout = (d: unknown) => { for (const fn of child.stdoutListeners.data ?? []) fn(d) }
  child.emitStderr = (d: unknown) => { for (const fn of child.stderrListeners.data ?? []) fn(d) }
  return child
}

function fakes() {
  const calls: string[][] = []
  const children: any[] = []
  const published = new Map<string, number>()
  const sbx: any = {
    list: async () => [...published.keys()].map((name) => ({ name, agent: "opencode", status: "running" })),
    ports: async (name: string) => (published.has(name)
      ? [{ hostIp: "127.0.0.1", hostPort: published.get(name), sandboxPort: 4096, protocol: "tcp4" }]
      : []),
    create: async (o: any) => { calls.push(["create", o.name]); published.set(o.name, o.hostPort) },
    publish: async (name: string, mapping: string) => { calls.push(["publish", name, mapping]); published.set(name, Number(mapping.split(":")[0])) },
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

test("createProjectDirectory rejects a sensitive path without creating it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cely-root-"))
  try {
    const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
    const svc = new ProjectService({ sbx, runner: runner as any, db,
      config: { ...makeCfg(4600, 4600), projectsRoot: root }, log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {},
      forbiddenPaths: [join(root, "secret")] } as any)
    await expect(svc.createProjectDirectory("secret")).rejects.toThrow(/sensitive/)
    expect(existsSync(join(root, "secret"))).toBe(false)
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
    expect(parsed.permission).toEqual(celyPolicy().permission)
    expect(parsed.share).toBe("disabled")
  } finally { await server.close() }
})

test("addProject reports staged progress around the slow steps", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  const stages: string[] = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" }, (s) => { stages.push(s) })
    expect(stages).toEqual(["creating sandbox…", "installing…", "waiting for server…"])
  } finally { await server.close() }
})

test("a throwing progress callback does not fail the create saga", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    const p = await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" }, () => { throw new Error("discord down") })
    expect(p.status).toBe("ready")
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

test("addProject fails the saga closed when the server keeps a weakened policy", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, children } = fakes()
  const server = await healthServer(true, { share: "auto", permission: { "*": "allow" } }, false)
  const deleted: string[] = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
    await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/policy/)
    expect(db.projects.list()).toEqual([])
    expect(children).toHaveLength(1)
    expect(children[0].killed).toBe(1)
    expect(calls).toContainEqual(["rm", "cely-demo"])
    expect(deleted).toEqual(["chan-demo"])
  } finally { await server.close() }
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
    db.projects.setStatus("chan1", "ready")
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await expect(Promise.all([svc.ensureReady("chan1"), svc.ensureReady("chan1")])).rejects.toThrow(/not healthy/)
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(1)
    expect(children).toHaveLength(1)
    expect(children[0].killed).toBe(1)
    expect(svc.childFor("chan1")).toBeUndefined()
    await expect(svc.ensureReady("chan1")).rejects.toThrow(/not healthy/)
    expect(children).toHaveLength(2)
    expect(children[1].killed).toBe(1)
    expect(svc.childFor("chan1")).toBeUndefined()
  } finally { await server.close() }
})

test("ensureReady adopts a healthy orphan instead of spawning a second server", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, children } = fakes()
  const server = await healthServer(true)
  try {
    db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
      sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
    db.projects.setStatus("chan1", "ready")
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await svc.ensureReady("chan1")
    expect(children).toHaveLength(0)
    expect(svc.childFor("chan1")).toBeUndefined()
    expect(svc.isAdopted("chan1")).toBe(true)
    expect(db.projects.getByChannel("chan1")?.status).toBe("ready")
  } finally { await server.close() }
})

test("ensureReady rejects while the project is still provisioning", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    sandboxPath: null, sandboxName: "cely-demo", hostPort: 4600, serverPassword: "pw", createdAt: Date.now() })
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
  await expect(svc.ensureReady("chan1")).rejects.toThrow(/provisioning/)
  expect(calls.filter((c) => c[0] === "start")).toHaveLength(0)
})

test("addProject retries the sandbox bootstrap once before succeeding", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const server = await healthServer(true)
  let bootstrapRuns = 0
  let failOnce = true
  sbx.exec = async (_n: string, args: string[]) => {
    if (args[0] === "bash" && args[2] === BOOTSTRAP_SCRIPT) {
      bootstrapRuns++
      if (failOnce) { failOnce = false; throw new Error("bootstrap flaky") }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    const p = await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(p.status).toBe("ready")
    expect(bootstrapRuns).toBe(2)
    expect(calls).not.toContainEqual(["rm", "cely-demo"])
  } finally { await server.close() }
})

test("ensureReady marks a missing sandbox degraded with a recreate notice", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  sbx.start = async () => { throw new Error("no such sandbox") }
  sbx.list = async () => []
  db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    sandboxPath: null, sandboxName: "cely-demo", hostPort: 4600, serverPassword: "pw", createdAt: Date.now() })
  db.projects.setStatus("chan1", "ready")
  const missing: Array<[string, string]> = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {},
    onProjectMissing: (channelId: string, name: string) => { missing.push([channelId, name]) } } as any)
  await expect(svc.ensureReady("chan1")).rejects.toThrow(/project start/)
  expect(db.projects.getByChannel("chan1")?.status).toBe("degraded")
  expect(missing).toEqual([["chan1", "demo"]])
})

test("start recreates a missing sandbox via the create path", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const server = await healthServer(true)
  sbx.list = async () => []
  db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
  db.projects.setStatus("chan1", "ready")
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await svc.start("chan1")
    expect(calls).toContainEqual(["create", "cely-demo"])
    expect(db.projects.getByChannel("chan1")?.status).toBe("ready")
    expect(db.projects.getByChannel("chan1")?.serverPassword).toMatch(/^[0-9a-f]{32}$/)
    expect(db.projects.getByChannel("chan1")?.serverPassword).not.toBe("pw")
  } finally { await server.close() }
})

test("start wakes an existing sandbox through ensureReady", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const server = await healthServer(true)
  sbx.list = async () => [{ name: "cely-demo", agent: "opencode", status: "running" }]
  db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
  db.projects.setStatus("chan1", "ready")
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await svc.start("chan1")
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(1)
  } finally { await server.close() }
})

test("ensureReady reconciles a drifted host port from sbx ports", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  sbx.ports = async () => [{ hostIp: "127.0.0.1", hostPort: server.port, sandboxPort: 4096, protocol: "tcp4" }]
  db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    sandboxPath: null, sandboxName: "cely-demo", hostPort: 4999, serverPassword: "pw", createdAt: Date.now() })
  db.projects.setStatus("chan1", "ready")
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await svc.ensureReady("chan1")
    expect(db.projects.getByChannel("chan1")?.hostPort).toBe(server.port)
  } finally { await server.close() }
})

test("ensureReady re-publishes a missing 4096 mapping under a timeout", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const server = await healthServer(true)
  let published = false
  sbx.ports = async () => (published
    ? [{ hostIp: "127.0.0.1", hostPort: server.port, sandboxPort: 4096, protocol: "tcp4" }]
    : [])
  const basePublish = sbx.publish
  sbx.publish = async (name: string, mapping: string) => { await basePublish(name, mapping); published = true }
  db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
  db.projects.setStatus("chan1", "ready")
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await svc.ensureReady("chan1")
    expect(calls).toContainEqual(["publish", "cely-demo", `${server.port}:4096`])
  } finally { await server.close() }
})

test("ensureReady waits for an in-flight create saga instead of racing it", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const server = await healthServer(true)
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const baseCreate = sbx.create
  sbx.create = async (o: any) => { await gate; return baseCreate(o) }
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    const add = svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    await new Promise((r) => setTimeout(r, 0))
    const ready = svc.ensureReady("chan-demo")
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(0)
    release()
    await add
    await ready
    expect(calls.filter((c) => c[0] === "create")).toHaveLength(1)
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(1)
  } finally { await server.close() }
})

test("a crash of a replacement child still marks the project degraded", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, children } = fakes()
  let healthy = true
  const server = createServer((_, res) => {
    if (healthy) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true }))
    else res.writeHead(503).end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  const baseExecStream = sbx.execStream
  sbx.execStream = () => {
    const c = baseExecStream()
    healthy = true
    const kill = c.kill
    c.kill = () => { kill(); healthy = false }
    return c
  }
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(port, port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {}, killTimeoutMs: 1000,
      applyPolicy: async () => {} } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    await svc.stop("chan-demo")
    await svc.ensureReady("chan-demo")
    expect(children).toHaveLength(2)
    children[1].emitExit()
    expect(db.projects.getByChannel("chan-demo")?.status).toBe("degraded")
  } finally { await new Promise<void>((r) => server.close(() => r())) }
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

test("addProject persists the actual host port read back from sbx ports", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  try {
    sbx.ports = async () => [{ hostIp: "127.0.0.1", hostPort: server.port, sandboxPort: 4096, protocol: "tcp4" }]
    const requested = server.port + 100
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(requested, requested), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    const p = await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(p.hostPort).toBe(server.port)
    expect(db.projects.getByChannel("chan-demo")?.hostPort).toBe(server.port)
  } finally { await server.close() }
})

test("addProject ignores a non-loopback port mapping and keeps the requested loopback port", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  try {
    sbx.ports = async () => [{ hostIp: "0.0.0.0", hostPort: server.port + 1, sandboxPort: 4096, protocol: "tcp4" }]
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    const p = await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(p.hostPort).toBe(server.port)
  } finally { await server.close() }
})

test("addProject does not reuse a host port held by an orphan sandbox", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  sbx.list = async () => [{ name: "cely-orphan", agent: "opencode", status: "running", hostPort: 4700 }]
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4700, 4700), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/exhausted/)
})

test("addProject rejects a directory inside a forbidden root", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const svc = new ProjectService({ sbx, runner: runner as any, db,
    config: { ...makeCfg(4600, 4600), projectsRoot: "/srv/projects" }, log: logger(),
    isPortFree: async () => true, createChannel: async () => "c", deleteChannel: async () => {},
    forbiddenPaths: ["/srv/projects/data"] } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "/srv/projects/data/demo" })).rejects.toThrow(/sensitive/)
})

test("addProject persists the resolved in-sandbox workspace path", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {},
      resolveSandboxPath: async (name: string) => `/sandbox/${name}/workspace` } as any)
    const p = await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(p.sandboxPath).toBe("/sandbox/cely-demo/workspace")
  } finally { await server.close() }
})

test("addProject falls back to the host directory when sandbox path resolution fails", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {},
      resolveSandboxPath: async () => { throw new Error("no pwd") } } as any)
    const p = await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(p.sandboxPath).toBe("C:\\projects\\demo")
  } finally { await server.close() }
})

test("an unexpected child exit notifies the project-down callback once", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, children } = fakes()
  const server = await healthServer(true)
  const downs: Array<[string, string]> = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {},
      onProjectDown: (channelId: string, name: string) => { downs.push([channelId, name]) } } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    children[0].emitExit()
    children[0].emitExit()
    expect(downs).toEqual([["chan-demo", "demo"]])
  } finally { await server.close() }
})

test("concurrent addProject calls are serialized so ports do not collide", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const s1 = await healthServer(true); const s2 = await healthServer(true)
  try {
    const start = Math.min(s1.port, s2.port), end = Math.max(s1.port, s2.port)
    const listening = new Set([s1.port, s2.port])
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(start, end), log: logger(),
      isPortFree: async (p: number) => listening.has(p), createChannel: (n: string) => Promise.resolve("chan-" + n), deleteChannel: async () => {} } as any)
    const [a, b] = await Promise.all([
      svc.addProject({ guildId: "g", name: "alpha", directory: "C:\\projects\\alpha" }),
      svc.addProject({ guildId: "g", name: "beta", directory: "C:\\projects\\beta" }),
    ])
    expect(a.sandboxName).toBe("cely-alpha")
    expect(b.sandboxName).toBe("cely-beta")
    expect(a.hostPort).not.toBe(b.hostPort)
    expect(new Set([a.hostPort, b.hostPort]).size).toBe(2)
  } finally { await s1.close(); await s2.close() }
})

test("the supervised child's output is written to data/logs/<sandbox>.log", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cely-logs-"))
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, children } = fakes()
  const server = await healthServer(true)
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db,
      config: { ...makeCfg(server.port, server.port), dataDir }, log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {} } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    const password = db.projects.getByChannel("chan-demo")!.serverPassword
    children[0].emitStdout("hello from the server")
    children[0].emitStderr(`a warning token=${password}`)
    const logFile = join(dataDir, "logs", "cely-demo.log")
    expect(existsSync(logFile)).toBe(true)
    const contents = readFileSync(logFile, "utf8")
    expect(contents).toContain("hello from the server")
    expect(contents).toContain("a warning")
    expect(contents).not.toContain(password)
    expect(contents).toContain("[redacted]")
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
  } finally {
    await server.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
