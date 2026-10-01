import { MessageFlags } from "discord.js"
import type { NormalizedEvent } from "./events.ts"
import { DISCORD_CHUNK_LIMIT } from "./helpers.js"

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

const FENCE_LINE = /^( {0,3})(`{3,})(.*)$/

/**
 * Discord only parses code fences made of exactly three backticks, so collapse
 * any 3+ backtick marker at the start of a line down to three. A longer fence
 * (e.g. an agent's ```` to nest ```) renders as literal text otherwise.
 */
function normalizeFenceMarker(line: string): string {
  const m = FENCE_LINE.exec(line)
  if (!m) return line
  return `${m[1] ?? ""}\`\`\`${m[3] ?? ""}`
}

/** Split plain (non-code) text into pieces no longer than `max`, preferring newlines. */
function splitPlain(text: string, max: number): string[] {
  const pieces: string[] = []
  let pos = 0
  while (pos < text.length) {
    let end = Math.min(pos + max, text.length)
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1)
      if (nl >= pos + Math.floor((end - pos) * 0.5)) end = nl + 1
    }
    if (end <= pos) end = Math.min(pos + 1, text.length)
    pieces.push(text.slice(pos, end))
    pos = end
  }
  return pieces
}

type Block = { kind: "text"; text: string } | { kind: "fence"; info: string; body: string }

/** Split normalized text into alternating plain-text and fenced-code blocks. */
function segment(text: string): Block[] {
  const blocks: Block[] = []
  const textBuf: string[] = []
  let bodyBuf: string[] = []
  let openInfo: string | null = null
  for (const line of text.split("\n")) {
    const m = FENCE_LINE.exec(line)
    if (openInfo === null) {
      if (m) {
        if (textBuf.length > 0) { blocks.push({ kind: "text", text: textBuf.join("\n") }); textBuf.length = 0 }
        openInfo = (m[3] ?? "").trim()
        bodyBuf = []
      } else {
        textBuf.push(line)
      }
    } else if (m && (m[3] ?? "").trim() === "") {
      blocks.push({ kind: "fence", info: openInfo, body: bodyBuf.join("\n") })
      openInfo = null
      bodyBuf = []
    } else {
      bodyBuf.push(line)
    }
  }
  if (openInfo !== null) blocks.push({ kind: "fence", info: openInfo, body: bodyBuf.join("\n") })
  else if (textBuf.length > 0) blocks.push({ kind: "text", text: textBuf.join("\n") })
  return blocks
}

/**
 * Emit a fenced code block as one or more self-contained chunks, each reopened
 * with the original language and closed with exactly three backticks so every
 * Discord message renders as valid code.
 */
function splitFenced(body: string, info: string, max: number): string[] {
  const header = "```" + info + "\n"
  const footer = "\n```"
  const room = max - header.length - footer.length
  if (room <= 0) return [header + body + footer]
  return splitPlain(body, room).map((piece) => header + piece + footer)
}

/** Coalesce adjacent chunks when the joined message still fits. */
function mergeChunks(chunks: string[], max: number): string[] {
  const merged: string[] = []
  for (const chunk of chunks) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.length + 1 + chunk.length <= max) merged[merged.length - 1] = `${last}\n${chunk}`
    else merged.push(chunk)
  }
  return merged
}

export function chunkMessage(text: string, max = DISCORD_CHUNK_LIMIT): string[] {
  if (text === "") return []
  const normalized = text.split("\n").map(normalizeFenceMarker).join("\n")
  if (normalized.length <= max) return [normalized]
  const chunks: string[] = []
  for (const block of segment(normalized)) {
    if (block.kind === "text") chunks.push(...splitPlain(block.text, max))
    else chunks.push(...splitFenced(block.body, block.info, max))
  }
  return mergeChunks(chunks, max)
}
export function sanitizeThreadName(prompt: string): string {
  const cleaned = prompt.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()
  return (cleaned || `session ${new Date().toISOString()}`).slice(0, 80)
}

