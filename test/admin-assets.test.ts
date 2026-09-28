import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { isAllowedAsset, readAsset } from "../src/admin/assets.ts"

test("the vendored admin assets are present and identifiable", () => {
  const htmx = readFileSync("assets/admin/htmx.min.js", "utf8")
  const sse = readFileSync("assets/admin/hx-sse.min.js", "utf8")
  expect(htmx).toContain("htmx")
  expect(sse.toLowerCase()).toContain("sse")
  expect(htmx.length).toBeGreaterThan(10_000)
  expect(sse.length).toBeGreaterThan(1_000)
})

test("readAsset serves only allowlisted files with content types", () => {
  expect(isAllowedAsset("app.css")).toBe(true)
  expect(isAllowedAsset("app.js")).toBe(true)
  expect(isAllowedAsset("htmx.min.js")).toBe(true)
  expect(isAllowedAsset("hx-sse.min.js")).toBe(true)
  expect(isAllowedAsset("package.json")).toBe(false)
  expect(isAllowedAsset("../package.json")).toBe(false)
  expect(isAllowedAsset("..%2Fpackage.json")).toBe(false)

  const css = readAsset("app.css")
  expect(css?.contentType).toBe("text/css; charset=utf-8")
  expect(css?.body.toString("utf8")).toContain("--bg")
  expect(readAsset("nope.js")).toBeUndefined()
  expect(readAsset("../package.json")).toBeUndefined()
})
