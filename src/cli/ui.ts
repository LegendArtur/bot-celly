import { ANSI, colorEnabled, paint } from "../ansi.js"

export type StatusKind = "ok" | "fail" | "warn" | "info"

export interface Symbols {
  ok: string
  fail: string
  warn: string
  info: string
  pointer: string
}

export function symbols(ascii: boolean): Symbols {
  return ascii
    ? { ok: "[ok]", fail: "[x]", warn: "[!]", info: "[i]", pointer: ">" }
    : { ok: "✓", fail: "✗", warn: "!", info: "i", pointer: "›" }
}

const STYLE: Record<StatusKind, { tone: string; symbol: keyof Symbols }> = {
  ok: { tone: ANSI.green, symbol: "ok" },
  fail: { tone: ANSI.red, symbol: "fail" },
  warn: { tone: ANSI.yellow, symbol: "warn" },
  info: { tone: ANSI.cyan, symbol: "info" },
}

export interface Ui {
  heading(text: string): void
  bullet(text: string): void
  hint(text: string): void
  status(kind: StatusKind, label: string, detail?: string): void
}

export interface UiOptions {
  out?: NodeJS.WritableStream
  color?: boolean
  ascii?: boolean
  env?: NodeJS.ProcessEnv
}

export function createUi(options: UiOptions = {}): Ui {
  const out = options.out ?? process.stdout
  const env = options.env ?? process.env
  const color = options.color ?? colorEnabled(env)
  const ascii = options.ascii ?? (env.CELLY_ASCII === "1" || !color)
  const marks = symbols(ascii)
  const write = (line: string): void => { out.write(`${line}\n`) }
  return {
    heading: (text) => write(paint(`${ANSI.bold}${ANSI.cyan}`, text, color)),
    bullet: (text) => write(`${paint(ANSI.dim, marks.pointer, color)} ${text}`),
    hint: (text) => write(paint(ANSI.dim, `  ${text}`, color)),
    status: (kind, label, detail) => {
      const style = STYLE[kind]
      const head = paint(style.tone, `${marks[style.symbol]} ${label}`, color)
      write(detail ? `${head}\n${paint(ANSI.dim, `    ${detail}`, color)}` : head)
    },
  }
}
