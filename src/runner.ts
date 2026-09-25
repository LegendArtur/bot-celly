import type { OpencodeClient } from "./opencode.ts"
import type { NormalizedEvent } from "./events.ts"
import type { Renderer } from "./render.ts"
import type { Db } from "./db.ts"

const DEFAULT_DENY = ["git push*", "git clean -fdx*", "npm publish*", "pnpm publish*", "yarn publish*"]
const ALLOWED_TOOLS = new Set(["bash", "edit", "write", "read", "glob", "grep", "webfetch", "websearch", "task", "skill", "lsp", "doom_loop"])
const ABORT_TIMEOUT_MS = 10_000

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

export interface RunnerDeps {
  db: Db
  clientFor(threadId: string): OpencodeClient
  createRenderer(threadId: string, liveMessageId?: string | null): Promise<Renderer>
  sessionFor(threadId: string): Promise<string>
  log(msg: string, fields?: Record<string, unknown>): void
  maxQueue: number
  maxConcurrentRuns: number
  onThreadIdle?(threadId: string): void
}

export class Runner {
  private queue = new Map<string, { text: string; actor: string }[]>()
  private active = new Set<string>()
  private epochs = new Map<string, number>()
  private owner = new Map<string, number>()
  private abortTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private renderers = new Map<string, Promise<Renderer>>()
  constructor(private readonly deps: RunnerDeps) {}

  get activeCount() { return this.active.size }
  isActive(threadId: string): boolean { return this.active.has(threadId) }
  activeThreadsFor(channelId: string): string[] {
    return this.deps.db.threads.byChannel(channelId).map((t) => t.threadId).filter((id) => this.active.has(id))
  }

