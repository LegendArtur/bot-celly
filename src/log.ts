import { appendFileSync, writeFileSync } from "node:fs"
import { rotateIfNeeded } from "./rotate.js"
import { ANSI, colorEnabled, paint } from "./ansi.js"
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
const LEVEL_LABEL: Record<Level, string> = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" }
const LEVEL_COLOR: Record<Level, string> = { debug: ANSI.gray, info: ANSI.cyan, warn: ANSI.yellow, error: ANSI.red }

function formatFieldValue(value: unknown): string {
  if (typeof value === "string") {
    if (value.includes("\n")) return value.replace(/\n/g, "\n    ")
    if (value === "" || /\s/.test(value)) return JSON.stringify(value)
    return value
  }
  if (value === null) return "null"
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((item) => formatFieldValue(item)).join(",")
  if (typeof value === "object") return safeStringify(value)
  return String(value)
}

export interface LogRecord {
  ts: Date
  level: Level
  msg: string
  fields?: Record<string, unknown>
}

/** Human-readable line for the console; the file sink keeps the JSON form. */
export function formatLogLine(record: LogRecord, opts: { color: boolean }): string {
  const date = record.ts
  const pad = (n: number): string => String(n).padStart(2, "0")
  const tone = (code: string, text: string): string => paint(code, text, opts.color)
  const time = tone(ANSI.gray, `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`)
  const label = tone(LEVEL_COLOR[record.level], LEVEL_LABEL[record.level].padEnd(5))
  const fields = record.fields ?? {}
  const rendered: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (key === "error" || value === undefined) continue
    rendered.push(`${key}=${formatFieldValue(value)}`)
  }
  if (fields.error !== undefined) rendered.push(tone(ANSI.red, `error=${formatFieldValue(fields.error)}`))
  const head = `${time}  ${label}  ${record.msg}`
  return rendered.length === 0 ? head : `${head}  ${rendered.join(" ")}`
}
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}
export interface LoggerOptions {
  level: string
  file?: string
  secrets?: string[]
  truncate?: boolean
  maxBytes?: number
  maxFiles?: number
  pretty?: boolean
  color?: boolean
}
export function createLogger(opts: LoggerOptions): Logger {
  const min = (order[opts.level as Level] ?? 1)
  const secrets = opts.secrets ?? []
  const pretty = opts.pretty ?? Boolean(process.stdout.isTTY)
  const color = opts.color ?? colorEnabled()
  if (opts.truncate && opts.file) {
    try { writeFileSync(opts.file, "") } catch (err) { console.error(`log truncate failed: ${String(err)}`) }
  }
  let writtenSinceRotate = 0
  const rotateForAppend = (bytes: number): void => {
    if (!opts.file || !opts.maxBytes || !opts.maxFiles) return
    writtenSinceRotate += bytes
    if (writtenSinceRotate < opts.maxBytes) return
    writtenSinceRotate = 0
    try { rotateIfNeeded(opts.file, { maxBytes: opts.maxBytes, maxFiles: opts.maxFiles }) } catch (err) { console.error(`log rotate failed: ${String(err)}`) }
  }
  const build = (bound: Record<string, unknown>): Logger => {
    // The redacted JSON form is authoritative for both sinks; the console only
    // re-parses it so pretty output can never leak a secret the file would hide.
    const prettyLine = (json: string, ts: Date): string | undefined => {
      try {
        const parsed = JSON.parse(json) as { level?: unknown; msg?: unknown } & Record<string, unknown>
        const { ts: _ts, level, msg, ...fields } = parsed
        return formatLogLine({ ts, level: level as Level, msg: String(msg ?? ""), fields }, { color })
      } catch { return undefined }
    }
    const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
      if (order[level] < min) return
      const now = new Date()
      let line: string
      try {
        line = redact(safeStringify({ ts: now.toISOString(), level, msg, ...bound, ...fields }), secrets)
      } catch {
        line = redact(JSON.stringify({ ts: now.toISOString(), level, msg, error: "unserializable fields" }), secrets)
      }
      console[level === "debug" ? "log" : level](pretty ? prettyLine(line, now) ?? line : line)
      if (opts.file) {
        rotateForAppend(Buffer.byteLength(line) + 1)
        try { appendFileSync(opts.file, line + "\n") } catch (err) { console.error(`log append failed: ${String(err)}`) }
      }
    }
    return {
      debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f),
      child: (f) => build({ ...bound, ...f }),
    }
  }
  return build({})
}
