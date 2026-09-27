import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { rotateIfNeeded } from "../src/rotate.ts"

test("does nothing when the file is missing or under maxBytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-rotate-"))
  const file = join(dir, "bot.log")
  try {
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    writeFileSync(file, "small")
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    expect(existsSync(`${file}.1`)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("shifts the file to .1 and older copies upward", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-rotate-"))
  const file = join(dir, "bot.log")
  try {
    writeFileSync(file, "first")
    expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 3 })).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("first")
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, "second")
    expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 3 })).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("second")
    expect(readFileSync(`${file}.2`, "utf8")).toBe("first")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("drops copies beyond maxFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-rotate-"))
  const file = join(dir, "bot.log")
  try {
    for (const content of ["one", "two", "three"]) {
      writeFileSync(file, content)
      expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 2 })).toBe(true)
    }
    expect(readFileSync(`${file}.1`, "utf8")).toBe("three")
    expect(readFileSync(`${file}.2`, "utf8")).toBe("two")
    expect(existsSync(`${file}.3`)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
