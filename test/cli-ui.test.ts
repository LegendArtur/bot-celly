import { expect, test } from "vitest"
import { createUi, symbols } from "../src/cli/ui.ts"

function collector() {
  let text = ""
  return { stream: { write: (chunk: string) => { text += chunk; return true } } as unknown as NodeJS.WritableStream, get: () => text }
}

test("symbols fall back to ASCII", () => {
  expect(symbols(true)).toEqual({ ok: "[ok]", fail: "[x]", warn: "[!]", info: "[i]", pointer: ">" })
  expect(symbols(false)).toEqual({ ok: "✓", fail: "✗", warn: "!", info: "i", pointer: "›" })
})

test("color output uses ANSI and unicode symbols", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: true, ascii: false })
  ui.heading("Celly doctor")
  ui.status("ok", "Node — v24.0.0")
  ui.status("fail", "sbx", "install it")
  const text = sink.get()
  expect(text).toContain("\x1b[")
  expect(text).toContain("\x1b[32m✓ Node — v24.0.0\x1b[0m")
  expect(text).toContain("\x1b[31m✗ sbx\x1b[0m")
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
  expect(text).toContain("  hidden")
  expect(text).toContain("[!] Provider secret")
})

test("createUi derives color and ascii from env by default", () => {
  const colored = collector()
  const colorUi = createUi({ out: colored.stream, env: { FORCE_COLOR: "1" } })
  colorUi.status("ok", "Node")
  const colorText = colored.get()
  expect(colorText).toContain("\x1b[")
  expect(colorText).toContain("✓")

  const plain = collector()
  const plainUi = createUi({ out: plain.stream, env: { FORCE_COLOR: "0" } })
  plainUi.status("ok", "Node")
  const plainText = plain.get()
  expect(plainText).not.toContain("\x1b[")
  expect(plainText).toContain("[ok]")

  const forcedAscii = collector()
  const asciiUi = createUi({ out: forcedAscii.stream, env: { FORCE_COLOR: "1", CELLY_ASCII: "1" } })
  asciiUi.status("ok", "Node")
  const asciiText = forcedAscii.get()
  expect(asciiText).toContain("\x1b[")
  expect(asciiText).toContain("[ok]")
})
