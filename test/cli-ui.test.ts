import { expect, test } from "vitest"
import { createUi, symbols } from "../src/cli/ui.ts"

function collector() {
  let text = ""
  return { stream: { write: (chunk: string) => { text += chunk; return true } } as unknown as NodeJS.WritableStream, get: () => text }
}

test("symbols fall back to ASCII", () => {
  expect(symbols(true)).toEqual({ ok: "[ok]", fail: "[x]", warn: "[!]", info: "[i]", pointer: ">" })
  expect(symbols(false).ok).toBe("✓")
})

test("color output uses ANSI and unicode symbols", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: true, ascii: false })
  ui.heading("Celly doctor")
  ui.status("ok", "Node — v24.0.0")
  ui.status("fail", "sbx", "install it")
  const text = sink.get()
  expect(text).toContain("\x1b[")
  expect(text).toContain("✓ Node — v24.0.0")
  expect(text).toContain("✗ sbx")
  expect(text).toContain("install it")
})

test("plain output has no ANSI", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: false, ascii: true })
  ui.heading("Celly")
  ui.bullet("hello")
  ui.hint("hidden")
  ui.status("warn", "Provider secret")
  const text = sink.get()
  expect(text).not.toContain("\x1b[")
  expect(text).toContain("> hello")
  expect(text).toContain("[!] Provider secret")
})
