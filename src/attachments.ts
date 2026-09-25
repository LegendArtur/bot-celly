import { lstatSync, mkdirSync, realpathSync } from "node:fs"
import { basename, join, posix } from "node:path"
import { isPathInside, sanitizeAttachmentName } from "./sbx.js"

export const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000

function rejectSymlink(path: string, label: string): void {
  let stat
  try { stat = lstatSync(path) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return
    throw e
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
}

/**
 * Resolve and validate the inbox before any write. `mkdir -p` plus a realpath
 * containment check closes the symlink escape: a `.cely` or `inbox` symlink
 * pointing outside the project is rejected, and the final inbox must resolve
 * inside the project directory.
 */
export function ensureSafeInbox(projectDirectory: string): string {
  const celyDir = join(projectDirectory, ".cely")
  const inbox = join(celyDir, "inbox")
  rejectSymlink(celyDir, ".cely")
  rejectSymlink(inbox, "inbox")
  mkdirSync(inbox, { recursive: true })
  rejectSymlink(celyDir, ".cely")
  rejectSymlink(inbox, "inbox")
  const root = realpathSync(projectDirectory)
  const resolvedInbox = realpathSync(inbox)
  if (!isPathInside(root, resolvedInbox)) throw new Error("attachment inbox escapes the project directory")
  return inbox
}

/**
 * Stream a remote attachment with a hard byte cap and a timeout. Returns null
 * for a non-ok response or an over-cap body so the caller skips it instead of
 * buffering unbounded data from an untrusted URL.
 */
export async function downloadAttachment(url: string, maxBytes: number, opts: { timeoutMs?: number } = {}): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? ATTACHMENT_FETCH_TIMEOUT_MS) })
  if (!res.ok || !res.body) return null
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) { await res.body.cancel().catch(() => {}); return null }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel().catch(() => {}); return null }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  return Buffer.concat(chunks)
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".md", ".markdown", ".mdx", ".rst", ".log", ".csv", ".tsv",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
  ".xml", ".html", ".htm", ".svg", ".css", ".scss", ".less",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".sql", ".graphql", ".gql", ".proto",
  ".dockerfile", ".gitignore", ".gitattributes", ".editorconfig",
])

const TEXT_CONTENT_TYPES = /^text\/|application\/(json|xml|x-yaml|x-www-form-urlencoded|javascript|typescript|x-sh|x-httpd-php|x-python)/i

export interface AttachmentLike {
  name: string
  size: number
  contentType?: string | null
  url?: string
}

export function isTextLikeAttachment(attachment: AttachmentLike): boolean {
  if (attachment.contentType && TEXT_CONTENT_TYPES.test(attachment.contentType)) return true
  const match = attachment.name.toLowerCase().match(/\.[a-z0-9]+$/)
  return match ? TEXT_EXTENSIONS.has(match[0]) : false
}

export function shouldIngestAttachment(attachment: AttachmentLike, maxBytes: number): boolean {
  return Number.isFinite(attachment.size) && attachment.size > 0 && attachment.size <= maxBytes && isTextLikeAttachment(attachment)
}

export function attachmentDestination(projectDirectory: string, name: string, id: string): string {
  const inbox = join(projectDirectory, ".cely", "inbox")
  const destination = join(inbox, `${id}-${sanitizeAttachmentName(name)}`)
  if (!isPathInside(inbox, destination)) throw new Error("attachment escapes the inbox")
  return destination
}

export function attachmentSandboxPath(
  projectDirectory: string,
  sandboxPath: string | null | undefined,
  hostDestination: string,
): string {
  const root = sandboxPath && sandboxPath.trim() ? sandboxPath : projectDirectory
  return posix.join(root.replace(/\\/g, "/"), ".cely", "inbox", basename(hostDestination))
}
