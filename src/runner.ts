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

export class Runner {
  private queue = new Map<string, { text: string; actor: string }[]>()
  private active = new Set<string>()
  constructor(private readonly deps: {
    db: Db; clientFor(threadId: string): OpencodeClient
    rendererFor(threadId: string): Promise<Renderer>
    sessionFor(threadId: string): Promise<string>
    log(msg: string, fields?: Record<string, unknown>): void
    maxQueue: number; maxConcurrentRuns: number
  }) {}
  get activeCount() { return this.active.size }
  async prompt(threadId: string, text: string, actor: string): Promise<string | undefined> {
    const db = this.deps.db
    if (this.active.has(threadId)) {
      const q = this.queue.get(threadId) ?? []
      if (q.length >= this.deps.maxQueue) return "queue full"
      q.push({ text, actor }); this.queue.set(threadId, q)
      return `queued (${q.length})`
    }
    if (this.active.size >= this.deps.maxConcurrentRuns) return "busy"
    const sessionId = await this.deps.sessionFor(threadId)
    this.active.add(threadId); db.threads.setRenderState(threadId, "running"); db.threads.touch(threadId)
    const client = this.deps.clientFor(threadId)
    await client.session.promptAsync({ path: { id: sessionId }, body: { parts: [{ type: "text", text }] } } as any)
    return undefined
  }
  async onEvent(threadId: string, e: NormalizedEvent): Promise<void> {
    const db = this.deps.db
    if (e.kind === "text" || e.kind === "tool") { const r = await this.deps.rendererFor(threadId); r.push(e); await r.tick() }
    else if (e.kind === "permission") {
      const client = this.deps.clientFor(threadId)
      const response = evaluatePermission({ tool: e.tool, patterns: e.patterns })
      await client.postSessionIdPermissionsPermissionId({ path: { id: (await this.deps.sessionFor(threadId)), permissionID: e.permissionId }, body: { response } } as any)
    } else if (e.kind === "error") {
      const r = await this.deps.rendererFor(threadId); r.push({ kind: "text", sessionId: e.sessionId, messageId: "", partId: `err-${e.sessionId}`, text: `[error] ${e.message}` })
      await r.finalize(); db.threads.setRenderState(threadId, "errored"); this.active.delete(threadId)
    } else if (e.kind === "idle") {
      const r = await this.deps.rendererFor(threadId); await r.finalize()
      db.threads.setRenderState(threadId, "idle"); this.active.delete(threadId)
      const next = this.queue.get(threadId)?.shift()
      if (next) await this.prompt(threadId, next.text, next.actor)
    }
  }
  async abort(threadId: string): Promise<void> {
    const client = this.deps.clientFor(threadId)
    const sessionId = await this.deps.sessionFor(threadId)
    this.deps.db.threads.setRenderState(threadId, "aborting")
    await client.session.abort({ path: { id: sessionId } } as any)
    this.queue.set(threadId, [])
    setTimeout(() => { if (this.deps.db.threads.get(threadId)?.renderState === "aborting") { this.deps.db.threads.setRenderState(threadId, "idle"); this.active.delete(threadId) } }, 10_000)
  }
  async recover(thread: { threadId: string; sessionId: string }): Promise<void> {
    const client = this.deps.clientFor(thread.threadId)
    const messages = await client.session.messages({ path: { id: thread.sessionId } } as any)
    this.deps.log("recovered thread", { threadId: thread.threadId, messages: messages?.data?.length ?? 0 })
    this.deps.db.threads.setRenderState(thread.threadId, "idle")
  }
}
