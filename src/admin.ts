import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import type { Db } from "./db.ts"
import type { Project, Thread, UsageTotals } from "./types.ts"
import { redact } from "./log.js"
import { attachCommand } from "./attach.js"
import { readAsset } from "./admin/assets.js"
import { createSseHub, encodeFrame } from "./admin/sse.js"
import {
  escapeHtml, formatClock, renderAudit, renderDetail, renderLogLines, renderNotice, renderPage,
  renderProjectCard, renderProjects, renderStats, renderUsage,
} from "./admin/views.js"
import type { AuditView, DetailView, ProjectView, SessionView, StatsView } from "./admin/views.ts"

export const ADMIN_HOST = "127.0.0.1"

const LOG_TAIL_BYTES = 64 * 1024

function tailFileSync(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  const fd = openSync(path, "r")
  try {
    const buf = Buffer.alloc(length)
    const bytes = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, bytes).toString("utf8")
  } finally {
    closeSync(fd)
  }
}

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
  const logs = file && existsSync(file) ? tailLines(redact(tailFileSync(file, LOG_TAIL_BYTES), deps.secrets), 200) : []
  const projectView = projectViewFor(project, deps, nowMs)
  const sessions: SessionView[] = deps.db.threads.byChannel(channelId).map((t: Thread) => ({
    threadId: t.threadId, title: t.title ?? `session ${t.sessionId}`, sessionId: t.sessionId,
    model: t.model, agent: t.agent, renderState: t.renderState, lastActiveAt: t.lastActiveAt,
    attach: attachCommand(project, t.sessionId),
  }))
  return { project: projectView, logs, sessions }
}

