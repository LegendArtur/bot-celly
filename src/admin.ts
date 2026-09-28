import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import type { Db } from "./db.ts"
import type { Project, Thread, UsageTotals } from "./types.ts"
import { redact } from "./log.js"
import { attachCommand } from "./attach.js"
import { readAsset } from "./admin/assets.js"
import {
  formatClock, renderAudit, renderPage, renderProjects,
  renderStats, renderUsage,
} from "./admin/views.js"
import type { AuditView, DetailView, ProjectView, SessionView, StatsView } from "./admin/views.ts"

export const ADMIN_HOST = "127.0.0.1"

export interface AdminCreateInput {
  guildId: string
  name: string
  cloneUrl?: string
  branch?: string
}

export interface AdminDeps {
  port: number
  db: Pick<Db, "projects" | "threads" | "usage">
  secrets: string[]
  guildIds: string[]
  logFileFor(channelId: string): string | undefined
  start(channelId: string): Promise<void>
  stop(channelId: string): Promise<void>
  restart(channelId: string): Promise<void>
  create(input: AdminCreateInput, onProgress?: (stage: string) => void): Promise<void>
  remove(channelId: string): Promise<void>
  auditTail?(limit: number): unknown[]
  now?(): number
  liveTickMs?: number
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
}

export interface AdminServer {
  port: number
  address: string
  close(): void
}

export function tailLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-count)
}

function projectViewFor(p: Project, deps: AdminDeps, now: number, selected = false): ProjectView {
  const usage = deps.db.usage.channel(p.channelId)
  return {
    channelId: p.channelId, name: p.name, status: p.status, hostPort: p.hostPort,
    sandboxName: p.sandboxName, lastActiveAt: p.lastActiveAt,
    spend: usage.cost, tokens: usage.tokensIn + usage.tokensOut,
    sessions: deps.db.threads.byChannel(p.channelId).length,
    ...(selected ? { selected: true } : {}),
  }
}

function buildProjects(deps: AdminDeps, now: number): ProjectView[] {
  return deps.db.projects.list().map((p) => projectViewFor(p, deps, now))
}

function buildStats(projects: ProjectView[], totals: UsageTotals, uptimeMs: number): StatsView {
  return {
    total: projects.length,
    ready: projects.filter((p) => p.status === "ready").length,
    degraded: projects.filter((p) => p.status === "degraded").length,
    provisioning: projects.filter((p) => p.status === "provisioning").length,
    cost: totals.cost,
    tokens: totals.tokensIn + totals.tokensOut,
    uptimeMs,
  }
}

function toAuditView(raw: unknown): AuditView {
  const e = (raw ?? {}) as Record<string, unknown>
  const ts = typeof e.ts === "string" ? Date.parse(e.ts) : Number.NaN
  return {
    time: Number.isFinite(ts) ? formatClock(ts) : "",
    kind: typeof e.kind === "string" ? e.kind : "event",
    detail: typeof e.detail === "string" ? e.detail : "",
    decision: typeof e.decision === "string" ? e.decision : "",
  }
}

function buildAudit(deps: AdminDeps): AuditView[] {
  return (deps.auditTail?.(20) ?? []).map(toAuditView)
}

function buildDetail(deps: AdminDeps, channelId: string): DetailView | undefined {
  const project = deps.db.projects.getByChannel(channelId)
  if (!project) return undefined
  const nowMs = deps.now?.() ?? Date.now()
  const file = deps.logFileFor(channelId)
  const logs = file && existsSync(file) ? tailLines(redact(readFileSync(file, "utf8"), deps.secrets), 200) : []
  const projectView = projectViewFor(project, deps, nowMs)
  const sessions: SessionView[] = deps.db.threads.byChannel(channelId).map((t: Thread) => ({
    threadId: t.threadId, title: t.title ?? `session ${t.sessionId}`, sessionId: t.sessionId,
    model: t.model, agent: t.agent, renderState: t.renderState, lastActiveAt: t.lastActiveAt,
    attach: attachCommand(project, t.sessionId),
  }))
  return { project: projectView, logs, sessions }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
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
          const nowMs = now()
          const totals = deps.db.usage.totals()
          const projectViews = buildProjects(deps, nowMs)
          sendHtml(res, 200, renderPage({
            now: nowMs,
            uptimeMs: Math.max(0, nowMs - startedAt),
            projects: projectViews,
            stats: buildStats(projectViews, totals, Math.max(0, nowMs - startedAt)),
            usage: totals,
            audit: buildAudit(deps),
            guildIds: deps.guildIds,
          }))
          return
        }
        if (parts[0] === "assets" && parts.length === 2 && method === "GET") {
          const asset = readAsset(parts[1]!)
          if (!asset) return sendJson(res, 404, { error: "not found" })
          res.writeHead(200, { "content-type": asset.contentType, "content-length": asset.body.byteLength, "cache-control": "no-store" })
          res.end(asset.body)
          return
        }
        if (parts[0] === "partials" && parts.length === 2 && (parts[1] === "projects" || parts[1] === "stats" || parts[1] === "usage" || parts[1] === "audit")) {
          if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
          const nowMs = now()
          const totals = deps.db.usage.totals()
          if (parts[1] === "projects") return sendHtml(res, 200, renderProjects(buildProjects(deps, nowMs), nowMs))
          if (parts[1] === "stats") {
            const projects = buildProjects(deps, nowMs)
            return sendHtml(res, 200, renderStats(buildStats(projects, totals, Math.max(0, nowMs - startedAt))))
          }
          if (parts[1] === "usage") return sendHtml(res, 200, renderUsage(totals))
          return sendHtml(res, 200, renderAudit(buildAudit(deps)))
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
