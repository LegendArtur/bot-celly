import type { NormalizedEvent } from "./events.ts"

export function chunkMessage(text: string, max = 1900): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max)
    if (cut < max * 0.5) cut = max
    let head = rest.slice(0, cut)
    const open = (head.match(/```/g) ?? []).length % 2 === 1
    if (open) head += "\n```"
    chunks.push(head)
    rest = (open ? "```\n" : "") + rest.slice(cut).replace(/^\n/, "")
  }
  if (rest) chunks.push(rest)
  return chunks
}
export function sanitizeThreadName(prompt: string): string {
  const cleaned = prompt.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()
  return (cleaned || `session ${new Date().toISOString()}`).slice(0, 80)
}

export class Renderer {
  private text = ""
  private tools = new Map<string, string>()
  private liveId: string | null = null
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
    const content = this.body().slice(0, 1900)
    if (this.liveId) await this.deps.edit(this.liveId, content)
    else { this.liveId = await this.deps.send(content); this.deps.onMessageId?.(this.liveId) }
    this.lastEdit = this.deps.now(); this.dirty = false
  }
  async tick(): Promise<void> {
    if (this.liveId && this.deps.now() - this.lastEdit < this.deps.intervalMs) return
    await this.flush()
  }
  async finalize(): Promise<void> { await this.flush() }
}
