// src/sbx.ts
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve, win32 } from "node:path"

export interface RunResult { code: number; stdout: string; stderr: string }
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
  let base = `cely-${slugify(name)}`.replace(/[-.]+$/g, "")
  if (base.length > 63) base = base.slice(0, 63).replace(/[-.]+$/g, "")
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 63 - String(i).length - 1)}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

export function parseSbxLs(json: unknown) {
  if (!Array.isArray(json)) throw new Error("sbx ls --json: expected array")
  return json.map((raw: any) => ({
    name: String(raw.name),
    agent: String(raw.agent ?? ""),
    status: String(raw.status ?? ""),
    hostPort: Array.isArray(raw.ports) && raw.ports[0] ? Number(raw.ports[0].host_port) : undefined,
    workspace: raw.workspace === undefined ? undefined : String(raw.workspace),
  }))
}
export function parseSbxPorts(json: unknown) {
  if (!Array.isArray(json)) throw new Error("sbx ports --json: expected array")
  return json.map((raw: any) => ({
    hostIp: String(raw.host_ip ?? "127.0.0.1"),
    hostPort: Number(raw.host_port),
    sandboxPort: Number(raw.sandbox_port),
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
