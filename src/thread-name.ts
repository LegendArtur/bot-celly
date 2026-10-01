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
