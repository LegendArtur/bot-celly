import { ANSI, colorEnabled, paint } from "../ansi.js"

export type StatusKind = "ok" | "fail" | "warn" | "info"

export interface Symbols {
  ok: string
  fail: string
  warn: string
  info: string
  pointer: string
  arrow: string
  rule: string
}

export function symbols(ascii: boolean): Symbols {
  return ascii
    ? { ok: "+", fail: "x", warn: "!", info: "i", pointer: ">", arrow: "->", rule: "-" }
    : { ok: "✓", fail: "✗", warn: "!", info: "·", pointer: "›", arrow: "→", rule: "─" }
}

const STYLE: Record<StatusKind, { tone: string; symbol: keyof Symbols }> = {
  ok: { tone: ANSI.green, symbol: "ok" },
  fail: { tone: ANSI.red, symbol: "fail" },
  warn: { tone: ANSI.yellow, symbol: "warn" },
  info: { tone: ANSI.cyan, symbol: "info" },
}

export interface UiRow {
  kind: StatusKind
  label: string
  detail?: string
  fix?: string
}

export interface Ui {
  heading(text: string): void
  rule(width?: number): void
  bullet(text: string): void
  hint(text: string): void
  status(kind: StatusKind, label: string, detail?: string): void
  rows(items: UiRow[]): void
}

export interface UiOptions {
  out?: NodeJS.WritableStream
  color?: boolean
  ascii?: boolean
  env?: NodeJS.ProcessEnv
}

const INDENT = "  "
const GAP = 2

export function createUi(options: UiOptions = {}): Ui {
  const out = options.out ?? process.stdout
  const env = options.env ?? process.env
  const color = options.color ?? colorEnabled(env)
  const ascii = options.ascii ?? (env.CELLY_ASCII === "1" || !color)
  const marks = symbols(ascii)
  const write = (line: string): void => { out.write(`${line}\n`) }

  const rows = (items: UiRow[]): void => {
    if (items.length === 0) return
    const width = Math.max(...items.map((item) => item.label.length))
    const detailColumn = INDENT.length + 1 + GAP + width + GAP
    for (const item of items) {
      const style = STYLE[item.kind]
      const symbol = paint(style.tone, marks[style.symbol], color)
      const label = paint(ANSI.bold, item.label.padEnd(width), color)
      const detail = item.detail ? `${" ".repeat(GAP)}${paint(ANSI.dim, item.detail, color)}` : ""
      write(`${INDENT}${symbol}${" ".repeat(GAP)}${label}${detail}`)
      if (item.fix) write(`${" ".repeat(detailColumn)}${paint(ANSI.dim, `${marks.arrow} ${item.fix}`, color)}`)
    }
  }

  return {
    heading: (text) => write(`${INDENT}${paint(`${ANSI.bold}${ANSI.cyan}`, text, color)}`),
    rule: (width = 44) => write(`${INDENT}${paint(ANSI.dim, marks.rule.repeat(width), color)}`),
    bullet: (text) => write(`${INDENT}${paint(ANSI.dim, marks.pointer, color)} ${text}`),
    hint: (text) => write(paint(ANSI.dim, `${INDENT}${text}`, color)),
    status: (kind, label, detail) => rows([detail ? { kind, label, detail } : { kind, label }]),
    rows,
  }
}
