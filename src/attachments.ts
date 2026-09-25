import { join } from "node:path"
import { isPathInside, sanitizeAttachmentName } from "./sbx.js"

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
