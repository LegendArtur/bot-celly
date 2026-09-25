// test/imports.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"

const CHILD_PROCESS_IMPORT = /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\(\s*|\bimport\s+)["'](?:node:)?child_process["']/

test("only sbx.ts imports child_process", () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith(".ts")) files.push(p)
    }
  }
  walk("src")
  const allowed = "src/sbx.ts"
  const offenders = files
    .map((f) => ({ f, normalized: f.split("\\").join("/") }))
    .filter(({ normalized }) => normalized !== allowed)
    .filter(({ f }) => CHILD_PROCESS_IMPORT.test(readFileSync(f, "utf8")))
    .map(({ normalized }) => normalized)
  expect(offenders).toEqual([])
})

test("the child_process matcher catches every import form", () => {
  const samples = [
    `import { spawn } from "node:child_process"`,
    `import { spawn } from "child_process"`,
    `import "node:child_process"`,
    `const cp = await import("node:child_process")`,
    `const cp = require("child_process")`,
  ]
  for (const s of samples) expect(CHILD_PROCESS_IMPORT.test(s)).toBe(true)
})
