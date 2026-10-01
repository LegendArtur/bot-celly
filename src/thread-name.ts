import { unrefTimer } from "./helpers.js"

export type ThreadStatus = "working" | "blocked" | "idle" | "error" | "stopping"

export const TITLE_MAX_WORDS = 10
export const TITLE_MAX_CHARS = 80
export const THREAD_NAME_MAX_CHARS = 100
export const THREAD_NAME_MARKER = ":::celly-name"

const STATUS_PREFIX: Record<ThreadStatus, string> = {
  working: "🟢 working",
  blocked: "⛔ blocked",
  idle: "⏸️ idle",
  error: "❌ error",
  stopping: "⏹️ stopping",
}

export function statusPrefix(status: ThreadStatus): string {
  return STATUS_PREFIX[status]
}

export function normalizeTitle(raw: string): string | null {
  let text = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  text = text.replace(/^[`"'*_~]+/, "").replace(/[`"'*_~]+$/, "").trim()
  text = text.replace(/[.,;:!?。，、！？]+$/, "").trim()
  if (!text) return null
  let words = text.split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS)
  text = words.join(" ")
  if (text.length > TITLE_MAX_CHARS) text = text.slice(0, TITLE_MAX_CHARS).trimEnd()
  words = text.split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS)
  return words.join(" ") || null
}

export function composeThreadName(status: ThreadStatus, title: string | null): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim()
  const prefix = statusPrefix(status)
  const combined = clean ? `${prefix} · ${clean}` : prefix
  return combined.slice(0, THREAD_NAME_MAX_CHARS)
}

const MARKER_LINE = /^[ \t]*:::celly-name[ \t]+(.+?)[ \t]*$/m
const MARKER_LINE_REMOVE = /^[ \t]*:::celly-name[^\n]*(?:\n|$)/gm

export function parseNameMarker(text: string): string | null {
  const match = MARKER_LINE.exec(text ?? "")
  if (!match) return null
  return normalizeTitle(match[1] ?? "")
}

export function stripNameMarker(text: string): string {
  return (text ?? "").replace(MARKER_LINE_REMOVE, "")
}

export function isManualRename(input: {
  oldName: string | null | undefined
  newName: string | null | undefined
  archived: boolean
  known: boolean
  manual: boolean
  lastThreadName: string | null
}): boolean {
  if (!input.known || input.archived || input.manual) return false
  if (!input.newName || input.newName === input.oldName) return false
  return input.newName !== input.lastThreadName
}

export const NAMER_SETTLE_MS = 20_000
export const NAMER_BUCKET_CAPACITY = 2
export const NAMER_REFILL_MS = 300_000

export interface ThreadNamerDeps {
  enabled(): boolean
  rename(threadId: string, name: string): Promise<void>
  getTitle(threadId: string): string | null
  isLocked(threadId: string): boolean
  setLockedTitle(threadId: string, title: string): void
  now(): number
  log(msg: string, fields?: Record<string, unknown>): void
  settleMs?: number
  bucketCapacity?: number
  refillMs?: number
}

interface NamerState {
  status: ThreadStatus
  title: string | null
  manual: boolean
  last?: string
  tokens: number
  lastRefill: number
  blockedUntil: number
  flushing: boolean
  pending: boolean
  timer?: ReturnType<typeof setTimeout>
}

export class ThreadNamer {
  private states = new Map<string, NamerState>()
  private readonly settleMs: number
  private readonly capacity: number
  private readonly refillMs: number
  constructor(private readonly deps: ThreadNamerDeps) {
    this.settleMs = deps.settleMs ?? NAMER_SETTLE_MS
    this.capacity = deps.bucketCapacity ?? NAMER_BUCKET_CAPACITY
    this.refillMs = deps.refillMs ?? NAMER_REFILL_MS
  }
  private state(threadId: string): NamerState {
    let state = this.states.get(threadId)
    if (!state) {
      state = {
        status: "idle", title: this.deps.getTitle(threadId), manual: false,
        tokens: this.capacity, lastRefill: this.deps.now(), blockedUntil: 0,
        flushing: false, pending: false,
      }
      this.states.set(threadId, state)
    }
    return state
  }
  private clearTimer(threadId: string): void {
    const state = this.states.get(threadId)
    if (state?.timer !== undefined) { clearTimeout(state.timer); state.timer = undefined }
  }
  private schedule(threadId: string): void {
    const state = this.states.get(threadId)
    if (!state || state.timer !== undefined) return
    state.timer = setTimeout(() => { state.timer = undefined; void this.flush(threadId) }, this.settleMs)
    unrefTimer(state.timer)
  }
  setStatus(threadId: string, status: ThreadStatus): void {
    if (!this.deps.enabled()) return
    const state = this.state(threadId)
    if (state.manual) return
    state.status = status
    this.schedule(threadId)
  }
  noteFinalText(threadId: string, text: string): void {
    if (!this.deps.enabled() || this.deps.isLocked(threadId)) return
    const title = parseNameMarker(text)
    if (!title) return
    const state = this.state(threadId)
    if (state.manual) return
    state.title = title
    this.deps.setLockedTitle(threadId, title)
    this.schedule(threadId)
  }
  onManualRename(threadId: string): void {
    if (!this.deps.enabled()) return
    const state = this.state(threadId)
    state.manual = true
    this.clearTimer(threadId)
  }
  cancel(threadId: string): void {
    this.clearTimer(threadId)
    this.states.delete(threadId)
  }
  private async flush(threadId: string): Promise<void> {
    const state = this.states.get(threadId)
    if (!state) return
    if (state.flushing) { state.pending = true; return }
    state.flushing = true
    try {
      do {
        state.pending = false
        if (state.manual || !this.deps.enabled()) break
        const now = this.deps.now()
        if (now < state.blockedUntil) { this.schedule(threadId); break }
        const elapsed = now - state.lastRefill
        if (elapsed >= this.refillMs) {
          const gained = Math.floor(elapsed / this.refillMs)
          state.tokens = Math.min(this.capacity, state.tokens + gained)
          state.lastRefill += gained * this.refillMs
        }
        const name = composeThreadName(state.status, state.title)
        if (name === state.last) break
        if (state.tokens < 1) { this.schedule(threadId); break }
        state.tokens -= 1
        try {
          await this.deps.rename(threadId, name)
          state.last = name
        } catch (err) {
          this.deps.log("thread rename failed", { threadId, error: String(err) })
          state.blockedUntil = this.deps.now() + this.refillMs
          this.schedule(threadId)
          break
        }
      } while (state.pending)
    } finally {
      state.flushing = false
    }
  }
}
