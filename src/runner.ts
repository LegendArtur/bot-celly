import type { OpencodeClient } from "./opencode.ts"
import type { NormalizedEvent } from "./events.ts"
import type { Renderer } from "./render.ts"
import type { Db } from "./db.ts"

const DEFAULT_DENY = ["git push*", "git clean -fdx*", "npm publish*", "pnpm publish*", "yarn publish*"]
const ALLOWED_TOOLS = new Set(["bash", "edit", "write", "read", "glob", "grep", "webfetch", "websearch", "task", "skill", "lsp", "doom_loop"])

export function evaluatePermission(req: { tool: string; patterns: string[] }, deny: string[] = DEFAULT_DENY): "once" | "always" | "reject" {
  if (!ALLOWED_TOOLS.has(req.tool)) return "reject"
  const matches = (pattern: string, value: string) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    return new RegExp(`^${escaped}$`).test(value)
  }
  for (const p of req.patterns) if (deny.some((d) => matches(d, p))) return "reject"
  return "once"
}

function partToEvent(sessionId: string, messageId: string, part: any): NormalizedEvent | null {
  if (!part || typeof part !== "object") return null
  if (part.type === "text") return { kind: "text", sessionId, messageId, partId: part.id, text: part.text ?? "" }
  if (part.type === "tool") return { kind: "tool", sessionId, messageId, partId: part.id, name: part.tool ?? "tool", status: part.state?.status ?? "unknown" }
  return null
}

