import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { rotateIfNeeded } from "../src/rotate.ts"
import { withTempDir } from "./helpers/tmp.ts"

test("does nothing when the file is missing or under maxBytes", async () => {
  await withTempDir("celly-rotate-", (dir) => {
    const file = join(dir, "bot.log")
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    writeFileSync(file, "small")
    expect(rotateIfNeeded(file, { maxBytes: 10, maxFiles: 2 })).toBe(false)
    expect(existsSync(`${file}.1`)).toBe(false)
  })
})

test("shifts the file to .1 and older copies upward", async () => {
  await withTempDir("celly-rotate-", (dir) => {
    const file = join(dir, "bot.log")
    writeFileSync(file, "first")
    expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 3 })).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("first")
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, "second")
    expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 3 })).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("second")
    expect(readFileSync(`${file}.2`, "utf8")).toBe("first")
  })
})

test("drops copies beyond maxFiles", async () => {
  await withTempDir("celly-rotate-", (dir) => {
    const file = join(dir, "bot.log")
    for (const content of ["one", "two", "three"]) {
      writeFileSync(file, content)
      expect(rotateIfNeeded(file, { maxBytes: 1, maxFiles: 2 })).toBe(true)
    }
    expect(readFileSync(`${file}.1`, "utf8")).toBe("three")
    expect(readFileSync(`${file}.2`, "utf8")).toBe("two")
    expect(existsSync(`${file}.3`)).toBe(false)
  })
})
