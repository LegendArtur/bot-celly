import type { NormalizedEvent } from "./events.ts"

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
    const m = /^(\s*)(`{3,})(.*)$/.exec(line)
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
  const re = new RegExp("^\\s*`{" + fenceLen + ",}")
  const starts: number[] = []
  let offset = 0
  for (const line of text.split("\n")) {
    if (re.test(line)) starts.push(offset)
    offset += line.length + 1
  }
  return starts
}

export function chunkMessage(text: string, max = 1900): string[] {
  if (text.length <= max) return [text]
  const fenceLen = Math.max(3, longestBacktickRun(text) + 1)
  const fence = "`".repeat(fenceLen)
  const normalized = normalizeFences(text, fenceLen)
  const markerStarts = fenceMarkerStarts(normalized, fenceLen)
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

export class Renderer {
  private text = ""
  private tools = new Map<string, string>()
  private ids: string[] = []
  private lastEdit = Number.NEGATIVE_INFINITY
  private dirty = false
  private lastPart = new Map<string, string>()
  constructor(private readonly deps: {
    send(content: string): Promise<string>; edit(messageId: string, content: string): Promise<void>
    now(): number; intervalMs: number; onMessageId?(id: string): void
  }) {}
  private body(): string {
    const toolLines = [...this.tools.values()].map((t) => `> ${t}`).join("\n")
    return [toolLines, this.text].filter(Boolean).join("\n\n")
  }
  push(e: NormalizedEvent): void {
    if (e.kind === "text") {
      const prev = this.lastPart.get(e.partId) ?? ""
      this.text = this.text.slice(0, Math.max(0, this.text.length - prev.length)) + e.text
      this.lastPart.set(e.partId, e.text)
      this.dirty = true
    } else if (e.kind === "tool") {
      this.tools.set(e.partId, `[${e.name}] ${e.status}`)
      this.dirty = true
    }
  }
  async flush(): Promise<void> {
    if (!this.dirty) return
    const chunks = chunkMessage(this.body(), 1900)
    for (const [i, content] of chunks.entries()) {
      const existing = this.ids[i]
      if (existing !== undefined) await this.deps.edit(existing, content)
      else {
        const id = await this.deps.send(content)
        this.ids.push(id)
        this.deps.onMessageId?.(id)
      }
    }
    this.lastEdit = this.deps.now()
    this.dirty = false
  }
  async tick(): Promise<void> {
    if (this.ids.length > 0 && this.deps.now() - this.lastEdit < this.deps.intervalMs) return
    await this.flush()
  }
  async finalize(): Promise<void> { await this.flush() }
}