function renderCardWithError(deps: AdminDeps, channelId: string, message: string): string | undefined {
  const project = deps.db.projects.getByChannel(channelId)
  if (!project) return undefined
  const card = renderProjectCard(projectViewFor(project, deps, deps.now?.() ?? Date.now()), deps.now?.() ?? Date.now())
  return card.replace("</article>", `<div class="notice error">${escapeHtml(message)}</div></article>`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}

async function readForm(req: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.byteLength
    if (size > 8192) break
    chunks.push(buf)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
}

function parseCreateInput(form: URLSearchParams, deps: AdminDeps): { input: AdminCreateInput } | { error: string } {
  const name = (form.get("name") ?? "").trim()
  const guildId = (form.get("guildId") ?? "").trim()
  const cloneUrl = (form.get("cloneUrl") ?? "").trim() || undefined
  const branch = (form.get("branch") ?? "").trim() || undefined
  if (!name) return { error: "name required" }
  if (!deps.guildIds.includes(guildId)) return { error: "unknown guild" }
  if (branch && !cloneUrl) return { error: "branch requires clone" }
  return { input: { guildId, name, ...(cloneUrl ? { cloneUrl } : {}), ...(branch ? { branch } : {}) } }
}

export async function createAdminServer(deps: AdminDeps): Promise<AdminServer> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const sse = createSseHub()
  const signatures = new Map<string, string>()
  const logStats = new Map<string, string>()
  const partial = (target: string, html: string) => `<hx-partial hx-target="${target}">${html}</hx-partial>`

  function region(target: string, html: string, signature: string): void {
    if (signatures.get(target) === signature) return
    signatures.set(target, signature)
    sse.broadcast(partial(target, html))
  }

  function snapshot(): string {
    const nowMs = now()
    const projects = buildProjects(deps, nowMs)
    const totals = deps.db.usage.totals()
    return [
      partial("#projects", renderProjects(projects, nowMs)),
      partial("#project-count", String(projects.length)),
      partial("#stats", renderStats(buildStats(projects, totals, Math.max(0, nowMs - startedAt)))),
      partial("#usage", renderUsage(totals)),
      partial("#audit", renderAudit(buildAudit(deps))),
    ].join("\n")
  }

  function broadcastAll(): void {
    signatures.clear()
    sse.broadcast(snapshot())
  }

  const tick = setInterval(() => {
    try {
      const nowMs = now()
      const list = deps.db.projects.list()
      const projects = buildProjects(deps, nowMs)
      const totals = deps.db.usage.totals()
      const auditRaw = deps.auditTail?.(20) ?? []
      const stats = buildStats(projects, totals, Math.max(0, nowMs - startedAt))
      region("#projects", renderProjects(projects, nowMs), JSON.stringify(projects.map((p) => [p.channelId, p.status, p.hostPort, p.lastActiveAt, p.name, p.sandboxName, p.spend, p.tokens, p.sessions])))
      region("#project-count", String(projects.length), String(projects.length))
      region("#stats", renderStats(stats), JSON.stringify({ ...stats, uptimeMs: Math.floor(stats.uptimeMs / 60_000) }))
      region("#usage", renderUsage(totals), JSON.stringify(totals))
      region("#audit", renderAudit(buildAudit(deps)), JSON.stringify(auditRaw))
      for (const p of list) {
        if (p.status !== "ready") continue
        const file = deps.logFileFor(p.channelId)
        if (!file || !existsSync(file)) {
          logStats.delete(p.channelId)
          region(`#logs-${p.channelId}`, renderLogLines([]), "")
          continue
        }
        const stat = statSync(file)
        const key = `${stat.mtimeMs}:${stat.size}`
        if (logStats.get(p.channelId) === key) continue
        logStats.set(p.channelId, key)
        const tail = tailLines(redact(tailFileSync(file, LOG_TAIL_BYTES), deps.secrets), 200).join("\n")
        region(`#logs-${p.channelId}`, renderLogLines(tail ? tail.split("\n") : []), tail)
      }
    } catch (e) {
      deps.log?.warn?.("admin tick failed", { error: String(e) })
    }
  }, deps.liveTickMs ?? 2000)
  if (typeof (tick as any).unref === "function") (tick as any).unref()

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
        if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 2 && method === "POST") {
          const parsed = parseCreateInput(await readForm(req), deps)
          if ("error" in parsed) return sendJson(res, 400, { error: parsed.error })
          void deps.create(parsed.input, (stage) => sse.broadcast(partial("#notice", renderNotice(stage, "info"))))
            .then(() => sse.broadcast(partial("#notice", "")))
            .catch((e) => {
              deps.log?.warn?.("admin create failed", { error: String(e) })
              sse.broadcast(partial("#notice", renderNotice(e instanceof Error ? e.message : String(e), "error")))
            })
          res.writeHead(204); res.end()
          return
        }
        if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 4 && parts[3] === "delete") {
          if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
          const channelId = parts[2]!
          if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
          try {
            await deps.remove(channelId)
            const nowMs = now()
            const body = renderProjects(buildProjects(deps, nowMs), nowMs) + `\n<hx-partial hx-target="#detail"></hx-partial>`
            broadcastAll()
            return sendHtml(res, 200, body)
          } catch (e) {
            deps.log?.warn?.("admin remove failed", { error: String(e) })
            const nowMs = now()
            const message = e instanceof Error ? e.message : String(e)
            return sendHtml(res, 200, renderProjects(buildProjects(deps, nowMs), nowMs) + `\n<hx-partial hx-target="#notice">${renderNotice(message, "error")}</hx-partial>`)
          }
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
        if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 4 && parts[3] === "detail") {
          if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
          const channelId = parts[2]!
          const detail = buildDetail(deps, channelId)
          if (!detail) return sendJson(res, 404, { error: "unknown project" })
          const nowMs = now()
          const selectedCard = renderProjectCard(projectViewFor(deps.db.projects.getByChannel(channelId)!, deps, nowMs, true), nowMs)
          sendHtml(res, 200, renderDetail(detail, nowMs) + `\n<hx-partial hx-target="#project-${channelId}">${selectedCard}</hx-partial>`)
          return
        }
        if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 4 && (parts[3] === "start" || parts[3] === "stop" || parts[3] === "restart")) {
          if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
          const channelId = parts[2]!
          if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
          const action = parts[3]
          const nowMs = now()
          try {
            await (action === "start" ? deps.start(channelId) : action === "stop" ? deps.stop(channelId) : deps.restart(channelId))
            const totals = deps.db.usage.totals()
            const projects = buildProjects(deps, nowMs)
            const body = renderProjectCard(projectViewFor(deps.db.projects.getByChannel(channelId)!, deps, nowMs), nowMs)
              + `\n<hx-partial hx-target="#stats">${renderStats(buildStats(projects, totals, Math.max(0, nowMs - startedAt)))}</hx-partial>`
              + `\n<hx-partial hx-target="#usage">${renderUsage(totals)}</hx-partial>`
              + `\n<hx-partial hx-target="#audit">${renderAudit(buildAudit(deps))}</hx-partial>`
            sendHtml(res, 200, body)
            broadcastAll()
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            const body = renderCardWithError(deps, channelId, message) ?? ""
            sendHtml(res, 200, body)
            broadcastAll()
          }
          return
        }
        if (parts[0] === "api" && parts[1] === "projects" && parts.length === 2 && method === "POST") {
          const parsed = parseCreateInput(await readForm(req), deps)
          if ("error" in parsed) return sendJson(res, 400, { error: parsed.error })
          try {
            await deps.create(parsed.input)
            broadcastAll()
            return sendJson(res, 201, { ok: true, name: parsed.input.name })
          } catch (e) {
            return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
        }
        if (parts[0] === "api" && parts[1] === "projects" && parts.length === 3 && method === "DELETE") {
          const channelId = parts[2]!
          if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
          try {
            await deps.remove(channelId)
            broadcastAll()
            return sendJson(res, 200, { ok: true, channelId })
          } catch (e) {
            return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
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
        if (parts[0] === "api" && parts[1] === "projects" && parts.length === 4 && (parts[3] === "start" || parts[3] === "stop" || parts[3] === "restart")) {
          if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
          const channelId = parts[2]!
          if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
          const action = parts[3]
          const run = action === "start" ? deps.start : action === "stop" ? deps.stop : deps.restart
          try {
            await run(channelId)
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
        if (parts[0] === "events" && parts.length === 1 && method === "GET") {
          sse.add(res)
          res.write(encodeFrame(snapshot()))
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
      clearInterval(tick)
      sse.closeAll()
      server.closeAllConnections()
      server.close()
    },
  }
}
