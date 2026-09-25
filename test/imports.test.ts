// test/imports.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"

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
  const offenders = files.filter(
    (f) => f !== "src/sbx.ts" && /from\s+["'](node:)?child_process["']/.test(readFileSync(f, "utf8")),
  )
  expect(offenders).toEqual([])
})