export class Runner {
  private queue = new Map<string, { text: string; actor: string }[]>()
  private active = new Set<string>()
  private abortTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private renderers = new Map<string, Promise<Renderer>>()
  constructor(private readonly deps: {
    db: Db; clientFor(threadId: string): OpencodeClient
    createRenderer(threadId: string): Promise<Renderer>
    sessionFor(threadId: string): Promise<string>
    log(msg: string, fields?: Record<string, unknown>): void
    maxQueue: number; maxConcurrentRuns: number
    onThreadIdle?(threadId: string): void
  }) {}
  get activeCount() { return this.active.size }
  private rendererFor(threadId: string): Promise<Renderer> {
    let renderer = this.renderers.get(threadId)
    if (!renderer) {
      renderer = this.deps.createRenderer(threadId)
      this.renderers.set(threadId, renderer)
      renderer.catch(() => { if (this.renderers.get(threadId) === renderer) this.renderers.delete(threadId) })
    }
    return renderer
  }
  private clearRenderer(threadId: string): void { this.renderers.delete(threadId) }
  private idle(threadId: string): void {
    this.deps.db.threads.setRenderState(threadId, "idle")
    this.active.delete(threadId)
    this.clearRenderer(threadId)
    this.deps.onThreadIdle?.(threadId)
  }
  private clearAbortTimer(threadId: string): void {
    const timer = this.abortTimers.get(threadId)
    if (timer !== undefined) { clearTimeout(timer); this.abortTimers.delete(threadId) }
  }
  private async drain(threadId: string): Promise<void> {
    const next = this.queue.get(threadId)?.shift()
    if (!next) return
    try {
      const result = await this.prompt(threadId, next.text, next.actor)
      if (result === "busy") {
        const q = this.queue.get(threadId) ?? []
        q.unshift(next); this.queue.set(threadId, q)
        this.deps.log("queued message deferred", { threadId, reason: result })
      }
    } catch (e) {
      const q = this.queue.get(threadId) ?? []
      q.unshift(next); this.queue.set(threadId, q)
      this.deps.log("queued message deferred", { threadId, reason: String(e) })
    }
  }
  private async forceIdle(threadId: string): Promise<void> {
    this.abortTimers.delete(threadId)
    if (this.deps.db.threads.get(threadId)?.renderState !== "aborting") return
    try { const r = await this.rendererFor(threadId); await r.finalize() } catch {}
    this.queue.set(threadId, [])
    this.idle(threadId)
  }
  async prompt(threadId: string, text: string, actor: string): Promise<string | undefined> {
    const db = this.deps.db
    if (this.active.has(threadId)) {
      const q = this.queue.get(threadId) ?? []
      if (q.length >= this.deps.maxQueue) return "queue full"
      q.push({ text, actor }); this.queue.set(threadId, q)
      return `queued (${q.length})`
    }
    if (this.active.size >= this.deps.maxConcurrentRuns) return "busy"
    this.active.add(threadId)
    db.threads.setRenderState(threadId, "running"); db.threads.touch(threadId)
    try {
      const sessionId = await this.deps.sessionFor(threadId)
      const client = this.deps.clientFor(threadId)
      const body: Record<string, unknown> = { parts: [{ type: "text", text }] }
      const thread = db.threads.get(threadId)
      if (thread?.model) {
        const slash = thread.model.indexOf("/")
        if (slash > 0) body.model = { providerID: thread.model.slice(0, slash), modelID: thread.model.slice(slash + 1) }
      }
      if (thread?.agent) body.agent = thread.agent
      await client.session.promptAsync({ path: { id: sessionId }, body } as any)
      return undefined
    } catch (e) {
      this.active.delete(threadId)
      throw e
    }
  }
  async onEvent(threadId: string, e: NormalizedEvent): Promise<void> {
    const db = this.deps.db
    if (e.kind === "text" || e.kind === "tool") { const r = await this.rendererFor(threadId); r.push(e); await r.tick() }
    else if (e.kind === "permission") {
      const client = this.deps.clientFor(threadId)
      const response = evaluatePermission({ tool: e.tool, patterns: e.patterns })
      await client.postSessionIdPermissionsPermissionId({ path: { id: (await this.deps.sessionFor(threadId)), permissionID: e.permissionId }, body: { response } } as any)
    } else if (e.kind === "error") {
      const r = await this.rendererFor(threadId); r.push({ kind: "text", sessionId: e.sessionId, messageId: "", partId: `err-${e.sessionId}`, text: `[error] ${e.message}` })
      await r.finalize(); this.idle(threadId)
      await this.drain(threadId)
    } else if (e.kind === "idle") {
      const r = await this.rendererFor(threadId); await r.finalize()
      this.clearAbortTimer(threadId)
      const aborting = db.threads.get(threadId)?.renderState === "aborting"
      this.idle(threadId)
      if (aborting) this.queue.set(threadId, [])
      else await this.drain(threadId)
    }
  }
  async abort(threadId: string): Promise<void> {
    if (!this.active.has(threadId)) return
    const client = this.deps.clientFor(threadId)
    const sessionId = await this.deps.sessionFor(threadId)
    this.deps.db.threads.setRenderState(threadId, "aborting")
    await client.session.abort({ path: { id: sessionId } } as any)
    this.queue.set(threadId, [])
    this.clearAbortTimer(threadId)
    const timer = setTimeout(() => { void this.forceIdle(threadId) }, 10_000)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    this.abortTimers.set(threadId, timer)
  }
  async recover(thread: { threadId: string; sessionId: string }): Promise<void> {
    const client = this.deps.clientFor(thread.threadId)
    const messages = await client.session.messages({ path: { id: thread.sessionId } } as any)
    const list = (messages?.data ?? []) as any[]
    this.deps.log("recovered thread", { threadId: thread.threadId, messages: list.length })
    let last: any
    for (const m of list) if (m?.info?.role === "assistant") last = m
    const renderer = await this.rendererFor(thread.threadId)
    if (last) {
      const messageId = last.info?.id ?? ""
      for (const part of last.parts ?? []) {
        const ev = partToEvent(thread.sessionId, messageId, part)
        if (ev) renderer.push(ev)
      }
    }
    await renderer.finalize()
    this.clearAbortTimer(thread.threadId)
    if (this.active.has(thread.threadId)) this.clearRenderer(thread.threadId)
    else this.idle(thread.threadId)
  }
  async handleProjectDown(channelId: string): Promise<void> {
    const threads = this.deps.db.threads.byChannel(channelId)
    for (const thread of threads) {
      if (!this.active.has(thread.threadId)) continue
      this.clearAbortTimer(thread.threadId)
      try {
        const renderer = await this.rendererFor(thread.threadId)
        renderer.push({ kind: "text", sessionId: thread.sessionId, messageId: "", partId: `down-${thread.threadId}`, text: "[project server stopped]" })
        await renderer.finalize()
      } catch {}
      this.idle(thread.threadId)
    }
    for (const thread of threads) this.queue.delete(thread.threadId)
  }
}