  private nextEpoch(threadId: string): number {
    const epoch = (this.epochs.get(threadId) ?? 0) + 1
    this.epochs.set(threadId, epoch)
    return epoch
  }
  private ownsEpoch(threadId: string, epoch: number | undefined): boolean {
    return this.owner.get(threadId) === epoch
  }
  private rendererFor(threadId: string, liveMessageId?: string | null): Promise<Renderer> {
    let renderer = this.renderers.get(threadId)
    if (!renderer) {
      renderer = this.deps.createRenderer(threadId, liveMessageId)
      this.renderers.set(threadId, renderer)
      renderer.catch(() => { if (this.renderers.get(threadId) === renderer) this.renderers.delete(threadId) })
    }
    return renderer
  }
  private clearRenderer(threadId: string): void { this.renderers.delete(threadId) }
  private idle(threadId: string, epoch: number | undefined): boolean {
    if (!this.ownsEpoch(threadId, epoch)) return false
    this.deps.db.threads.setRenderState(threadId, "idle")
    this.active.delete(threadId)
    this.owner.delete(threadId)
    this.clearRenderer(threadId)
    this.deps.onThreadIdle?.(threadId)
    this.kickGlobalDrain()
    return true
  }
  private clearAbortTimer(threadId: string): void {
    const timer = this.abortTimers.get(threadId)
    if (timer !== undefined) { clearTimeout(timer); this.abortTimers.delete(threadId) }
  }
  private requeue(threadId: string, next: { text: string; actor: string }): void {
    const q = this.queue.get(threadId) ?? []
    q.unshift(next); this.queue.set(threadId, q)
  }
  private enqueue(threadId: string, next: { text: string; actor: string }): string {
    const q = this.queue.get(threadId) ?? []
    if (q.length >= this.deps.maxQueue) return "queue full"
    q.push(next); this.queue.set(threadId, q)
    return `queued (${q.length})`
  }
  private kickGlobalDrain(): void {
    for (const threadId of [...this.queue.keys()]) {
      if ((this.queue.get(threadId)?.length ?? 0) > 0) void this.drain(threadId)
    }
  }
  private async drain(threadId: string): Promise<void> {
    if (this.active.has(threadId)) return
    if (this.active.size >= this.deps.maxConcurrentRuns) return
    const q = this.queue.get(threadId)
    if (!q || q.length === 0) return
    const next = q.shift()!
    if (q.length === 0) this.queue.delete(threadId)
    try {
      const result = await this.prompt(threadId, next.text, next.actor)
      if (result !== undefined) {
        this.requeue(threadId, next)
        this.deps.log("queued message deferred", { threadId, reason: result })
      }
    } catch (e) {
      this.requeue(threadId, next)
      this.deps.log("queued message deferred", { threadId, reason: String(e) })
    }
  }
  private async forceIdle(threadId: string, epoch: number): Promise<void> {
    if (!this.ownsEpoch(threadId, epoch)) return
    this.abortTimers.delete(threadId)
    if (this.deps.db.threads.get(threadId)?.renderState !== "aborting") return
    try { const r = await this.rendererFor(threadId); await r.finalize() } catch {}
    if (!this.ownsEpoch(threadId, epoch)) return
    this.queue.set(threadId, [])
    this.idle(threadId, epoch)
  }
  async prompt(threadId: string, text: string, actor: string): Promise<string | undefined> {
    const db = this.deps.db
    if (this.active.has(threadId)) return this.enqueue(threadId, { text, actor })
    if (this.active.size >= this.deps.maxConcurrentRuns) return this.enqueue(threadId, { text, actor })
    const epoch = this.nextEpoch(threadId)
    this.active.add(threadId)
    this.owner.set(threadId, epoch)
    try {
      db.threads.setRenderState(threadId, "running"); db.threads.touch(threadId)
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
      if (this.ownsEpoch(threadId, epoch)) {
        this.active.delete(threadId)
        this.owner.delete(threadId)
        this.clearRenderer(threadId)
        try { db.threads.setRenderState(threadId, "idle") } catch {}
      }
      throw e
    }
  }
  async onEvent(threadId: string, e: NormalizedEvent): Promise<void> {
    const db = this.deps.db
    const epoch = this.owner.get(threadId)
    if (e.kind === "text" || e.kind === "tool") { const r = await this.rendererFor(threadId); r.push(e); await r.tick() }
    else if (e.kind === "permission") {
      const client = this.deps.clientFor(threadId)
      const response = evaluatePermission({ tool: e.tool, patterns: e.patterns })
      await client.postSessionIdPermissionsPermissionId({ path: { id: (await this.deps.sessionFor(threadId)), permissionID: e.permissionId }, body: { response } } as any)
    } else if (e.kind === "error") {
      const r = await this.rendererFor(threadId); r.push({ kind: "text", sessionId: e.sessionId, messageId: "", partId: `err-${e.sessionId}`, text: `[error] ${e.message}` })
      await r.finalize()
      if (this.idle(threadId, epoch)) await this.drain(threadId)
    } else if (e.kind === "idle") {
      const r = await this.rendererFor(threadId); await r.finalize()
      this.clearAbortTimer(threadId)
      const aborting = db.threads.get(threadId)?.renderState === "aborting"
      const owned = this.idle(threadId, epoch)
      if (aborting) this.queue.set(threadId, [])
      else if (owned) await this.drain(threadId)
    }
  }
  async abort(threadId: string): Promise<void> {
    if (!this.active.has(threadId)) return
    const epoch = this.owner.get(threadId)
    if (epoch === undefined) return
    const client = this.deps.clientFor(threadId)
    let sessionId: string
    try { sessionId = await this.deps.sessionFor(threadId) } catch (e) {
      this.deps.log("abort session lookup failed", { threadId, error: String(e) })
      return
    }
    if (!this.ownsEpoch(threadId, epoch)) return
    this.deps.db.threads.setRenderState(threadId, "aborting")
    this.clearAbortTimer(threadId)
    const timer = setTimeout(() => { void this.forceIdle(threadId, epoch) }, ABORT_TIMEOUT_MS)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    this.abortTimers.set(threadId, timer)
    try {
      await client.session.abort({ path: { id: sessionId } } as any)
    } catch (e) {
      this.deps.log("session abort failed", { threadId, error: String(e) })
    }
    if (this.ownsEpoch(threadId, epoch)) this.queue.set(threadId, [])
  }
  async recover(thread: { threadId: string; sessionId: string }): Promise<void> {
    const db = this.deps.db
    const client = this.deps.clientFor(thread.threadId)
    const messages = await client.session.messages({ path: { id: thread.sessionId } } as any)
    const list = (messages?.data ?? []) as any[]
    this.deps.log("recovered thread", { threadId: thread.threadId, messages: list.length })
    let last: any
    for (const m of list) if (m?.info?.role === "assistant") last = m
    const epoch = this.owner.get(thread.threadId)
    const liveMessageId = db.threads.get(thread.threadId)?.liveMessageId ?? null
    const renderer = await this.rendererFor(thread.threadId, liveMessageId)
    if (last) {
      const messageId = last.info?.id ?? ""
      for (const part of last.parts ?? []) {
        const ev = partToEvent(thread.sessionId, messageId, part)
        if (ev) renderer.push(ev)
      }
    }
    await renderer.finalize()
    this.clearAbortTimer(thread.threadId)
    if (this.active.has(thread.threadId)) return
    this.idle(thread.threadId, epoch)
  }
  async handleProjectDown(channelId: string): Promise<void> {
    const threads = this.deps.db.threads.byChannel(channelId)
    for (const thread of threads) { this.queue.delete(thread.threadId); this.clearAbortTimer(thread.threadId) }
    for (const thread of threads) {
      if (!this.active.has(thread.threadId)) continue
      const epoch = this.owner.get(thread.threadId)
      try {
        const renderer = await this.rendererFor(thread.threadId)
        renderer.push({ kind: "text", sessionId: thread.sessionId, messageId: "", partId: `down-${thread.threadId}`, text: "[project server stopped]" })
        await renderer.finalize()
      } catch {}
      this.idle(thread.threadId, epoch)
    }
  }
  async resetChannel(channelId: string, opts: { notify?: boolean } = {}): Promise<void> {
    const threads = this.deps.db.threads.byChannel(channelId)
    for (const thread of threads) { this.queue.delete(thread.threadId); this.clearAbortTimer(thread.threadId) }
    for (const thread of threads) {
      const epoch = this.owner.get(thread.threadId)
      if (this.active.has(thread.threadId)) {
        try {
          const renderer = await this.rendererFor(thread.threadId)
          if (opts.notify) renderer.push({ kind: "text", sessionId: thread.sessionId, messageId: "", partId: `stop-${thread.threadId}`, text: "[project stopped]" })
          await renderer.finalize()
        } catch {}
        this.idle(thread.threadId, epoch)
      } else {
        this.clearRenderer(thread.threadId)
        try { this.deps.db.threads.setRenderState(thread.threadId, "idle") } catch {}
      }
    }
  }
}
