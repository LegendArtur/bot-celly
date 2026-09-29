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

const COMPOUND_KEYWORDS = new Set([
  "eval", "source", ".", "{", "}", "if", "then", "elif", "else", "fi",
  "for", "do", "done", "while", "until", "case", "esac", "select", "function", "coproc",
])

export type ShellScan = { ok: true; commands: string[] } | { ok: false; reason: string; commands: string[] }

class ScanError extends Error {
  constructor(readonly reason: string) { super(reason) }
}

function extractBalanced(input: string, openIndex: number, open: string, close: string): { text: string; next: number } | null {
  let depth = 0
  let quote: "'" | '"' | null = null
  for (let i = openIndex; i < input.length; i++) {
    const ch = input[i]!
    if (quote === "'") { if (ch === "'") quote = null; continue }
    if (quote === '"') { if (ch === "\\") { i++; continue } if (ch === '"') quote = null; continue }
    if (ch === "\\") { i++; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return { text: input.slice(openIndex + 1, i), next: i + 1 }
    }
  }
  return null
}

function findBacktickEnd(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue }
    if (input[i] === "`") return i
  }
  return -1
}

function readWord(input: string, start: number): { text: string; quoted: boolean; next: number } | null {
  let text = ""
  let quoted = false
  let i = start
  while (i < input.length && !/[\s;&|()<>`]/.test(input[i]!)) {
    const ch = input[i]!
    if (ch === "\\") {
      if (i + 1 >= input.length) return null
      text += input[i + 1]
      quoted = true
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const close = ch === "'" ? input.indexOf("'", i + 1) : findQuoteEnd(input, i + 1)
      if (close === -1) return null
      text += input.slice(i + 1, close)
      quoted = true
      i = close + 1
      continue
    }
    text += ch
    i++
  }
  return { text, quoted, next: i }
}

function findQuoteEnd(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue }
    if (input[i] === '"') return i
  }
  return -1
}

function readHeredocBody(input: string, start: number, delimiter: string, stripTabs: boolean): { body: string; next: number } | null {
  let i = start
  if (input[i] === "\n") i++
  const bodyStart = i
  while (i <= input.length) {
    const lineEnd = input.indexOf("\n", i)
    const end = lineEnd === -1 ? input.length : lineEnd
    const line = input.slice(i, end)
    const candidate = stripTabs ? line.replace(/^\t+/, "") : line
    if (candidate === delimiter) return { body: input.slice(bodyStart, i), next: end + 1 }
    if (lineEnd === -1) return null
    i = lineEnd + 1
  }
  return null
}

function collectSubstitutions(input: string, depth: number, commands: string[]): void {
  if (depth > 6) throw new ScanError("nesting too deep")
  let quote: "'" | null = null
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (quote === "'") { if (ch === "'") quote = null; i++; continue }
    if (ch === "\\") { i += 2; continue }
    if (ch === "'") { quote = "'"; i++; continue }
    if (ch === "$" && input[i + 1] === "(") {
      const parsed = extractBalanced(input, i + 1, "(", ")")
      if (!parsed) throw new ScanError("unbalanced $(")
      const inner = parsed.text
      if (inner.startsWith("(")) collectSubstitutions(inner, depth + 1, commands)
      else collectCommands(inner, depth + 1, commands)
      i = parsed.next
      continue
    }
    if (ch === "`") {
      const end = findBacktickEnd(input, i + 1)
      if (end === -1) throw new ScanError("unbalanced backtick")
      collectCommands(input.slice(i + 1, end), depth + 1, commands)
      i = end + 1
      continue
    }
    i++
  }
}

function shellPayload(segment: string): string | undefined {
  const tokens = tokenizeShell(segment)
  let i = 0
  for (;;) {
    while (tokens[i] !== undefined && ENV_ASSIGNMENT.test(tokens[i]!)) i++
    const token = tokens[i]
    if (token === undefined) return undefined
    const name = executableName(token)
    if (name === "env") {
      i++
      while (tokens[i] !== undefined) {
        const t = tokens[i]!
        if (ENV_ASSIGNMENT.test(t)) { i++; continue }
        if (t.startsWith("-")) { i += ENV_VALUE_OPTS.has(t) ? 2 : 1; continue }
        break
      }
      if (tokens[i] === undefined) return undefined
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
      if (cIndex !== -1 && tokens[cIndex + 1] !== undefined) return tokens.slice(cIndex + 1).join(" ")
    }
    return undefined
  }
}

