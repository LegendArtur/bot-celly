import type { ProjectStatus, UsageTotals } from "../types.ts"

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00"
  if (cost < 0.01) return "<$0.01"
  return `$${cost.toFixed(2)}`
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
  return String(Math.floor(tokens))
}

export function formatRelative(now: number, ts: number): string {
  if (!ts) return "never"
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function formatClock(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function renderNotice(text: string, kind: "info" | "error"): string {
  if (!text) return ""
  return `<div class="notice ${kind}">${escapeHtml(text)}</div>`
}

export interface ProjectView {
  channelId: string
  name: string
  status: ProjectStatus
  hostPort: number
  sandboxName: string
  lastActiveAt: number
  spend: number
  tokens: number
  sessions: number
  selected?: boolean
}

function metric(k: string, v: string): string {
  return `<div class="metric"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`
}

function actionButton(p: ProjectView, action: "start" | "stop" | "restart", label: string, confirm: boolean): string {
  const id = escapeHtml(p.channelId)
  const danger = action === "stop" ? " danger" : ""
  const confirmAttr = confirm ? ` hx-confirm="Stop #${escapeHtml(p.name)}?"` : ""
  return `<button class="btn${danger}" hx-post="/partials/projects/${id}/${action}" hx-target="#project-${id}" hx-swap="outerHTML" hx-disabled-elt="find button"${confirmAttr}>${label}</button>`
}

export function renderProjectCard(p: ProjectView, now: number): string {
  const id = escapeHtml(p.channelId)
  const current = p.selected ? ` aria-current="true"` : ""
  const actions: string[] = []
  if (p.status === "degraded") actions.push(actionButton(p, "start", "Start", false))
  if (p.status === "ready" || p.status === "degraded") {
    actions.push(actionButton(p, "restart", "Restart", false))
    actions.push(actionButton(p, "stop", "Stop", true))
  }
  if (p.status === "provisioning") actions.push(`<button class="btn" disabled>Starting…</button>`)
  actions.push(`<button class="btn" hx-get="/partials/projects/${id}/detail" hx-target="#detail" hx-swap="innerHTML" hx-disabled-elt="find button">Logs</button>`)
  actions.push(`<button class="btn danger" hx-post="/partials/projects/${id}/delete" hx-target="#projects" hx-swap="innerHTML" hx-confirm="Remove #${escapeHtml(p.name)}? This stops the sandbox and deletes the Discord channel. The host directory is kept.">Remove</button>`)
  return `<article id="project-${id}" class="project ${p.status}"${current}>
    <div class="row1">
      <div>
        <div class="name">#${escapeHtml(p.name)}</div>
        <div class="meta"><span class="pill ${p.status}"><span class="dot"></span>${escapeHtml(p.status)}</span> :${p.hostPort} · ${escapeHtml(p.sandboxName)} · active ${escapeHtml(formatRelative(now, p.lastActiveAt))}</div>
      </div>
      <div class="spacer"></div>
      <div class="actions">${actions.join("")}<span class="spinner htmx-indicator"></span></div>
    </div>
    <div class="metrics">${metric("Spend", formatCost(p.spend))}${metric("Tokens", formatTokens(p.tokens))}${metric("Sessions", String(p.sessions))}</div>
  </article>`
}

export function renderProjects(projects: ProjectView[], now: number): string {
  if (projects.length === 0) return `<p class="empty">No projects yet. Use “New project” to create one.</p>`
  return projects.map((p) => renderProjectCard(p, now)).join("")
}

export interface StatsView {
  total: number
  ready: number
  degraded: number
  provisioning: number
  cost: number
  tokens: number
  uptimeMs: number
}

export function renderStats(s: StatsView): string {
  return `<div class="stat"><div class="k">Projects</div><div class="v">${s.total}</div><div class="d">${s.ready} ready · ${s.degraded} degraded · ${s.provisioning} starting</div></div>
  <div class="stat"><div class="k">Spend</div><div class="v">${formatCost(s.cost)}</div><div class="d">cumulative</div></div>
  <div class="stat"><div class="k">Tokens</div><div class="v">${formatTokens(s.tokens)}</div><div class="d">cumulative</div></div>
  <div class="stat"><div class="k">Uptime</div><div class="v">${formatUptime(s.uptimeMs)}</div><div class="d">since console start</div></div>`
}

export function renderUsage(totals: UsageTotals): string {
  const sum = totals.tokensIn + totals.tokensOut
  const promptPct = sum > 0 ? Math.round((totals.tokensIn / sum) * 100) : 0
  const completionPct = sum > 0 ? 100 - promptPct : 0
  return `<div class="usage">
    <div class="u"><div class="k">Total spend</div><div class="v">${formatCost(totals.cost)}</div></div>
    <div class="u"><div class="k">Total tokens</div><div class="v">${formatTokens(sum)}</div></div>
  </div>
  <div class="barrow"><div class="lab"><span>prompt</span><span>${formatTokens(totals.tokensIn)}</span></div><div class="bar"><i style="width:${promptPct}%"></i></div></div>
  <div class="barrow"><div class="lab"><span>completion</span><span>${formatTokens(totals.tokensOut)}</span></div><div class="bar"><i class="b" style="width:${completionPct}%"></i></div></div>
  <div class="barrow"><div class="lab"><span>cache read / write</span><span>${formatTokens(totals.cacheRead)} / ${formatTokens(totals.cacheWrite)}</span></div></div>`
}

export interface AuditView {
  time: string
  kind: string
  detail: string
  decision: string
}

function auditClass(kind: string): string {
  if (kind === "permission") return "warn"
  if (kind === "question") return "info"
  if (kind === "shell") return "err"
  return ""
}

export function renderAudit(entries: AuditView[]): string {
  if (entries.length === 0) return `<p class="empty">No audit entries yet.</p>`
  return entries.map((e) => {
    const cls = auditClass(e.kind)
    return `<div class="tl ${cls}"><span class="ic"></span><div><div class="txt">${escapeHtml(e.detail)}</div><div class="time">${escapeHtml(e.time)} · ${escapeHtml(e.kind)} · ${escapeHtml(e.decision)}</div></div></div>`
  }).join("")
}
