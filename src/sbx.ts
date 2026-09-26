// src/sbx.ts
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve, win32 } from "node:path"

export type { ChildProcess }
export interface RunResult { code: number; stdout: string; stderr: string }
export class SbxError extends Error {}
function requireNumber(value: unknown, field: string): number {
  if (value === undefined || value === null || value === "") throw new SbxError(`sbx json: missing ${field}`)
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) throw new SbxError(`sbx json: invalid ${field}: ${String(value)}`)
  return n
}
function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text) } catch (e) { throw new SbxError(`sbx ${what}: invalid JSON: ${(e as Error).message}`) }
}
export class SbxRunner {
  constructor(private readonly bin = "sbx") {}
  run(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.bin, args, { shell: false, windowsHide: true })
      let out = "", err = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (err += d))
      const t = setTimeout(() => child.kill(), opts.timeoutMs ?? 300_000)
      child.on("error", (e) => { clearTimeout(t); reject(e) })
      child.on("close", (code) => { clearTimeout(t); resolvePromise({ code: code ?? -1, stdout: out, stderr: err }) })
    })
  }
  spawnStream(args: string[]) {
    return spawn(this.bin, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  }
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}
export function buildSandboxName(name: string, taken: Set<string>): string {
  let base = `celly-${slugify(name)}`.replace(/[-.]+$/g, "")
  if (base.length > 63) base = base.slice(0, 63).replace(/[-.]+$/g, "")
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 63 - String(i).length - 1)}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

