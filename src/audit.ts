import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

export type AuditKind = "permission" | "question" | "shell" | "mode" | "task"
export interface AuditDraft {
  guildId?: string
  channelId?: string
  threadId: string
  actorId: string
  kind: AuditKind
  detail: string
  decision: string
}
export interface AuditEntry {
  ts: string
  guildId?: string
  channelId: string
  threadId: string
  actorId: string
  kind: AuditKind
  detail: string
  decision: string
}
export interface AuditLog {
  append(draft: AuditDraft): void
  tail(limit: number): AuditEntry[]
}
const FILE_MODE = 0o600
export function createAuditLog(opts: { file: string; clock?: () => number }): AuditLog {
  const clock = opts.clock ?? Date.now
  try {
    mkdirSync(dirname(opts.file), { recursive: true })
    appendFileSync(opts.file, "", { mode: FILE_MODE })
    chmodSync(opts.file, FILE_MODE)
  } catch (err) {
    console.error(`audit log init failed: ${String(err)}`)
  }
  return {
    append(draft) {
      const entry: AuditEntry = {
        ts: new Date(clock()).toISOString(),
        channelId: draft.channelId ?? draft.threadId,
        threadId: draft.threadId,
        actorId: draft.actorId,
        kind: draft.kind,
        detail: draft.detail,
        decision: draft.decision,
        ...(draft.guildId ? { guildId: draft.guildId } : {}),
      }
      try { appendFileSync(opts.file, JSON.stringify(entry) + "\n", { mode: FILE_MODE }) }
      catch (err) { console.error(`audit append failed: ${String(err)}`) }
    },
    tail(limit) {
      if (limit <= 0) return []
      let raw = ""
      try { raw = readFileSync(opts.file, "utf8") } catch { return [] }
      const entries: AuditEntry[] = []
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try { entries.push(JSON.parse(line)) } catch {}
      }
      return entries.slice(Math.max(0, entries.length - limit))
    },
  }
}
