import { expect, test } from "vitest"
import { createUi, symbols } from "../src/cli/ui.ts"

function collector() {
  let text = ""
  return { stream: { write: (chunk: string) => { text += chunk; return true } } as unknown as NodeJS.WritableStream, get: () => text }
}

test("symbols fall back to single-glyph ASCII so columns stay aligned", () => {
  expect(symbols(true)).toEqual({ ok: "+", fail: "x", warn: "!", info: "i", pointer: ">" })
  expect(symbols(false)).toEqual({ ok: "✓", fail: "✗", warn: "!", info: "·", pointer: "›" })
})

test("rows align labels under a shared column and hang the fix below", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: false, ascii: false })
  ui.rows([
    { kind: "ok", label: "Node", detail: "v24.0.0" },
    { kind: "fail", label: "Policy", detail: "not initialized", fix: "run sbx policy init balanced" },
  ])
  const text = sink.get()
  expect(text).toContain("  ✓  Node    v24.0.0")
  expect(text).toContain("  ✗  Policy  not initialized")
  expect(text).toContain("→ run sbx policy init balanced")
})

test("symbols are coloured when colour is on", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: true, ascii: false })
  ui.status("ok", "Node")
  const text = sink.get()
  expect(text).toContain("\x1b[")
  expect(text).toContain("\x1b[32m✓\x1b[0m")
})

test("plain output has no ANSI and uses ASCII glyphs", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: false, ascii: true })
  ui.heading("Celly")
  ui.rule()
  ui.bullet("hello")
  ui.hint("hidden")
  ui.status("warn", "Provider secret")
  const text = sink.get()
  expect(text).not.toContain("\x1b[")
  expect(text).toContain("> hello")
  expect(text).toContain("  hidden")
  expect(text).toContain("!  Provider secret")
})

test("createUi derives color and ascii from env by default", () => {
  const colored = collector()
  createUi({ out: colored.stream, env: { FORCE_COLOR: "1" } }).status("ok", "Node")
  expect(colored.get()).toContain("\x1b[")
  expect(colored.get()).toContain("✓")

  const plain = collector()
  createUi({ out: plain.stream, env: { FORCE_COLOR: "0" } }).status("ok", "Node")
  expect(plain.get()).not.toContain("\x1b[")
  expect(plain.get()).toContain("+  Node")

  const forcedAscii = collector()
  createUi({ out: forcedAscii.stream, env: { FORCE_COLOR: "1", CELLY_ASCII: "1" } }).status("ok", "Node")
  expect(forcedAscii.get()).toContain("\x1b[")
  expect(forcedAscii.get()).toContain("\x1b[32m+\x1b[0m")
})
