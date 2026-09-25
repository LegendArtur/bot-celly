// src/sbx.ts
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { basename, resolve, win32 } from "node:path"

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
function canon(p: string): string {
  if (isWindowsPath(p)) {
    const resolved = win32.normalize(win32.resolve(p))
    try { return realpathSync.native(resolved).toLowerCase() } catch { return resolved.toLowerCase() }
  }
  const resolved = resolve(p)
  try { return realpathSync.native(resolved).toLowerCase() } catch { return resolved.toLowerCase() }
}
export function isPathInside(root: string, target: string): boolean {
  const sep = isWindowsPath(root) || isWindowsPath(target) ? "\\" : "/"
  const r = canon(root), t = canon(target)
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

const RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"])
export function sanitizeAttachmentName(name: string): string {
  if (name.includes("/")) throw new Error("attachment name must not contain separators")
  const base = basename(name.replace(/\\/g, "/"))
  if (!base || base === "." || base === ".." || base.includes("..")) throw new Error("invalid attachment name")
  if (/[<>:"|?*\u0000-\u001f]/.test(base)) throw new Error("invalid attachment name")
  if (RESERVED.has(basename(base, win32.extname(base)).toLowerCase())) throw new Error("reserved name")
  return base.replace(/[. ]+$/g, "")
}
