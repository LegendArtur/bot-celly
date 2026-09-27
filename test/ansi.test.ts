import { expect, test } from "vitest"
import { colorEnabled } from "../src/ansi.ts"

test("colorEnabled honors TTY, NO_COLOR, and FORCE_COLOR", () => {
  expect(colorEnabled({}, true)).toBe(true)
  expect(colorEnabled({}, false)).toBe(false)
  expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false)
  expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true)
  expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true)
  expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false)
})