function jsonPreview(json: unknown): string {
  let text: string
  try { text = JSON.stringify(json) ?? String(json) } catch { text = String(json) }
  const type = Array.isArray(json) ? "array" : json === null ? "null" : typeof json
  return `${type} ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`
}
export interface SbxSandbox { name: string; agent: string; status: string; workspace?: string }
export function parseSbxLs(json: unknown): SbxSandbox[] {
  const object = typeof json === "object" && json !== null ? (json as { sandboxes?: unknown }) : undefined
  const raw = Array.isArray(json) ? json : Array.isArray(object?.sandboxes) ? object.sandboxes : undefined
  if (!raw) throw new SbxError(`sbx ls --json: expected { sandboxes: [...] }, got ${jsonPreview(json)}`)
  return raw.map((entry: any) => ({
    name: String(entry.name),
    agent: String(entry.agent ?? ""),
    status: String(entry.status ?? ""),
    workspace: Array.isArray(entry.workspaces) && entry.workspaces[0] !== undefined
      ? String(entry.workspaces[0])
      : entry.workspace === undefined ? undefined : String(entry.workspace),
  }))
}
export function parseSbxPorts(json: unknown) {
  if (!Array.isArray(json)) throw new SbxError(`sbx ports --json: expected an array, got ${jsonPreview(json)}`)
  return json.map((raw: any) => ({
    hostIp: String(raw.host_ip ?? "127.0.0.1"),
    hostPort: requireNumber(raw.host_port, "host_port"),
    sandboxPort: requireNumber(raw.sandbox_port, "sandbox_port"),
    protocol: String(raw.protocol ?? "tcp4"),
  }))
}

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\")
}
function realpathNearest(p: string, windows: boolean): string {
  const dirnameFn = windows ? win32.dirname : dirname
  const basenameFn = windows ? win32.basename : basename
  const joinFn = windows ? win32.join : join
  let current = p
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return rest.length ? joinFn(real, ...rest.reverse()) : real
    } catch {
      const parent = dirnameFn(current)
      if (parent === current) return p
      rest.push(basenameFn(current))
      current = parent
    }
  }
}
function canon(p: string): string {
  if (isWindowsPath(p)) {
    const resolved = win32.normalize(win32.resolve(p))
    return realpathNearest(resolved, true).toLowerCase()
  }
  const resolved = resolve(p)
  return realpathNearest(resolved, false).toLowerCase()
}
export function isPathInside(root: string, target: string): boolean {
  const sep = isWindowsPath(root) || isWindowsPath(target) ? "\\" : "/"
  const r = canon(root), t = canon(target)
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

export function pathsOverlap(a: string, b: string): boolean {
  return isPathInside(a, b) || isPathInside(b, a)
}

export function isSensitivePath(target: string, forbidden: string[]): boolean {
  return forbidden.some((f) => f !== "" && pathsOverlap(f, target))
}

export function defaultForbiddenPaths(dataDir?: string): string[] {
  const paths = [process.cwd()]
  if (dataDir) paths.push(resolve(dataDir))
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) {
    const h = resolve(home)
    for (const sub of [".ssh", ".aws", ".gnupg", ".config", ".docker", ".kube", ".azure", ".npmrc", ".netrc", ".celly", "AppData"]) {
      paths.push(join(h, sub))
    }
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    paths.push(systemRoot, `${systemRoot}\\System32`, process.env.ProgramFiles ?? "C:\\Program Files", process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", process.env.ProgramData ?? "C:\\ProgramData")
  } else {
    paths.push("/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/System", "/Library")
  }
  return paths
}

export interface CreateOpts { name: string; directory: string; hostPort: number; cpus: number; memory: string; template?: string }
export function validateCreateOpts(o: CreateOpts): void {
  if (!Number.isInteger(o.hostPort) || o.hostPort < 1 || o.hostPort > 65535) throw new SbxError(`invalid hostPort: ${String(o.hostPort)}`)
  if (!Number.isInteger(o.cpus) || o.cpus < 0) throw new SbxError(`invalid cpus: ${String(o.cpus)}`)
}
export class Sbx {
  constructor(private readonly runner: SbxRunner, private readonly template = "opencode") {}
  private async must(args: string[], timeoutMs?: number) {
    const r = await this.runner.run(args, timeoutMs ? { timeoutMs } : {})
    if (r.code !== 0) throw new SbxError(`sbx ${args[0]} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
    return r
  }
  async list() { const r = await this.must(["ls", "--json"]); return parseSbxLs(parseJson(r.stdout, "ls --json")) }
  async ports(name: string) { const r = await this.must(["ports", name, "--json"]); return parseSbxPorts(parseJson(r.stdout, "ports --json")) }
  async publish(name: string, mapping: string, opts: { timeoutMs?: number } = {}) { await this.must(["ports", name, "--publish", mapping], opts.timeoutMs) }
  async create(o: CreateOpts) {
    validateCreateOpts(o)
    await this.must(["create", o.template ?? this.template, o.directory, "--name", o.name, "--publish", `${o.hostPort}:4096`, "--cpus", String(o.cpus), "--memory", o.memory])
  }
  async exec(name: string, args: string[], opts: { timeoutMs?: number } = {}) { return this.must(["exec", name, ...args], opts.timeoutMs) }
  async home(name: string): Promise<string> {
    const r = await this.must(["exec", name, "bash", "-lc", 'printf %s "$HOME"'])
    const home = r.stdout.trim()
    if (!home.startsWith("/")) throw new SbxError(`could not resolve sandbox HOME (got "${home}")`)
    return home
  }
  execStream(name: string, argv: string[]) { return this.runner.spawnStream(["exec", name, ...argv]) }
  async cp(from: string, to: string) { await this.must(["cp", from, to]) }
  async stop(name: string) { await this.must(["stop", name]) }
  async start(name: string) { await this.must(["exec", name, "true"]) }
  async remove(name: string) { await this.must(["rm", "--force", name]) }
}

export async function allocatePort(o: { start: number; end: number; used: Set<number>; isFree(p: number): Promise<boolean> }): Promise<number> {
  for (let p = o.start; p <= o.end; p++) {
    if (o.used.has(p)) continue
    if (await o.isFree(p)) return p
  }
  throw new SbxError(`no free host port in ${o.start}-${o.end} (exhausted)`)
}

const RESERVED = new Set([
  "con", "prn", "aux", "nul", "conin$", "conout$",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
])
export function sanitizeAttachmentName(name: string): string {
  if (name.includes("/")) throw new Error("attachment name must not contain separators")
  const base = basename(name.replace(/\\/g, "/"))
  if (!base || base === "." || base === ".." || base.includes("..")) throw new Error("invalid attachment name")
  if (/[<>:"|?*\u0000-\u001f]/.test(base)) throw new Error("invalid attachment name")
  const stem = base.replace(/\..*$/, "").replace(/[. ]+$/g, "").toLowerCase()
  if (RESERVED.has(stem)) throw new Error("reserved name")
  const result = base.replace(/[. ]+$/g, "")
  if (!result) throw new Error("invalid attachment name")
  return result
}

export function sanitizeProjectDirName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/g, "")
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("invalid project name")
  return cleaned
}
