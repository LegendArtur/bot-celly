import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import type { Db } from "./db.ts"
import { redact } from "./log.js"

export const ADMIN_HOST = "127.0.0.1"

export interface AdminDeps {
  port: number
  db: Pick<Db, "projects">
  secrets: string[]
  logFileFor(channelId: string): string | undefined
  start(channelId: string): Promise<void>
  stop(channelId: string): Promise<void>
  auditTail?(limit: number): unknown[]
  now?(): number
}

export interface AdminServer {
  port: number
  address: string
  close(): void
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function tailLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-count)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" })
  res.end(body)
}

export async function createAdminServer(deps: AdminDeps): Promise<AdminServer> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${ADMIN_HOST}`)
        const parts = url.pathname.split("/").filter(Boolean)
        const method = req.method ?? "GET"
        if (parts.length === 0 && method === "GET") {
          const rows = deps.db.projects.list()
            .map((p) => `<li>${escapeHtml(p.name)} — ${escapeHtml(p.status)} (${p.hostPort})</li>`).join("")
          sendHtml(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Celly admin</title></head><body><h1>Celly</h1><ul>${rows}</ul></body></html>`)
          return
        }
        if (parts[0] === "api" && parts[1] === "projects" && parts.length === 2 && method === "GET") {
          sendJson(res, 200, deps.db.projects.list().map((p) => ({ channelId: p.channelId, name: p.name, status: p.status, hostPort: p.hostPort })))
          return
        }
        if (parts[0] === "api" && parts[1] === "health" && parts.length === 2) {
          if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
          const projects = deps.db.projects.list()
          sendJson(res, 200, { ok: true, projects: projects.length, ready: projects.filter((p) => p.status === "ready").length, uptimeMs: Math.max(0, now() - startedAt) })
          return
        }
        if (parts[0] === "api" && parts[1] === "projects" && parts.length === 4 && (parts[3] === "start" || parts[3] === "stop")) {
          if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
          const channelId = parts[2]!
          if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
          const action = parts[3]
          try {
            await (action === "start" ? deps.start(channelId) : deps.stop(channelId))
            sendJson(res, 200, { ok: true, action, channelId })
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }
        if (parts[0] === "api" && parts[1] === "logs" && parts.length === 3 && method === "GET") {
          const channelId = parts[2]!
          const file = deps.logFileFor(channelId)
          if (!file || !existsSync(file)) return sendJson(res, 404, { error: "log not found" })
          const requested = Number(url.searchParams.get("lines") ?? "200")
          const count = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 2000) : 200
          const lines = tailLines(redact(readFileSync(file, "utf8"), deps.secrets), count)
          sendJson(res, 200, { channelId, file, lines })
          return
        }
        if (parts[0] === "api" && parts[1] === "audit" && parts.length === 2) {
          if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
          if (!deps.auditTail) return sendJson(res, 404, { error: "audit log unavailable" })
          const requested = Number(url.searchParams.get("limit") ?? "100")
          const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 1000) : 100
          sendJson(res, 200, { entries: deps.auditTail(limit) })
          return
        }
        sendJson(res, 404, { error: "not found" })
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(deps.port, ADMIN_HOST, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const bound = server.address()
  const boundPort = typeof bound === "object" && bound ? bound.port : deps.port
  const boundAddress = typeof bound === "object" && bound ? bound.address : ADMIN_HOST
  return {
    port: boundPort,
    address: boundAddress,
    close() {
      server.closeAllConnections()
      server.close()
    },
  }
}
