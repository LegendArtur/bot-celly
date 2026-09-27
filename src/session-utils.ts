import type { FileDiff } from "@opencode-ai/sdk"
import type { OpencodeClient } from "./opencode.ts"

export interface SessionTarget {
  sessionId: string
  directory?: string
}

export interface SessionOps {
  undo(threadId: string): Promise<"reverted" | "nothing">
  redo(threadId: string): Promise<"redone">
  diff(threadId: string): Promise<FileDiff[]>
}

export interface SessionOpsDeps {
  targetFor(threadId: string): SessionTarget | undefined
  clientFor(threadId: string): OpencodeClient
}

export interface SessionArgs {
  path: { id: string }
  query?: { directory: string }
}

function unwrap<T>(response: unknown): T {
  return ((response as { data?: T } | undefined)?.data ?? response) as T
}

function argsFor(deps: SessionOpsDeps, threadId: string): SessionArgs {
  const target = deps.targetFor(threadId)
  if (!target) throw new Error(`unknown thread ${threadId}`)
  return target.directory
    ? { path: { id: target.sessionId }, query: { directory: target.directory } }
    : { path: { id: target.sessionId } }
}

export async function lastUserMessageId(client: OpencodeClient, args: SessionArgs): Promise<string | undefined> {
  const messages = unwrap<unknown>(await client.session.messages(args))
  let last: { info?: { id?: unknown; role?: unknown } } | undefined
  if (Array.isArray(messages)) {
    for (const message of messages as { info?: { id?: unknown; role?: unknown } }[]) {
      if (message?.info?.role === "user") last = message
    }
  }
  return typeof last?.info?.id === "string" && last.info.id ? last.info.id : undefined
}

export function formatDiff(files: FileDiff[], max = 10): string {
  if (!files.length) return "no changes"
  const shown = files.slice(0, max)
  const lines = shown.map((file) => {
    const status = file.before === "" ? "A" : file.after === "" ? "D" : "M"
    return `${status} ${file.file} (+${file.additions}/-${file.deletions})`
  })
  if (files.length > shown.length) lines.push(`… and ${files.length - shown.length} more`)
  const additions = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0)
  const deletions = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0)
  lines.push(`total: +${additions}/-${deletions} across ${files.length} file${files.length === 1 ? "" : "s"}`)
  return lines.join("\n")
}

export function createSessionOps(deps: SessionOpsDeps): SessionOps {
  return {
    async undo(threadId) {
      const args = argsFor(deps, threadId)
      const messageID = await lastUserMessageId(deps.clientFor(threadId), args)
      if (!messageID) return "nothing"
      await deps.clientFor(threadId).session.revert({ ...args, body: { messageID } })
      return "reverted"
    },
    async redo(threadId) {
      const args = argsFor(deps, threadId)
      await deps.clientFor(threadId).session.unrevert(args)
      return "redone"
    },
    async diff(threadId) {
      const args = argsFor(deps, threadId)
      const files = unwrap<unknown>(await deps.clientFor(threadId).session.diff(args))
      return Array.isArray(files) ? (files as FileDiff[]) : []
    },
  }
}
