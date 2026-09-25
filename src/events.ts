export type NormalizedEvent =
  | { kind: "text"; sessionId: string; messageId: string; partId: string; text: string }
  | { kind: "tool"; sessionId: string; messageId: string; partId: string; name: string; status: string }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId: string; message: string }
  | { kind: "permission"; sessionId: string; permissionId: string; tool: string; patterns: string[] }

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof e.message === "string") return e.message
    if (typeof e.data?.message === "string") return e.data.message
  }
  return error == null ? "unknown error" : String(error)
}

function toPatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (value == null) return []
  return [String(value)]
}

export function normalizeEvent(raw: any): NormalizedEvent | null {
  const event = raw?.payload ?? raw
  const p = event?.properties ?? {}
  switch (event?.type) {
    case "message.part.updated": {
      const part = p.part ?? {}
      if (part.type === "text") return { kind: "text", sessionId: part.sessionID ?? p.sessionID, messageId: part.messageID, partId: part.id, text: part.text ?? "" }
      if (part.type === "tool") return { kind: "tool", sessionId: part.sessionID ?? p.sessionID, messageId: part.messageID, partId: part.id, name: part.tool ?? "tool", status: part.state?.status ?? "unknown" }
      return null
    }
    case "session.idle": return { kind: "idle", sessionId: p.sessionID }
    case "session.error": return { kind: "error", sessionId: p.sessionID, message: errorMessage(p.error) }
    case "permission.updated": return { kind: "permission", sessionId: p.sessionID, permissionId: p.id, tool: String(p.tool ?? p.type ?? ""), patterns: toPatterns(p.patterns ?? p.pattern) }
    default: return null
  }
}

export const INITIAL_BACKOFF = 1000
export const MAX_BACKOFF = 30000
export function nextBackoff(prevMs: number, connected = false): number {
  if (connected) return INITIAL_BACKOFF
  return Math.min(prevMs * 2, MAX_BACKOFF)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    timer = setTimeout(done, ms)
    if (signal.aborted) done()
    else signal.addEventListener("abort", done, { once: true })
  })
}

export interface EventRouterDeps {
  route(sessionId: string): string | undefined
  onEvent(threadId: string, e: NormalizedEvent): void
  onResync(threadId: string, sessionId: string): Promise<void>
  knownSessions(): { threadId: string; sessionId: string }[]
}
export class EventRouter {
  constructor(private readonly deps: EventRouterDeps) {}
  async subscribe(baseUrl: string, password: string, signal: AbortSignal): Promise<void> {
    const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
    let connectedBefore = false
    let backoff = INITIAL_BACKOFF
    while (!signal.aborted) {
      let connected = false
      try {
        const res = await fetch(`${baseUrl}/global/event`, { headers: { Authorization: auth, Accept: "text/event-stream" }, signal })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        connected = true
        if (connectedBefore) for (const s of this.deps.knownSessions()) await this.deps.onResync(s.threadId, s.sessionId)
        connectedBefore = true
        const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = ""
        while (true) {
          const { value, done } = await reader.read(); if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
            const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
            if (!data) continue
            let parsed: any; try { parsed = JSON.parse(data) } catch { continue }
            const e = normalizeEvent(parsed); if (!e) continue
            const threadId = this.deps.route(e.sessionId)
            if (threadId) this.deps.onEvent(threadId, e)
          }
        }
      } catch {}
      if (signal.aborted) return
      const delay = connected ? INITIAL_BACKOFF : backoff
      await sleep(delay, signal)
      backoff = nextBackoff(delay, connected)
    }
  }
}
