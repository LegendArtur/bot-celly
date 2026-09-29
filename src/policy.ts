import { bashDenyPatterns } from "./opencode.js"
import { PLAN_READ_ONLY_TOOLS } from "./mode.js"
import type { ApprovalMode } from "./mode.ts"

const DEFAULT_DENY = bashDenyPatterns()
// The real opencode tool ids (see @opencode-ai/sdk PermissionConfig) plus the
// ids older builds surfaced (patch/todoread/multiedit). Anything outside this
// list is default-rejected rather than silently allowed.
const ALLOWED_TOOLS = new Set([
  "bash", "edit", "write", "read", "glob", "grep", "list", "find",
  "webfetch", "websearch", "task", "skill", "lsp", "doom_loop",
  "todowrite", "todoread", "patch", "multiedit",
])

const WRAPPERS = new Set(["command", "npx", "bunx", "pnpx", "doas", "sudo", "time", "nice"])
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout", "-r", "--role", "-t", "--type"]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  command: new Set<string>(),
  npx: new Set(["-p", "--package", "--node-options", "--prefix", "-c", "--call"]),
  bunx: new Set(["-p", "--package"]),
  pnpx: new Set(["-p", "--package"]),
}
const ENV_VALUE_OPTS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"])
const SHELL_C_FLAG = /^-[a-zA-Z]*c$/
const VALUE_OPTS = new Set([
  "-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix",
  "--prefix", "--dir", "--filter", "-F", "--cwd", "--upload-pack", "--receive-pack",
])
const MULTIWORD_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "bun"])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SENSITIVE_PATH = /(^|[\\/])\.config[\\/]celly([\\/]|$)|opencode\.env/i
// Must stay below every const that normalizeCommand closes over: calling it earlier throws a TDZ ReferenceError.
const NORMALIZED_DEFAULT_DENY = DEFAULT_DENY.map(normalizeCommand)

function executableName(token: string): string {
  if (/[*?]/.test(token)) return token
  const parts = token.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || token
}

/** Minimal POSIX-ish tokenizer: splits on whitespace while honouring quotes and backslash escapes. */
export function tokenizeShell(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let started = false
  let quote: "'" | '"' | null = null
  const push = (): void => { if (started) { tokens.push(current); current = ""; started = false } }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      started = true
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === "\\" && i + 1 < command.length) current += command[++i]
      else current += ch
      started = true
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue }
    if (ch === "\\" && i + 1 < command.length) { current += command[++i]; started = true; continue }
    if (/\s/.test(ch)) { push(); continue }
    current += ch
    started = true
  }
  push()
  return tokens
}

function shellCommandIndex(tokens: string[], from: number): number {
  for (let j = from; j < tokens.length; j++) {
    const token = tokens[j]!
    if (token === "--") break
    if (SHELL_C_FLAG.test(token)) return j
    if (!token.startsWith("-")) break
  }
  return -1
}

/**
 * Reduce a shell command to `<exe> <subcommand> <args...>` before deny matching
 * so wrappers (`env -i`, `sudo -u x`, `nice -n 10`, `time -p`, `command -p`,
 * `npx --yes`), leading `VAR=val` assignments, absolute paths, and nested
 * `bash -c '<cmd>'` payloads cannot bypass the list.
 */
export function normalizeCommand(command: string): string {
  const tokens = tokenizeShell(command)
  let i = 0
  for (;;) {
    while (tokens[i] !== undefined && ENV_ASSIGNMENT.test(tokens[i]!)) i++
    const token = tokens[i]
    if (token === undefined) return ""
    const name = executableName(token)
    if (name === "env") {
      i++
      while (tokens[i] !== undefined) {
        const t = tokens[i]!
        if (ENV_ASSIGNMENT.test(t)) { i++; continue }
        if (t.startsWith("-")) { i += ENV_VALUE_OPTS.has(t) ? 2 : 1; continue }
        break
      }
      if (tokens[i] === undefined) return "env"
      continue
    }
    if (WRAPPERS.has(name)) {
      i++
      const valueOpts = WRAPPER_VALUE_OPTS[name]
      while (tokens[i]?.startsWith("-")) i += valueOpts?.has(tokens[i]!) ? 2 : 1
      continue
    }
    if (SHELLS.has(name)) {
      const cIndex = shellCommandIndex(tokens, i + 1)
      if (cIndex !== -1 && tokens[cIndex + 1] !== undefined) return normalizeCommand(tokens.slice(cIndex + 1).join(" "))
    }
    break
  }
  const exe = executableName(tokens[i]!)
  i++
  if (MULTIWORD_TOOLS.has(exe)) {
    while (tokens[i]?.startsWith("-")) i += VALUE_OPTS.has(tokens[i]!) ? 2 : 1
  }
  return [exe, ...tokens.slice(i)].join(" ").trim()
}

export function evaluatePermission(req: { tool: string; patterns: string[] }, deny: string[] = DEFAULT_DENY): "once" | "always" | "reject" {
  if (!ALLOWED_TOOLS.has(req.tool)) return "reject"
  const matches = (pattern: string, value: string) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    return new RegExp(`^${escaped}$`).test(value)
  }
  if (req.tool !== "bash") {
    for (const p of req.patterns) if (SENSITIVE_PATH.test(p)) return "reject"
    return "once"
  }
  const normalizedDeny = deny === DEFAULT_DENY ? NORMALIZED_DEFAULT_DENY : deny.map(normalizeCommand)
  for (const p of req.patterns) {
    const normalized = normalizeCommand(p)
    if (normalizedDeny.some((d) => matches(d, normalized))) return "reject"
  }
  return "once"
}

export function decidePermission(mode: ApprovalMode, req: { tool: string; patterns: string[] }): "once" | "always" | "reject" | "ask" {
  if (mode === "auto") return evaluatePermission(req)
  if (evaluatePermission(req) === "reject") return "reject"
  if (PLAN_READ_ONLY_TOOLS.has(req.tool)) return "once"
  return mode === "plan" ? "reject" : "ask"
}

export interface PermissionReplyInput {
  source: "v1" | "v2"
  threadId: string
  sessionId: string
  requestId: string
  reply: "once" | "always" | "reject"
}