function expandSegment(segment: string, depth: number, commands: string[]): void {
  commands.push(segment)
  const payload = shellPayload(segment)
  if (payload !== undefined) collectCommands(payload, depth + 1, commands)
}

function collectCommands(input: string, depth: number, commands: string[]): void {
  if (depth > 6) throw new ScanError("nesting too deep")
  let current = ""
  let quote: "'" | '"' | null = null
  let i = 0
  const flush = (): void => {
    const c = current.trim()
    current = ""
    if (c) expandSegment(c, depth, commands)
  }
  while (i < input.length) {
    const ch = input[i]!
    if (quote === "'") {
      current += ch
      if (ch === "'") quote = null
      i++
      continue
    }
    if (quote === null) {
      if (ch === "\\") {
        if (i + 1 >= input.length) { current += ch; i++; continue }
        current += input.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === "'") { quote = "'"; current += ch; i++; continue }
      if (ch === '"') { quote = '"'; current += ch; i++; continue }
    } else if (ch === '"') {
      quote = null
      current += ch
      i++
      continue
    } else if (ch === "\\") {
      current += input.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === "$" && input[i + 1] === "{") {
      const end = input.indexOf("}", i + 2)
      if (end === -1) throw new ScanError("unbalanced ${")
      current += input.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (ch === "$" && input[i + 1] === "(") {
      if (current.trim() === "") throw new ScanError("command position is a substitution")
      const parsed = extractBalanced(input, i + 1, "(", ")")
      if (!parsed) throw new ScanError("unbalanced $(")
      const inner = parsed.text
      if (inner.startsWith("(")) collectSubstitutions(inner, depth + 1, commands)
      else collectCommands(inner, depth + 1, commands)
      current += input.slice(i, parsed.next)
      i = parsed.next
      continue
    }
    if (ch === "`") {
      if (current.trim() === "") throw new ScanError("command position is a substitution")
      const end = findBacktickEnd(input, i + 1)
      if (end === -1) throw new ScanError("unbalanced backtick")
      collectCommands(input.slice(i + 1, end), depth + 1, commands)
      current += input.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (quote === null && (ch === "<" || ch === ">") && input[i + 1] === "(") throw new ScanError("process substitution")
    if (quote === null && ch === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      const stripTabs = input[i + 2] === "-"
      let j = i + (stripTabs ? 3 : 2)
      while (input[j] === " " || input[j] === "\t") j++
      const word = readWord(input, j)
      if (!word || !word.text) throw new ScanError("unterminated heredoc")
      const body = readHeredocBody(input, word.next, word.text, stripTabs)
      if (!body) throw new ScanError("unterminated heredoc")
      if (!word.quoted) collectSubstitutions(body.body, depth, commands)
      current += input.slice(i, body.next)
      i = body.next
      continue
    }
    if (quote === null && (ch === ";" || ch === "\n" || ch === "&" || ch === "|" || ch === "(" || ch === ")")) {
      flush()
      if ((ch === "&" && input[i + 1] === "&") || (ch === "|" && input[i + 1] === "|")) i++
      i++
      continue
    }
    current += ch
    i++
  }
  if (quote !== null) throw new ScanError("unbalanced quote")
  flush()
}

export function scanShellCommands(input: string): ShellScan {
  const commands: string[] = []
  try {
    collectCommands(input, 0, commands)
    return { ok: true, commands }
  } catch (e) {
    if (e instanceof ScanError) return { ok: false, reason: e.reason, commands }
    throw e
  }
}

function isIndeterminate(segment: string): boolean {
  const normalized = normalizeCommand(segment)
  const exe = normalized.split(" ")[0]
  if (!exe) return false
  if (COMPOUND_KEYWORDS.has(exe)) return true
  return exe.includes("$") || exe.includes("`")
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
