// test/sbx.test.ts
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { SbxRunner, buildSandboxName, isPathInside, isSensitivePath, parseSbxLs, parseSbxPorts, sanitizeAttachmentName, sanitizeProjectDirName, slugify } from "../src/sbx.ts"
import ls from "./fixtures/sbx-ls.json"
import ports from "./fixtures/sbx-ports.json"

test("slugify keeps only [a-z0-9-]", () => {
  expect(slugify("My Web_App!" )).toBe("my-web-app")
})
test("sandbox names cap at 63 and trim trailing separators", () => {
  const n = buildSandboxName("a".repeat(80), new Set())
  expect(n.startsWith("cely-")).toBe(true)
  expect(n.length).toBeLessThanOrEqual(63)
  expect(n.endsWith("-")).toBe(false)
})
test("sandbox names dedupe against taken set", () => {
  expect(buildSandboxName("demo", new Set(["cely-demo"]))).toBe("cely-demo-2")
})
test("parses sbx ls fixtures", () => {
  expect(parseSbxLs(ls)).toEqual([{ name: "cely-spike", agent: "opencode", status: "running", hostPort: 4399, workspace: "C:\\Users\\artur\\projects\\spike" }])
})
test("parses sbx ports fixtures", () => {
  expect(parseSbxPorts(ports)).toEqual([{ hostIp: "127.0.0.1", hostPort: 4399, sandboxPort: 4096, protocol: "tcp4" }])
})
test("path containment is case-insensitive and rejects traversal", () => {
  expect(isPathInside("C:\\projects", "C:\\projects\\demo\\src")).toBe(true)
  expect(isPathInside("C:\\projects", "C:\\PROJECTS\\Demo")).toBe(true)
  expect(isPathInside("C:\\projects", "C:\\projects\\..\\Windows")).toBe(false)
})
test("path containment handles POSIX-style paths and boundaries", () => {
  expect(isPathInside("/srv/projects", "/srv/projects/demo/src")).toBe(true)
  expect(isPathInside("/srv/projects", "/srv/projects/../Windows")).toBe(false)
  expect(isPathInside("/srv/projects", "/srv/projects-evil")).toBe(false)
})
test("SbxRunner passes argv without a shell", async () => {
  const r = new SbxRunner(process.execPath)
  const out = await r.run(["-e", "console.log(process.argv[1])", "literal ; && $(echo pwned)"])
  expect(out.code).toBe(0)
  expect(out.stdout.trim()).toBe("literal ; && $(echo pwned)")
})
test("attachment names are basenamed and special names rejected", () => {
  expect(sanitizeAttachmentName("..\\..\\evil.txt")).toBe("evil.txt")
  expect(() => sanitizeAttachmentName("CON")).toThrow()
  expect(() => sanitizeAttachmentName("a/b.txt")).toThrow()
})
test("dot/space-only attachment names are rejected", () => {
  expect(() => sanitizeAttachmentName(" . ")).toThrow()
  expect(() => sanitizeAttachmentName("   ")).toThrow()
  expect(() => sanitizeAttachmentName("...")).toThrow()
})
test("reserved device names are rejected after trimming", () => {
  expect(() => sanitizeAttachmentName("COM5")).toThrow()
  expect(() => sanitizeAttachmentName("LPT9")).toThrow()
  expect(() => sanitizeAttachmentName("con .txt")).toThrow()
  expect(() => sanitizeAttachmentName("com1.tar.gz")).toThrow()
  expect(() => sanitizeAttachmentName("conin$")).toThrow()
})
test("path containment resolves symlinked ancestors", () => {
  const root = mkdtempSync(join(tmpdir(), "cely-root-"))
  const outside = mkdtempSync(join(tmpdir(), "cely-out-"))
  try {
    symlinkSync(outside, join(root, "link"))
    expect(isPathInside(root, join(root, "link", "sub", "file.txt"))).toBe(false)
    expect(isPathInside(root, join(root, "nested", "file.txt"))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("project directory names are sanitized without allowing traversal", () => {
  expect(sanitizeProjectDirName("My Web App")).toBe("My Web App")
  expect(sanitizeProjectDirName("  spaced  ")).toBe("spaced")
  expect(sanitizeProjectDirName("a/../b")).toBe("a-..-b")
  expect(() => sanitizeProjectDirName("..")).toThrow()
  expect(() => sanitizeProjectDirName("   ")).toThrow()
})

test("isSensitivePath rejects ancestors and descendants of forbidden roots", () => {
  expect(isSensitivePath("/srv/projects/demo/data/x", ["/srv/projects/demo/data"])).toBe(true)
  expect(isSensitivePath("/srv", ["/srv/projects"])).toBe(true)
  expect(isSensitivePath("/srv/projects/demo", ["/srv/projects/other"])).toBe(false)
  expect(isSensitivePath("C:\\projects\\demo", ["C:\\projects\\demo\\secret"])).toBe(true)
})
