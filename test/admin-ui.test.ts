import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createAdminServer } from "../src/admin.ts"
import { openDb } from "../src/db.ts"

const proj = { channelId: "c1", guildId: "g1", name: "demo", directory: "C:\\p",
  sandboxPath: null, sandboxName: "sbx-demo", hostPort: 4300, serverPassword: "pw-secret", createdAt: 1 }

async function ui(over: any = {}) {
  const db = over.db ?? openDb(":memory:")
  if (!over.db) db.migrate()
  if (!over.skipProject) { db.projects.insertProvisioning(proj); db.projects.setReady("c1", "C:\\p") }
  const calls: string[] = []
  let progress: ((stage: string) => void) | undefined
  const svr = await createAdminServer({
    port: 0, db, secrets: over.secrets ?? ["pw-secret"], guildIds: over.guildIds ?? ["g1"],
    logFileFor: over.logFileFor ?? (() => undefined),
    start: async (id: string) => { calls.push(`start:${id}`) },
    stop: async (id: string) => { calls.push(`stop:${id}`) },
    restart: async (id: string) => { calls.push(`restart:${id}`) },
    create: async (input: any, onProgress?: (stage: string) => void) => { calls.push(`create:${input.name}:${input.guildId}`); progress = onProgress },
    remove: async (id: string) => { calls.push(`remove:${id}`) },
    auditTail: over.auditTail,
    now: over.now, liveTickMs: over.liveTickMs ?? 20,
  })
  return { svr, db, calls, base: `http://127.0.0.1:${svr.port}`, getProgress: () => progress }
}

test("GET /partials/projects renders cards and action wiring", async () => {
  const { svr, base } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`id="project-c1"`)
    expect(body).toContain(`hx-post="/partials/projects/c1/restart"`)
  } finally { svr.close() }
})

test("GET /partials/stats, usage, and audit render injected data", async () => {
  const { svr, base } = await ui({ auditTail: (limit: number) => [{ ts: new Date(2026, 0, 1, 9, 5).toISOString(), kind: "permission", detail: "allowed", decision: "allow", limit }] })
  try {
    expect(await (await fetch(`${base}/partials/stats`)).text()).toContain("Projects")
    expect(await (await fetch(`${base}/partials/usage`)).text()).toContain("Total spend")
    const audit = await (await fetch(`${base}/partials/audit`)).text()
    expect(audit).toContain("allowed")
    expect(audit).toContain("09:05")
  } finally { svr.close() }
})

test("fragment routes reject the wrong method", async () => {
  const { svr, base } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects`, { method: "POST" })
    expect(res.status).toBe(405)
  } finally { svr.close() }
})

test("GET /assets serves allowlisted files and 404s anything else", async () => {
  const { svr, base } = await ui()
  try {
    const css = await fetch(`${base}/assets/app.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get("content-type")).toContain("text/css")
    const js = await fetch(`${base}/assets/htmx.min.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toContain("application/javascript")
    expect((await fetch(`${base}/assets/package.json`)).status).toBe(404)
    expect((await fetch(`${base}/assets/..%2Fpackage.json`)).status).toBe(404)
  } finally { svr.close() }
})
