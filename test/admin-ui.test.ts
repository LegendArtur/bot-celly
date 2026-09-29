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
  return { svr, db, calls, base: `http://127.0.0.1:${svr.port}`, getProgress: (stage: string) => progress?.(stage) }
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
    const res = await fetch(`${base}/partials/stats`, { method: "POST" })
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

test("fragment actions call the injected function and return the card plus partials", async () => {
  const { svr, base, calls } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects/c1/restart`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(calls).toEqual(["restart:c1"])
    expect(body).toContain(`id="project-c1"`)
    expect(body).toContain(`hx-partial hx-target="#stats"`)
    expect(body).toContain(`hx-partial hx-target="#usage"`)
    expect(body).toContain(`hx-partial hx-target="#audit"`)
  } finally { svr.close() }
})

test("fragment action on an unknown project is a 404 and a throwing action renders an error card", async () => {
  const { svr, base } = await ui()
  try {
    expect((await fetch(`${base}/partials/projects/nope/start`, { method: "POST" })).status).toBe(404)
    expect((await fetch(`${base}/partials/projects/c1/start`, { method: "GET" })).status).toBe(405)
  } finally { svr.close() }
  const failing = await createAdminServer({
    port: 0, db: (() => { const d = openDb(":memory:"); d.migrate(); d.projects.insertProvisioning(proj); return d })(),
    secrets: [], guildIds: [], logFileFor: () => undefined,
    start: async () => { throw new Error("boom") }, stop: async () => {}, restart: async () => {},
    create: async () => {}, remove: async () => {},
  })
  try {
    const res = await fetch(`http://127.0.0.1:${failing.port}/partials/projects/c1/start`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("id=\"project-c1\"")
    expect(body).toContain("boom")
  } finally { failing.close() }
})

test("POST /api/projects/:id/restart mirrors the JSON action shape", async () => {
  const { svr, base, calls } = await ui()
  try {
    const res = await fetch(`${base}/api/projects/c1/restart`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, action: "restart", channelId: "c1" })
    expect(calls).toEqual(["restart:c1"])
  } finally { svr.close() }
})

test("GET /events sends a snapshot, then a changed project update", async () => {
  const { svr, db, base } = await ui({ liveTickMs: 25 })
  const controller = new AbortController()
  try {
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + 2000
    let text = ""
    while (!text.includes(`hx-target="#projects"`) && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain(`hx-partial hx-target="#projects"`)
    expect(text).toContain(`hx-partial hx-target="#stats"`)
    db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "celly-second", sandboxName: "sbx-second", hostPort: 4302 })
    while (!text.includes("celly-second") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain("celly-second")
  } finally { controller.abort(); svr.close() }
})

test("a tick re-renders cards when usage or sessions change and updates the project count", async () => {
  const { svr, db, base } = await ui({ liveTickMs: 25 })
  const controller = new AbortController()
  try {
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + 2000
    let text = ""
    while (!text.includes(`hx-target="#projects"`) && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: "work", model: "m", agent: null, variant: null,
      worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 2 })
    db.threads.addUsage("t1", { cost: 1.5, tokensIn: 1000, tokensOut: 2000, cacheRead: 0, cacheWrite: 0 })
    while (!text.includes("$1.50") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain("$1.50")
    expect(text).toContain("3.0k")
    db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "celly-second", sandboxName: "sbx-second", hostPort: 4302 })
    while (!text.includes(`hx-target="#project-count">2<`) && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain(`hx-target="#project-count">2<`)
  } finally { controller.abort(); svr.close() }
})

