import { appendFileSync } from "node:fs"
const SECRET_KEY = /("(?:authorization|password|token|secret)"\s*:\s*)("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gi
const AUTH_HEADER = /(authorization\s*:\s*)(?:bearer|basic)\s+[^\s"]+/gi
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    if (!s) continue
    out = out.split(s).join("[redacted]")
    const escaped = JSON.stringify(s).slice(1, -1)
    if (escaped !== s) out = out.split(escaped).join("[redacted]")
  }
  out = out.replace(SECRET_KEY, '$1"[redacted]"')
  out = out.replace(AUTH_HEADER, "$1[redacted]")
  return out
}
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  const out = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return v.toString()
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[circular]"
      seen.add(v)
    }
    return v
  })
  return out ?? "null"
}
type Level = "debug" | "info" | "warn" | "error"
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}
export function createLogger(opts: { level: string; file?: string; secrets?: string[] }): Logger {
  const min = (order[opts.level as Level] ?? 1)
  const build = (bound: Record<string, unknown>): Logger => {
    const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
      if (order[level] < min) return
      let line: string
      try {
        line = redact(safeStringify({ ts: new Date().toISOString(), level, msg, ...bound, ...fields }), opts.secrets ?? [])
      } catch {
        line = redact(JSON.stringify({ ts: new Date().toISOString(), level, msg, error: "unserializable fields" }), opts.secrets ?? [])
      }
      console[level === "debug" ? "log" : level](line)
      if (opts.file) try { appendFileSync(opts.file, line + "\n") } catch (err) { console.error(`log append failed: ${String(err)}`) }
    }
    return {
      debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f),
      child: (f) => build({ ...bound, ...f }),
    }
  }
  return build({})
}
