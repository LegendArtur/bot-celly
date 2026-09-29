import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createAdminServer } from "../src/admin.ts"
import { freshDb, projectFixture } from "./helpers/fixtures.ts"

const proj = projectFixture({ channelId: "c1" })

async function admin(over: any = {}) {
  const db = over.db ?? freshDb()
  if (!over.skipProject) { db.projects.insertProvisioning(proj); db.projects.setReady("c1", "C:\\p") }
  const calls: string[] = []
  const svr = await createAdminServer({
    port: 0,
    db,
    secrets: over.secrets ?? [],
    logFileFor: over.logFileFor ?? (() => undefined),
    start: async (channelId: string) => { calls.push(`start:${channelId}`) },
    stop: async (channelId: string) => { calls.push(`stop:${channelId}`) },
    auditTail: over.auditTail,
    now: over.now,
  })
  return { svr, db, calls, base: `http://127.0.0.1:${svr.port}` }
}

test("the admin server binds loopback and renders the HTML status page", async () => {
  const { svr, db, base } = await admin()
  db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "<b>bold</b>", sandboxName: "celly-bold", hostPort: 4301 })
  try {
    expect(svr.address).toBe("127.0.0.1")
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("demo")
    expect(body).toContain("&lt;b&gt;bold&lt;/b&gt;")
    expect(body).toContain("Local only")
    expect(body).toContain("127.0.0.1")
    expect(body).toContain("ADMIN_PORT=0")
  } finally {
    svr.close()
  }
})

test("GET /api/projects returns the registered projects", async () => {
  const { svr, base } = await admin()
  try {
    const res = await fetch(`${base}/api/projects`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ channelId: "c1", name: "demo", status: "ready", hostPort: 4300 }])
  } finally {
    svr.close()
  }
})

test("GET /api/health reports project counts and uptime", async () => {
  const { svr, base } = await admin({ now: () => 10_000 })
  try {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, projects: 1, ready: 1, uptimeMs: 0 })
  } finally {
    svr.close()
  }
})

test("POST start and stop call the injected actions and 404 unknown projects", async () => {
  const { svr, base, calls } = await admin()
  try {
    expect((await fetch(`${base}/api/projects/c1/start`, { method: "POST" })).status).toBe(200)
    expect((await fetch(`${base}/api/projects/c1/stop`, { method: "POST" })).status).toBe(200)
    expect(calls).toEqual(["start:c1", "stop:c1"])
    const missing = await fetch(`${base}/api/projects/nope/start`, { method: "POST" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "unknown project" })
    expect((await fetch(`${base}/api/projects/c1/start`)).status).toBe(405)
  } finally {
    svr.close()
  }
})

test("a failing project action returns a JSON 500", async () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  const svr = await createAdminServer({ port: 0, db, secrets: [], logFileFor: () => undefined,
    start: async () => { throw new Error("boom") }, stop: async () => {} })
  try {
    const res = await fetch(`http://127.0.0.1:${svr.port}/api/projects/c1/start`, { method: "POST" })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "boom" })
  } finally {
    svr.close()
  }
})

test("GET /api/logs tails and redacts the project log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-admin-"))
  const file = join(dir, "celly-demo.log")
  writeFileSync(file, ["one", "two", "pw-secret", "four", "five"].join("\n") + "\n")
  const { svr, base } = await admin({ secrets: ["pw-secret"], logFileFor: () => file })
  try {
    const res = await fetch(`${base}/api/logs/c1?lines=4`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.channelId).toBe("c1")
    expect(body.file).toBe(file)
    expect(body.lines).toHaveLength(4)
    expect(body.lines.join("\n")).toContain("[redacted]")
    expect(body.lines.join("\n")).not.toContain("pw-secret")
    expect(body.lines.join("\n")).not.toContain("one")
    const all = await (await fetch(`${base}/api/logs/c1`)).json()
    expect(all.lines).toHaveLength(5)
  } finally {
    svr.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("GET /api/logs 404s when there is no log file", async () => {
  const { svr, base } = await admin({ logFileFor: () => undefined })
  try {
    const res = await fetch(`${base}/api/logs/c1`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "log not found" })
  } finally {
    svr.close()
  }
})

test("GET /api/audit returns injected entries and 404s when unavailable", async () => {
  const withAudit = await admin({ auditTail: (limit: number) => [{ kind: "mode", limit }] })
  try {
    const res = await fetch(`${withAudit.base}/api/audit?limit=5`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [{ kind: "mode", limit: 5 }] })
  } finally {
    withAudit.svr.close()
  }
  const without = await admin()
  try {
    const res = await fetch(`${without.base}/api/audit`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "audit log unavailable" })
  } finally {
    without.svr.close()
  }
})

test("unknown routes and methods return JSON errors", async () => {
  const { svr, base } = await admin()
  try {
    const notFound = await fetch(`${base}/api/nope`)
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ error: "not found" })
    const wrongMethod = await fetch(`${base}/api/health`, { method: "POST" })
    expect(wrongMethod.status).toBe(405)
    expect(await wrongMethod.json()).toEqual({ error: "method not allowed" })
  } finally {
    svr.close()
  }
})
