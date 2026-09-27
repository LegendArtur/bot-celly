import { setTimeout as delay } from "node:timers/promises"
import type { QuestionInfo } from "@opencode-ai/sdk/v2"
import { basicAuth } from "./opencode.js"

export type NormalizedEvent =
  | { kind: "text"; sessionId: string; messageId: string; partId: string; text: string }
  | { kind: "tool"; sessionId: string; messageId: string; partId: string; name: string; status: string }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId: string; message: string }
  | { kind: "permission"; sessionId: string; permissionId: string; source: "v1" | "v2"; tool: string; patterns: string[] }
  | { kind: "permission-replied"; sessionId: string; requestId: string }
  | { kind: "question"; sessionId: string; requestId: string; questions: QuestionInfo[] }

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

function toQuestionInfo(value: unknown): QuestionInfo | null {
  if (!value || typeof value !== "object") return null
  const raw = value as { question?: unknown; header?: unknown; options?: unknown; multiple?: unknown; custom?: unknown }
  if (typeof raw.question !== "string" || !raw.question) return null
  const options: { label: string; description: string }[] = []
  if (Array.isArray(raw.options)) {
    for (const candidate of raw.options) {
      if (!candidate || typeof candidate !== "object") continue
      const option = candidate as { label?: unknown; description?: unknown }
      if (typeof option.label !== "string" || !option.label) continue
      options.push({ label: option.label, description: typeof option.description === "string" ? option.description : "" })
    }
  }
  const info: QuestionInfo = { question: raw.question, header: typeof raw.header === "string" ? raw.header : "", options }
  if (raw.multiple === true) info.multiple = true
  if (typeof raw.custom === "boolean") info.custom = raw.custom
  return info
}

function toQuestions(value: unknown): QuestionInfo[] {
  if (!Array.isArray(value)) return []
  const out: QuestionInfo[] = []
  for (const candidate of value) {
    const info = toQuestionInfo(candidate)
    if (info) out.push(info)
  }
  return out
}

export function partToEvent(sessionId: string, messageId: string, part: any): NormalizedEvent | null {
  if (!part || typeof part !== "object") return null
  if (part.type === "text") return { kind: "text", sessionId, messageId, partId: part.id, text: part.text ?? "" }
  if (part.type === "tool") return { kind: "tool", sessionId, messageId, partId: part.id, name: part.tool ?? "tool", status: part.state?.status ?? "unknown" }
  return null
}

export function normalizeEvent(raw: any): NormalizedEvent | null {
  const event = raw?.payload ?? raw
  const p = event?.properties ?? {}
  switch (event?.type) {
    case "message.part.updated": {
      const part = p.part ?? {}
      return partToEvent(part.sessionID ?? p.sessionID, part.messageID, part)
    }
    case "session.idle": return { kind: "idle", sessionId: p.sessionID }
    case "session.error": return { kind: "error", sessionId: p.sessionID, message: errorMessage(p.error) }
    case "permission.updated":
      return { kind: "permission", source: "v1", sessionId: p.sessionID, permissionId: p.id, tool: String(p.tool ?? p.type ?? ""), patterns: toPatterns(p.patterns ?? p.pattern) }
    case "permission.asked":
    case "permission.v2.asked":
      return { kind: "permission", source: "v2", sessionId: p.sessionID, permissionId: p.id, tool: String(p.permission ?? p.action ?? ""), patterns: toPatterns(p.patterns ?? p.resources) }
    case "permission.replied": {
      const requestId = String(p.requestID ?? p.permissionID ?? "")
      return requestId ? { kind: "permission-replied", sessionId: p.sessionID, requestId } : null
    }
    case "question.asked":
    case "question.v2.asked":
      return { kind: "question", sessionId: p.sessionID, requestId: String(p.id ?? ""), questions: toQuestions(p.questions) }
    default: return null
  }
}

export const INITIAL_BACKOFF = 1000
export const MAX_BACKOFF = 30000
export function nextBackoff(prevMs: number, connected = false): number {
  if (connected) return INITIAL_BACKOFF
  return Math.min(prevMs * 2, MAX_BACKOFF)
}

const FRAME_BOUNDARY = /\r?\n\r?\n/
const MAX_SSE_BUFFER = 1024 * 1024

export function trimSseBuffer(buf: string, max = MAX_SSE_BUFFER): string {
  if (buf.length <= max) return buf
  let cut = -1
  for (const boundary of ["\r\n\r\n", "\n\n"]) {
    const i = buf.lastIndexOf(boundary)
    if (i >= 0 && i + boundary.length > cut) cut = i + boundary.length
  }
  return cut > 0 ? buf.slice(cut) : buf
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  // `delay` rejects with AbortError when the signal fires; the caller checks
  // signal.aborted itself, so swallow the rejection.
  return delay(ms, undefined, { signal }).then(() => undefined, () => undefined)
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
    const auth = basicAuth(password)
    let connectedBefore = false
    let backoff = INITIAL_BACKOFF
    let warned = false
    while (!signal.aborted) {
      let connected = false
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      try {
        const res = await fetch(`${baseUrl}/global/event`, { headers: { Authorization: auth, Accept: "text/event-stream" }, signal })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        connected = true
        warned = false
        if (connectedBefore) {
          let sessions: { threadId: string; sessionId: string }[] = []
          try { sessions = this.deps.knownSessions() } catch (err) { console.warn("knownSessions failed", err) }
          for (const s of sessions) {
            try { await this.deps.onResync(s.threadId, s.sessionId) } catch (err) { console.warn("event stream resync failed", err) }
          }
        }
        connectedBefore = true
        reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ""
        const consume = (): void => {
          let m: RegExpExecArray | null
          while ((m = FRAME_BOUNDARY.exec(buf))) {
            const block = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length)
            const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
            if (!data) continue
            let parsed: any; try { parsed = JSON.parse(data) } catch { continue }
            const e = normalizeEvent(parsed); if (!e) continue
            const threadId = this.deps.route(e.sessionId)
            if (threadId) this.deps.onEvent(threadId, e)
          }
        }
        while (true) {
          const { value, done } = await reader.read()
          if (done) { buf += decoder.decode(); consume(); break }
          buf += decoder.decode(value, { stream: true })
          consume()
          if (buf.length > MAX_SSE_BUFFER) {
            console.warn(`event stream frame exceeded ${MAX_SSE_BUFFER} bytes; trimming to the last frame boundary`)
            buf = trimSseBuffer(buf, MAX_SSE_BUFFER)
          }
        }
      } catch (err) {
        if (reader) { try { await reader.cancel() } catch {} reader = null }
        if (signal.aborted) return
        if (!warned) { console.warn("event stream connection failed; will keep retrying", String(err)); warned = true }
      }
      if (signal.aborted) return
      const waitMs = connected ? INITIAL_BACKOFF : backoff
      await sleep(waitMs, signal)
      backoff = nextBackoff(waitMs, connected)
    }
  }
}
