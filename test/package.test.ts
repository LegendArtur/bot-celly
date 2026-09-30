import { existsSync, readFileSync } from "node:fs"
import { expect, test } from "vitest"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>

test("is publishable as bot-celly", () => {
  expect(pkg.name).toBe("bot-celly")
  expect(pkg.private).not.toBe(true)
  expect(pkg.bin).toEqual({ "bot-celly": "dist/cli.js" })
  expect(pkg.files).toEqual(["dist", "assets"])
  expect(pkg.publishConfig).toEqual({ access: "public" })
  expect(pkg.engines).toEqual({ node: ">=24 <25" })
  expect(pkg.license).toBe("MIT")
  expect((pkg.repository as { url: string }).url).toBe("git+https://github.com/LegendArtur/bot-celly.git")
})

test("ships the admin assets the server reads from the package root", () => {
  expect(existsSync(new URL("../assets/admin/htmx.min.js", import.meta.url))).toBe(true)
})

test("the bin target is built from src/cli.ts", () => {
  expect(existsSync(new URL("../src/cli.ts", import.meta.url))).toBe(true)
})