test("a changed log file streams into the #logs-c1 target with secrets redacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-admin-"))
  const file = join(dir, "sbx-demo.log")
  writeFileSync(file, "[out] first\n")
  const { svr, base } = await ui({ logFileFor: () => file, secrets: ["pw-secret"] })
  const controller = new AbortController()
  try {
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    const deadline = Date.now() + 1500
    writeFileSync(file, "[out] first\n[err] pw-secret leaked\n")
    while (!text.includes("#logs-c1") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain(`hx-target="#logs-c1"`)
    expect(text).toContain("[redacted]")
    expect(text).not.toContain("pw-secret")
  } finally { controller.abort(); svr.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("a fragment action broadcasts fresh regions over SSE", async () => {
  const { svr, base, calls } = await ui()
  try {
    const controller = new AbortController()
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    await reader.read()
    await fetch(`${base}/partials/projects/c1/restart`, { method: "POST" })
    let text = ""
    const deadline = Date.now() + 1500
    while (!text.includes("#audit") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(calls).toEqual(["restart:c1"])
    expect(text).toContain(`hx-target="#projects"`)
    controller.abort()
  } finally { svr.close() }
})

test("POST /partials/projects validates fields and kicks off create", async () => {
  const { svr, base, calls } = await ui()
  try {
    const form = new URLSearchParams({ name: "newproj", guildId: "g1", cloneUrl: "https://example.com/x.git", branch: "main" })
    const res = await fetch(`${base}/partials/projects`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } })
    expect(res.status).toBe(204)
    expect(calls).toEqual(["create:newproj:g1"])
    const bad = await fetch(`${base}/partials/projects`, { method: "POST", body: new URLSearchParams({ name: "x", guildId: "g1", branch: "main" }) })
    expect(bad.status).toBe(400)
    const noguild = await fetch(`${base}/partials/projects`, { method: "POST", body: new URLSearchParams({ name: "x", guildId: "nope" }) })
    expect(noguild.status).toBe(400)
  } finally { svr.close() }
})

test("create progress and completion are streamed into #notice", async () => {
  const { svr, base, getProgress } = await ui()
  try {
    const controller = new AbortController()
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    await reader.read()
    await fetch(`${base}/partials/projects`, { method: "POST", body: new URLSearchParams({ name: "newproj", guildId: "g1" }) })
    getProgress?.("creating sandbox…")
    let text = ""
    const deadline = Date.now() + 1500
    while (!text.includes("creating sandbox") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain(`hx-target="#notice"`)
    expect(text).toContain("creating sandbox")
    controller.abort()
  } finally { svr.close() }
})

test("POST /partials/projects/:id/delete removes the project and clears the detail", async () => {
  const { svr, base, calls } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects/c1/delete`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(calls).toEqual(["remove:c1"])
    const body = await res.text()
    expect(body).toContain(`hx-partial hx-target="#detail"`)
  } finally { svr.close() }
})

test("JSON create, delete, and delete 404 mirror the fragment behavior", async () => {
  const { svr, base, calls } = await ui()
  try {
    expect((await fetch(`${base}/api/projects`, { method: "POST", body: new URLSearchParams({ name: "newproj", guildId: "g1" }) })).status).toBe(201)
    expect((await fetch(`${base}/api/projects/c1`, { method: "DELETE" })).status).toBe(200)
    expect((await fetch(`${base}/api/projects/nope`, { method: "DELETE" })).status).toBe(404)
    expect(calls).toEqual(["create:newproj:g1", "remove:c1"])
  } finally { svr.close() }
})

test("GET /partials/projects/:id/detail renders logs, sessions, and marks the card selected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-admin-"))
  const file = join(dir, "sbx-demo.log")
  writeFileSync(file, "[out] booted\n[err] pw-secret leaked\n")
  const { svr, db, base } = await ui({ logFileFor: () => file })
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: "work", model: "m", agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 2 })
  try {
    const res = await fetch(`${base}/partials/projects/c1/detail`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`id="logs-c1"`)
    expect(body).toContain("thread/t1")
    expect(body).toContain("[redacted]")
    expect(body).not.toContain("pw-secret")
    expect(body).toContain(`hx-partial hx-target="#project-c1"`)
    expect(body).toContain(`aria-current="true"`)
    expect((await fetch(`${base}/partials/projects/nope/detail`)).status).toBe(404)
  } finally { svr.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("app.js exposes the copy-to-clipboard behavior", async () => {
  const { svr, base } = await ui()
  try {
    const body = await (await fetch(`${base}/assets/app.js`)).text()
    expect(body).toContain("data-copy")
    expect(body).toContain("navigator.clipboard")
  } finally { svr.close() }
})
