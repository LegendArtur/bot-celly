import { appendFileSync } from "node:fs"
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]")
  out = out.replace(/(authorization)\s*:\s*(bearer|basic)\s+\S+/gi, "$1: [redacted]")
  return out
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
      const line = redact(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...bound, ...fields }), opts.secrets ?? [])
      console[level === "debug" ? "log" : level](line)
      if (opts.file) try { appendFileSync(opts.file, line + "\n") } catch {}
    }
    return {
      debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f),
      child: (f) => build({ ...bound, ...f }),
    }
  }
  return build({})
}