export const TOOL_TITLE_MAX = 120
function truncateToolTitle(title: string, max = TOOL_TITLE_MAX): string {
  const flat = title.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
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

const NOTICE_TEXT_MAX = 500
type NoticeTone = "info" | "warn" | "error"
function noticeLabel(tone: NoticeTone): string {
  if (tone === "error") return "Error"
  if (tone === "warn") return "Warning"
  return "Note"
}
function noticeGlyph(tone: NoticeTone): string {
  if (tone === "error") return "❌"
  if (tone === "warn") return "⚠️"
  return "ℹ️"
}

type Segment =
  | { kind: "prompt"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "question"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; status: string; title?: string }
  | { kind: "notice"; id: string; text: string; tone: NoticeTone }

function renderSegment(segment: Segment): string {
  if (segment.kind === "prompt") return formatPrompt(segment.text)
  if (segment.kind === "text") return segment.text
  if (segment.kind === "question") return segment.text
  if (segment.kind === "notice") {
    const flat = segment.text.replace(/\s+/g, " ").trim()
    const label = `> ${noticeGlyph(segment.tone)} **${noticeLabel(segment.tone)}**`
    if (!flat) return label
    const clipped = flat.length > NOTICE_TEXT_MAX ? flat.slice(0, NOTICE_TEXT_MAX - 1).trimEnd() + "…" : flat
    return `${label} — ${clipped}`
  }
  const title = segment.title ? ` · ${truncateToolTitle(segment.title)}` : ""
  return `> ${toolGlyph(segment.status)} \`${segment.name}\`${title}`
}
function isQuote(segment: Segment): boolean {
  return segment.kind === "tool" || segment.kind === "notice"
}

/** Discord allows at most five component rows on a message. */
const COMPONENT_ROWS_MAX = 5

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
  /**
   * Interactive controls (agent question buttons) ride on the message that
   * currently holds the question block. While a question is pending the run is
   * blocked, so the question is always the tail segment and its controls belong
   * on the last chunk.
   */
  private questionControls: { id: string; components: any[] } | null = null
  /**
   * Persistent controls (the Stop button) shown on the last chunk for as long
   * as the run is live. Cleared by `finalize()` so the run's last edit removes
   * them, and re-attached to a new last chunk whenever the body outgrows it.
   */
  private controls: any[]
  constructor(private readonly deps: {
    send(content: string, components?: any[]): Promise<string>
    edit(messageId: string, content: string, components?: any[]): Promise<void>
    delete?(messageId: string): Promise<void>
    now(): number; intervalMs: number; onMessageId?(id: string): void; onMessageIds?(ids: string[]): void
    initialMessageId?: string | null
    initialMessageIds?: string[] | null
    prompt?: string | null
    controls?: any[] | null
  }) {
    this.controls = deps.controls ?? []
    if (deps.initialMessageIds && deps.initialMessageIds.length > 0) this.ids = [...deps.initialMessageIds]
    else if (deps.initialMessageId) this.ids = [deps.initialMessageId]
    if (deps.prompt && deps.prompt.trim()) {
      this.upsert({ kind: "prompt", id: "__prompt__", text: deps.prompt })
      this.dirty = true
    }
  }
  /**
   * Render (or update) an agent question inline in the streamed body. A
   * non-empty `components` attaches the interactive controls to the question's
   * message; `null` clears them (answered, rejected, timed out, inactive).
   */
  upsertQuestion(id: string, text: string, components: any[] | null): void {
    this.upsert({ kind: "question", id, text })
    if (components && components.length > 0) this.questionControls = { id, components }
    else if (this.questionControls?.id === id) this.questionControls = null
    this.dirty = true
    this.revision++
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
    else if (e.kind === "notice") this.upsert({ kind: "notice", id: e.partId, text: e.text, tone: e.tone })
    else return
    this.dirty = true
    this.revision++
  }
  /**
   * Components for the last chunk: pending question controls first (the
   * actionable item), then the persistent run controls. Truncated to Discord's
   * five-row limit, so a wide question UI drops the Stop row rather than
   * failing the whole edit.
   */
  private lastChunkComponents(): any[] {
    const rows = [...(this.questionControls?.components ?? []), ...this.controls]
    return rows.slice(0, COMPONENT_ROWS_MAX)
  }
  private async runFlush(): Promise<void> {
    const revision = this.revision
    const chunks = chunkMessage(this.body(), DISCORD_CHUNK_LIMIT)
    if (chunks.length === 0) {
      // Never send(""): an empty body is not a message. If earlier chunks
      // existed and the body shrank to nothing, drop them instead.
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
      const components = i === chunks.length - 1 ? this.lastChunkComponents() : []
      const existing = this.ids[i]
      if (existing !== undefined) await this.deps.edit(existing, content, components)
      else {
        const id = await this.deps.send(content, components)
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
    // Drop the persistent controls on the run's final edit. Mark dirty so the
    // message is rewritten even when the body itself did not change.
    if (this.controls.length > 0) {
      this.controls = []
      this.dirty = true
      this.revision++
    }
    await this.flush()
  }
}
