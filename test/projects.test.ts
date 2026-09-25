import { createServer } from "node:http"
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

function fakes() {
  const calls: string[][] = []
  let streams = 0
  const sbx: any = {
    list: async () => [], ports: async () => [{ hostIp: "127.0.0.1", hostPort: 4300, sandboxPort: 4096, protocol: "tcp4" }],
    create: async (o: any) => { calls.push(["create", o.name]) },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    start: async (n: string) => { calls.push(["start", n]); return { code: 0, stdout: "", stderr: "" } },
    cp: async () => {}, stop: async (n: string) => { calls.push(["stop", n]) },
    remove: async (n: string) => { calls.push(["rm", n]) },
    execStream: () => { streams++; return { on() {}, kill() {}, stdout: { on() {} }, stderr: { on() {} } } },
  }
  return { calls, sbx, runner: { run: async () => ({ code: 0, stdout: "[]", stderr: "" }) }, streams: () => streams }
}

test("addProject rejects directories outside PROJECTS_ROOT", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\Windows" })).rejects.toThrow(/PROJECTS_ROOT/)
})

test("addProject rolls back on create failure", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  sbx.create = async () => { throw new Error("create boom") }
  const deleted: string[] = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/create boom/)
  expect(db.projects.list()).toEqual([])
  expect(calls).toContainEqual(["rm", "cely-demo"])
  expect(deleted).toEqual(["chan1"])
})

test("addProject rolls back and kills the child when health never passes", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, streams } = fakes()
  const server = await healthServer(false)
  const deleted: string[] = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
    await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/health/)
    expect(streams()).toBe(1)
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

test("ensureReady is single-flighted and boots the server when health fails", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls, streams } = fakes()
  const server = await healthServer(false)
  try {
    db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
      sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await Promise.all([svc.ensureReady("chan1"), svc.ensureReady("chan1")])
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(1)
    expect(streams()).toBe(1)
    expect(svc.childFor("chan1")).toBeDefined()
  } finally { await server.close() }
})

test("ensureReady does not start another child when health already passes", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, streams } = fakes()
  const server = await healthServer(true)
  try {
    db.projects.insertProvisioning({ channelId: "chan1", guildId: "g", name: "demo", directory: "C:\\projects\\demo",
      sandboxPath: null, sandboxName: "cely-demo", hostPort: server.port, serverPassword: "pw", createdAt: Date.now() })
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
    await svc.ensureReady("chan1")
    expect(streams()).toBe(0)
    expect(svc.childFor("chan1")).toBeUndefined()
  } finally { await server.close() }
})

test("remove kills the child, deletes the sandbox, row, and channel", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const server = await healthServer(true)
  const deleted: string[] = []
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) } } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
    expect(svc.childFor("chan-demo")).toBeDefined()
    await svc.remove("chan-demo")
    expect(svc.childFor("chan-demo")).toBeUndefined()
    expect(calls).toContainEqual(["rm", "cely-demo"])
    expect(db.projects.list()).toEqual([])
    expect(deleted).toEqual(["chan-demo"])
  } finally { await server.close() }
})
