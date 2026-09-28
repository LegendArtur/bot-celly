import { MessageFlags } from "discord.js"
import type { NormalizedEvent } from "./events.ts"

export interface RenderPayload {
  content: string
  allowedMentions: { parse: [] }
  flags: number
}

/**
 * The single Discord output chokepoint. Every renderer send/edit and channel
 * notice goes through this so replies never ping roles/users and never
 * generate link previews (spec §9).
 */
export function renderPayload(content: string): RenderPayload {
  return { content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds }
}

function longestBacktickRun(text: string): number {
  let max = 0
  const re = /`+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) if (m[0].length > max) max = m[0].length
  return max
}

function normalizeFences(text: string, fenceLen: number): string {
  const fence = "`".repeat(fenceLen)
  const lines = text.split("\n")
  const out: string[] = []
  let openRun = 0
  for (const line of lines) {
    const m = /^( {0,3})(`{3,})(.*)$/.exec(line)
    if (!m) { out.push(line); continue }
    const [, lead = "", ticks = "", info = ""] = m
    const run = ticks.length
    if (openRun === 0) { openRun = run; out.push(lead + fence + info) }
    else if (run >= openRun && info.trim() === "") { openRun = 0; out.push(lead + fence) }
    else out.push(line)
  }
  return out.join("\n")
}

function fenceMarkerStarts(text: string, fenceLen: number): number[] {
  const re = new RegExp("^ {0,3}`{" + fenceLen + ",}")
  const starts: number[] = []
  let offset = 0
  for (const line of text.split("\n")) {
    if (re.test(line)) starts.push(offset)
    offset += line.length + 1
  }
  return starts
}

export function chunkMessage(text: string, max = 1900): string[] {
  if (text === "") return []
  if (text.length <= max) return [text]
  const fenceLen = Math.max(3, longestBacktickRun(text) + 1)
  const fence = "`".repeat(fenceLen)
  const useFences = 4 * fence.length <= max
  const normalized = useFences ? normalizeFences(text, fenceLen) : text
  const markerStarts = useFences ? fenceMarkerStarts(normalized, fenceLen) : []
  const isInside = (offset: number): boolean => {
    let count = 0
    for (const start of markerStarts) { if (start < offset) count++; else break }
    return count % 2 === 1
  }
  const endClose = isInside(normalized.length) ? fence.length + 1 : 0
  const chunks: string[] = []
  let pos = 0
  let pending = ""
  while (normalized.length - pos + pending.length + endClose > max) {
    let limit = pos + max - pending.length
    if (limit <= pos) limit = pos + 1
    let cut = normalized.lastIndexOf("\n", limit)
    if (cut < pos + Math.floor((limit - pos) * 0.5)) cut = limit
    let inside = isInside(cut)
    if (inside) {
      const maxCut = pos + max - pending.length - fence.length - 1
      if (cut > maxCut) { cut = Math.max(pos + 1, maxCut); inside = isInside(cut) }
    }
    if (cut <= pos) cut = Math.min(pos + 1, normalized.length)
    const head = pending + normalized.slice(pos, cut) + (inside ? "\n" + fence : "")
    chunks.push(head)
    pending = inside ? fence + "\n" : ""
    pos = cut
    if (normalized[pos] === "\n") pos++
  }
  const tail = pending + normalized.slice(pos) + (isInside(normalized.length) ? "\n" + fence : "")
  if (tail !== "") chunks.push(tail)
  return chunks
}
export function sanitizeThreadName(prompt: string): string {
  const cleaned = prompt.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()
  return (cleaned || `session ${new Date().toISOString()}`).slice(0, 80)
}

export const TOOL_TITLE_MAX = 120
function truncateToolTitle(title: string, max = TOOL_TITLE_MAX): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title
}

export function toolGlyph(status: string): string {
  if (status === "pending") return "⏳"
  if (status === "running") return "🔄"
  if (status === "completed") return "✅"
  if (status === "error") return "❌"
  return "•"
}

const PROMPT_TEXT_MAX = 300
export function formatPrompt(text: string, max = PROMPT_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return ""
  const clipped = flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat
  return `> **you** · ${clipped}`
}

type Segment =
  | { kind: "prompt"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; status: string; title?: string }

function renderSegment(segment: Segment): string {
  if (segment.kind === "prompt") return formatPrompt(segment.text)
  if (segment.kind === "text") return segment.text
  const title = segment.title ? ` · ${truncateToolTitle(segment.title)}` : ""
  return `> ${toolGlyph(segment.status)} \`${segment.name}\`${title}`
}
function isQuote(segment: Segment): boolean {
  return segment.kind === "tool"
}

export class Renderer {
  private segments: Segment[] = []
  private segmentIndex = new Map<string, number>()
  private ids: string[] = []
  private lastEdit = Number.NEGATIVE_INFINITY
  private dirty = false
  private revision = 0
  private startedAt: number | null = null
  private endedAt: number | null = null
  private inFlight: Promise<void> | null = null
  private footer = ""
  constructor(private readonly deps: {
    send(content: string): Promise<string>; edit(messageId: string, content: string): Promise<void>
    delete?(messageId: string): Promise<void>
    now(): number; intervalMs: number; onMessageId?(id: string): void; onMessageIds?(ids: string[]): void
    initialMessageId?: string | null
    initialMessageIds?: string[] | null
    prompt?: string | null
  }) {
    if (deps.initialMessageIds && deps.initialMessageIds.length > 0) this.ids = [...deps.initialMessageIds]
    else if (deps.initialMessageId) this.ids = [deps.initialMessageId]
    if (deps.prompt && deps.prompt.trim()) {
      this.upsert({ kind: "prompt", id: "__prompt__", text: deps.prompt })
      this.dirty = true
    }
  }
  private upsert(segment: Segment): void {
    const existing = this.segmentIndex.get(segment.id)
    if (existing === undefined) {
      this.segmentIndex.set(segment.id, this.segments.length)
      this.segments.push(segment)
      return
    }
    this.segments[existing] = segment
  }
  private body(): string {
    let body = ""
    let previousQuote = false
    let first = true
    for (const segment of this.segments) {
      const rendered = renderSegment(segment)
      if (!rendered) continue
      const quote = isQuote(segment)
      if (first) body = rendered
      else body += (previousQuote && quote ? "\n" : "\n\n") + rendered
      previousQuote = quote
      first = false
    }
    if (this.footer) body = body ? `${body}\n\n-# ${this.footer}` : `-# ${this.footer}`
    return body
  }
  setFooter(text: string): void {
    const next = text.trim()
    if (next === this.footer) return
    this.footer = next
    this.dirty = true
    this.revision++
  }
  elapsedMs(): number {
    if (this.startedAt === null) return 0
    return (this.endedAt ?? this.deps.now()) - this.startedAt
  }
  push(e: NormalizedEvent): void {
    if (this.startedAt === null) this.startedAt = this.deps.now()
    if (e.kind === "text") this.upsert({ kind: "text", id: e.partId, text: e.text })
    else if (e.kind === "tool") this.upsert({ kind: "tool", id: e.partId, name: e.name, status: e.status, ...(e.title ? { title: e.title } : {}) })
    else return
    this.dirty = true
    this.revision++
  }
  private async runFlush(): Promise<void> {
    const revision = this.revision
    const chunks = chunkMessage(this.body(), 1900)
    if (chunks.length === 0) {
      if (this.ids.length > 0) {
        const surplus = this.ids.splice(0)
        if (this.deps.delete) for (const id of surplus) await this.deps.delete(id)
      }
      this.lastEdit = this.deps.now()
      this.deps.onMessageIds?.([...this.ids])
      if (this.revision === revision) this.dirty = false
      return
    }
    for (const [i, content] of chunks.entries()) {
      const existing = this.ids[i]
      if (existing !== undefined) await this.deps.edit(existing, content)
      else {
        const id = await this.deps.send(content)
        this.ids.push(id)
        this.deps.onMessageId?.(id)
      }
    }
    if (this.ids.length > chunks.length) {
      const surplus = this.ids.splice(chunks.length)
      if (this.deps.delete) for (const id of surplus) await this.deps.delete(id)
    }
    this.lastEdit = this.deps.now()
    this.deps.onMessageIds?.([...this.ids])
    if (this.revision === revision) this.dirty = false
  }
  async flush(): Promise<void> {
    while (this.dirty) {
      if (this.inFlight) { await this.inFlight; continue }
      this.inFlight = this.runFlush()
      try { await this.inFlight } finally { this.inFlight = null }
    }
  }
  async tick(): Promise<void> {
    if (this.ids.length > 0 && this.deps.now() - this.lastEdit < this.deps.intervalMs) return
    await this.flush()
  }
  async finalize(): Promise<void> {
    if (this.endedAt === null) this.endedAt = this.deps.now()
    await this.flush()
  }
}
