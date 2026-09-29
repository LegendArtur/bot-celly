import type { OpencodeClient } from "./opencode.ts"
import type { ApprovalMode } from "./mode.ts"
import { partToEvent } from "./events.js"
import type { NormalizedEvent } from "./events.ts"
import type { Renderer } from "./render.ts"
import type { Db } from "./db.ts"
import type { Thread } from "./types.ts"
import type { ApprovalManager } from "./approvals.ts"
import type { AuditDraft } from "./audit.ts"
import { formatCost, formatDuration, formatUsageFooter, resolveBudget } from "./usage.js"
import { decidePermission, type PermissionReplyInput } from "./policy.js"
import { unrefTimer } from "./helpers.js"

const ABORT_TIMEOUT_MS = 10_000

export function withDirectory<T extends object>(directory: string | null | undefined, options: T): T & { query?: { directory: string } } {
  if (!directory) return options
  return { ...options, query: { directory } }
}

/**
 * The prompt that produced the recovered assistant message is the nearest
 * preceding user message with text. Later user messages (a prompt sent just
 * before a crash, with no assistant part yet) must not be quoted for an
 * earlier assistant message.
 */
function lastUserText(messages: any[], assistant: any): string | undefined {
  const before: any[] = []
  for (const message of messages) {
    if (message === assistant) break
    if (message?.info?.role === "user") before.push(message)
  }
  for (let i = before.length - 1; i >= 0; i--) {
    const text = (before[i]!.parts ?? [])
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return undefined
}

export interface RunnerDeps {
  db: Db
  clientFor(threadId: string): OpencodeClient
  createRenderer(threadId: string, liveMessageId?: string | null, liveMessageIds?: string[] | null, prompt?: string | null): Promise<Renderer>
  sessionFor(threadId: string): Promise<string>
  directoryFor?(threadId: string): string | undefined
  log(msg: string, fields?: Record<string, unknown>): void
  maxQueue: number
  maxConcurrentRuns: number
  budgetUsd?: number
  notify?(channelId: string, text: string): Promise<void> | void
  onThreadIdle?(threadId: string): void
  approvalModeFor?(channelId: string): ApprovalMode
  respondPermission?(input: PermissionReplyInput): Promise<void>
  approvals?: Pick<ApprovalManager, "requestPermission" | "askQuestion" | "cancel" | "cancelThread">
  audit?(entry: AuditDraft): void
}

export interface QueuedPrompt {
  text: string
  actor: string
  createdAt: number
}

export class Runner {
  private queue = new Map<string, QueuedPrompt[]>()
  private active = new Set<string>()
  private epochs = new Map<string, number>()
  private owner = new Map<string, number>()
  private abortTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private renderers = new Map<string, Promise<Renderer>>()
  private prompts = new Map<string, string>()
  constructor(private readonly deps: RunnerDeps) {}

  get activeCount() { return this.active.size }
  isActive(threadId: string): boolean { return this.active.has(threadId) }
  activeThreadsFor(channelId: string): string[] {
    return this.deps.db.threads.byChannel(channelId).map((t) => t.threadId).filter((id) => this.active.has(id))
  }
  queuedFor(threadId: string): QueuedPrompt[] {
    return (this.queue.get(threadId) ?? []).map((entry) => ({ ...entry }))
  }
  removeQueued(threadId: string, index: number): boolean {
    const q = this.queue.get(threadId)
    if (!q || !Number.isInteger(index) || index < 0 || index >= q.length) return false
    q.splice(index, 1)
    if (q.length === 0) this.queue.delete(threadId)
    return true
  }
  clearQueued(threadId: string): number {
    const q = this.queue.get(threadId)
    const count = q?.length ?? 0
    this.queue.delete(threadId)
    return count
  }

  private nextEpoch(threadId: string): number {
    const epoch = (this.epochs.get(threadId) ?? 0) + 1
    this.epochs.set(threadId, epoch)
    return epoch
  }
  private ownsEpoch(threadId: string, epoch: number | undefined): boolean {
    return this.owner.get(threadId) === epoch
  }
  private rendererFor(threadId: string, liveMessageId?: string | null, liveMessageIds?: string[] | null, promptOverride?: string | null): Promise<Renderer> {
    let renderer = this.renderers.get(threadId)
    if (!renderer) {
      renderer = this.deps.createRenderer(threadId, liveMessageId, liveMessageIds, promptOverride ?? this.prompts.get(threadId))
      this.renderers.set(threadId, renderer)
      renderer.catch(() => { if (this.renderers.get(threadId) === renderer) this.renderers.delete(threadId) })
    }
    return renderer
  }
  private clearRenderer(threadId: string): void { this.renderers.delete(threadId) }
  private budgetFor(threadId: string): number {
    const thread = this.deps.db.threads.get(threadId)
    if (!thread) return this.deps.budgetUsd ?? 0
    return resolveBudget(this.deps.db.settings, thread.channelId, this.deps.budgetUsd ?? 0)
  }
  private idle(threadId: string, epoch: number | undefined): boolean {
    this.deps.approvals?.cancelThread(threadId)
    if (!this.ownsEpoch(threadId, epoch)) return false
    this.deps.db.threads.setRenderState(threadId, "idle")
    this.active.delete(threadId)
    this.owner.delete(threadId)
    this.prompts.delete(threadId)
    this.clearRenderer(threadId)
    this.deps.onThreadIdle?.(threadId)
    this.kickGlobalDrain()
    return true
  }
  private clearAbortTimer(threadId: string): void {
    const timer = this.abortTimers.get(threadId)
    if (timer !== undefined) { clearTimeout(timer); this.abortTimers.delete(threadId) }
  }
  private async respondToPermission(
    threadId: string,
    e: { sessionId: string; permissionId: string; source: "v1" | "v2"; tool: string; patterns: string[] },
    reply: "once" | "always" | "reject",
  ): Promise<void> {
    this.deps.audit?.({ kind: "permission", threadId, actorId: "policy", detail: `${e.tool} ${e.patterns.join(" ")}`.trim(), decision: reply })
    if (this.deps.respondPermission) {
      await this.deps.respondPermission({ source: e.source, threadId, sessionId: e.sessionId, requestId: e.permissionId, reply })
      return
    }
    const client = this.deps.clientFor(threadId)
    await client.postSessionIdPermissionsPermissionId({ path: { id: e.sessionId, permissionID: e.permissionId }, body: { response: reply } } as any)
  }
  private requeue(threadId: string, next: QueuedPrompt): void {
    const q = this.queue.get(threadId) ?? []
    q.unshift(next); this.queue.set(threadId, q)
  }
  private enqueue(threadId: string, next: { text: string; actor: string }): string {
    const q = this.queue.get(threadId) ?? []
    if (q.length >= this.deps.maxQueue) return "queue full"
    q.push({ text: next.text, actor: next.actor, createdAt: Date.now() }); this.queue.set(threadId, q)
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
    const projectThread = db.threads.get(threadId)
    if (projectThread) db.projects.touch(projectThread.channelId, Date.now())
    if (this.active.has(threadId)) return this.enqueue(threadId, { text, actor })
    if (this.active.size >= this.deps.maxConcurrentRuns) return this.enqueue(threadId, { text, actor })
    const epoch = this.nextEpoch(threadId)
    this.active.add(threadId)
    this.owner.set(threadId, epoch)
    this.prompts.set(threadId, text)
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
      if (thread?.variant && thread.variant !== "default") body.variant = thread.variant
      await client.session.promptAsync(withDirectory(this.deps.directoryFor?.(threadId), { path: { id: sessionId }, body }) as any)
      return undefined
    } catch (e) {
      if (this.ownsEpoch(threadId, epoch)) {
        this.active.delete(threadId)
        this.owner.delete(threadId)
        this.prompts.delete(threadId)
        this.clearRenderer(threadId)
        try { db.threads.setRenderState(threadId, "idle") } catch {}
        this.deps.onThreadIdle?.(threadId)
        this.kickGlobalDrain()
      }
      throw e
    }
  }
  async onEvent(threadId: string, e: NormalizedEvent): Promise<void> {
    const db = this.deps.db
    const epoch = this.owner.get(threadId)
    if (e.kind === "text" || e.kind === "tool") { const r = await this.rendererFor(threadId); r.push(e); await r.tick() }
    else if (e.kind === "usage") {
      db.threads.addUsage(threadId, { cost: e.cost, tokensIn: e.tokensIn, tokensOut: e.tokensOut, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite })
      const totals = db.usage.thread(threadId)
      const renderer = await this.rendererFor(threadId)
      renderer.setFooter(`${formatUsageFooter(totals)} · ${formatDuration(renderer.elapsedMs())}`)
      await renderer.tick()
      const budget = this.budgetFor(threadId)
      if (budget > 0 && totals.cost >= budget && db.threads.get(threadId)?.renderState !== "aborting") {
        const note = `session budget reached (${formatCost(totals.cost)} of ${formatCost(budget)})`
        renderer.push({ kind: "notice", sessionId: e.sessionId, partId: `budget-${e.sessionId}`, text: note, tone: "warn" })
        await renderer.finalize()
        const thread = db.threads.get(threadId)
        if (thread) await this.deps.notify?.(thread.channelId, `[budget] ${note}`)
        await this.abort(threadId)
      }
    }
    else if (e.kind === "permission") {
      const thread = db.threads.get(threadId)
      const mode = this.deps.approvalModeFor?.(thread?.channelId ?? threadId) ?? "auto"
      const decision = decidePermission(mode, { tool: e.tool, patterns: e.patterns })
      if (decision === "ask") {
        if (this.deps.approvals) {
          await this.deps.approvals.requestPermission({
            threadId, sessionId: e.sessionId, requestId: e.permissionId, source: e.source,
            tool: e.tool, patterns: e.patterns, exact: e.patterns.length === 1,
          })
        } else {
          await this.respondToPermission(threadId, e, "reject")
        }
      } else {
        await this.respondToPermission(threadId, e, decision)
      }
    } else if (e.kind === "permission-replied") {
      this.deps.approvals?.cancel(e.sessionId, e.requestId)
    } else if (e.kind === "question-replied" || e.kind === "question-rejected") {
      this.deps.approvals?.cancel(e.sessionId, e.requestId)
    } else if (e.kind === "question") {
      try {
        await this.deps.approvals?.askQuestion({ threadId, sessionId: e.sessionId, requestId: e.requestId, source: e.source, questions: e.questions })
      } catch (err) {
        this.deps.log("question handling failed", { threadId, requestId: e.requestId, error: String(err) })
      }
    } else if (e.kind === "error") {
      try {
        const r = await this.rendererFor(threadId)
        r.push({ kind: "notice", sessionId: e.sessionId, partId: `err-${e.sessionId}`, text: e.message, tone: "error" })
        await r.finalize()
      } catch (err) {
        this.deps.log("error render finalize failed", { threadId, error: String(err) })
      }
      if (this.idle(threadId, epoch)) await this.drain(threadId)
    } else if (e.kind === "idle") {
      try {
        const r = await this.rendererFor(threadId)
        await r.finalize()
      } catch (err) {
        this.deps.log("idle render finalize failed", { threadId, error: String(err) })
      }
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
    unrefTimer(timer)
    this.abortTimers.set(threadId, timer)
    try {
      await client.session.abort(withDirectory(this.deps.directoryFor?.(threadId), { path: { id: sessionId } }) as any)
    } catch (e) {
      this.deps.log("session abort failed", { threadId, error: String(e) })
    }
    if (this.ownsEpoch(threadId, epoch)) this.queue.set(threadId, [])
  }
  async recover(thread: { threadId: string; sessionId: string }): Promise<void> {
    const db = this.deps.db
    const client = this.deps.clientFor(thread.threadId)
    const messages = await client.session.messages(withDirectory(this.deps.directoryFor?.(thread.threadId), { path: { id: thread.sessionId } }) as any)
    const list = (messages?.data ?? []) as any[]
    this.deps.log("recovered thread", { threadId: thread.threadId, messages: list.length })
    let last: any
    for (const m of list) if (m?.info?.role === "assistant") last = m
    const epoch = this.owner.get(thread.threadId)
    const liveMessageId = db.threads.get(thread.threadId)?.liveMessageId ?? null
    const liveMessageIds = db.threads.liveMessageIds(thread.threadId)
    const renderer = await this.rendererFor(thread.threadId, liveMessageId, liveMessageIds, lastUserText(list, last))
    if (last) {
      const messageId = last.info?.id ?? ""
      for (const part of last.parts ?? []) {
        const ev = partToEvent(thread.sessionId, messageId, part)
        if (ev) renderer.push(ev)
      }
    }
    try { await renderer.finalize() } catch (err) { this.deps.log("recover finalize failed", { threadId: thread.threadId, error: String(err) }) }
    if (this.active.has(thread.threadId)) return
    this.clearAbortTimer(thread.threadId)
    this.idle(thread.threadId, epoch)
  }
  private async finalizeThread(thread: Thread, note?: { partId: string; text: string; tone: "info" | "warn" | "error" }): Promise<void> {
    const epoch = this.owner.get(thread.threadId)
    try {
      const renderer = await this.rendererFor(thread.threadId)
      if (note) renderer.push({ kind: "notice", sessionId: thread.sessionId, partId: note.partId, text: note.text, tone: note.tone })
      await renderer.finalize()
    } catch {}
    this.idle(thread.threadId, epoch)
  }
  private resetThread(thread: Thread): void {
    this.clearRenderer(thread.threadId)
    try { this.deps.db.threads.setRenderState(thread.threadId, "idle") } catch {}
  }
  private clearChannelState(channelId: string): Thread[] {
    const threads = this.deps.db.threads.byChannel(channelId)
    for (const thread of threads) { this.queue.delete(thread.threadId); this.clearAbortTimer(thread.threadId) }
    return threads
  }
  async handleProjectDown(channelId: string): Promise<void> {
    const threads = this.clearChannelState(channelId)
    for (const thread of threads) {
      if (!this.active.has(thread.threadId)) continue
      await this.finalizeThread(thread, { partId: `down-${thread.threadId}`, text: "project server stopped", tone: "warn" })
    }
  }
  async resetChannel(channelId: string, opts: { notify?: boolean } = {}): Promise<void> {
    const threads = this.clearChannelState(channelId)
    for (const thread of threads) {
      if (!this.active.has(thread.threadId)) { this.resetThread(thread); continue }
      await this.finalizeThread(thread, opts.notify ? { partId: `stop-${thread.threadId}`, text: "project stopped", tone: "warn" } : undefined)
    }
  }
}
