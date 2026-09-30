import { expect, test } from "vitest"
import { colorEnabled } from "../src/ansi.ts"

test("colorEnabled honors TTY, NO_COLOR, FORCE_COLOR, and TERM=dumb", () => {
  expect(colorEnabled({}, true)).toBe(true)
  expect(colorEnabled({}, false)).toBe(false)
  expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false)
  expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true)
  expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true)
  expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false)
  expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false)
  expect(colorEnabled({ TERM: "dumb", FORCE_COLOR: "1" }, false)).toBe(true)
})
