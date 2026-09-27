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
  share(threadId: string): Promise<string>
  unshare(threadId: string): Promise<void>
  compact(threadId: string): Promise<"compacted">
  contextUsage(threadId: string): Promise<{ used: number; limit: number } | "no-usage" | "no-limit">
}

export interface SessionOpsDeps {
  targetFor(threadId: string): SessionTarget | undefined
  clientFor(threadId: string): OpencodeClient
  threadModel(threadId: string): string | null | undefined
  modelLimit(threadId: string, model: string): Promise<number | undefined>
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

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return String(n)
}

export function formatContextUsage(used: number, limit: number, cells = 20): string {
  const ratio = limit > 0 ? used / limit : 0
  const pct = Math.round(ratio * 100)
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)))
  return `${formatTokens(used)}/${formatTokens(limit)} (${pct}%)\n[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`
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
    async share(threadId) {
      const args = argsFor(deps, threadId)
      const session = unwrap<{ share?: { url?: unknown } }>(await deps.clientFor(threadId).session.share(args))
      const url = session?.share?.url
      if (typeof url !== "string" || !url) throw new Error("session share returned no url")
      return url
    },
    async unshare(threadId) {
      const args = argsFor(deps, threadId)
      await deps.clientFor(threadId).session.unshare(args)
    },
    async compact(threadId) {
      const model = deps.threadModel(threadId)
      const slash = typeof model === "string" ? model.indexOf("/") : -1
      if (slash <= 0 || slash === model!.length - 1) throw new Error("set a model with /model first")
      const args = argsFor(deps, threadId)
      await deps.clientFor(threadId).session.summarize({
        ...args,
        body: { providerID: model!.slice(0, slash), modelID: model!.slice(slash + 1) },
      })
      return "compacted"
    },
    async contextUsage(threadId) {
      const args = argsFor(deps, threadId)
      const messages = unwrap<unknown>(await deps.clientFor(threadId).session.messages(args))
      let last: any
      if (Array.isArray(messages)) {
        for (const message of messages as any[]) if (message?.info?.role === "assistant") last = message
      }
      if (!last) return "no-usage"
      const tokens = last.info?.tokens ?? {}
      const used = Number(tokens.input ?? 0) + Number(tokens.output ?? 0)
        + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0)
      const model = deps.threadModel(threadId)
      if (typeof model !== "string" || !model) return "no-limit"
      const limit = await deps.modelLimit(threadId, model)
      if (typeof limit !== "number" || limit <= 0) return "no-limit"
      return { used, limit }
    },
  }
}
