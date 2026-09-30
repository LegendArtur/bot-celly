import { expect, test } from "vitest"
import { hasHardFailure, reportDoctor, runDoctor, satisfiesNode } from "../src/cli/doctor.ts"
import { createUi } from "../src/cli/ui.ts"

const baseEnv = { DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "123456789012345678" }
const okSbx = async (args: string[]) => ({ code: 0, stdout: args[0] === "version" ? "sbx 0.45.0\n" : "balanced\n", stderr: "" })

test("satisfiesNode only accepts major 24", () => {
  expect(satisfiesNode("24.0.0")).toBe(true)
  expect(satisfiesNode("24.11.3")).toBe(true)
  expect(satisfiesNode("22.22.1")).toBe(false)
  expect(satisfiesNode("25.0.0")).toBe(false)
})

test("all checks pass on a healthy host", async () => {
  const results = await runDoctor({
    env: baseEnv,
    home: "/home/u/.bot-celly",
    dataDir: "/home/u/.bot-celly/data",
    nodeVersion: "24.1.0",
    runSbx: okSbx,
    mkdir: () => {},
  })
  expect(hasHardFailure(results)).toBe(false)
  expect(results.filter((r) => r.kind === "hard").every((r) => r.ok)).toBe(true)
  expect(results.some((r) => r.kind === "advisory")).toBe(true)
})

test("reports the node failure with a fix", async () => {
  const results = await runDoctor({ env: baseEnv, home: "/h", dataDir: "/h/data", nodeVersion: "22.0.0", runSbx: okSbx, mkdir: () => {} })
  const node = results.find((r) => r.name === "Node")!
  expect(node.ok).toBe(false)
  expect(node.fix).toContain("fnm install 24")
  expect(hasHardFailure(results)).toBe(true)
})

test("reports missing sbx, uninitialized policy, and missing config", async () => {
  const failSbx = async (args: string[]) => args[0] === "version"
    ? { code: 127, stdout: "", stderr: "not found" }
    : { code: 1, stdout: "", stderr: "no policy" }
  const results = await runDoctor({ env: {}, home: "/h", dataDir: "/h/data", nodeVersion: "24.0.0", runSbx: failSbx, mkdir: () => {} })
  expect(results.find((r) => r.name === "sbx")!.fix).toContain("winget install")
  expect(results.find((r) => r.name === "Policy")!.fix).toContain("sbx policy init balanced")
  expect(results.find((r) => r.name === "Config")!.ok).toBe(false)
  expect(hasHardFailure(results)).toBe(true)
})

test("reportDoctor prints pass and fail lines", async () => {
  let text = ""
  const out = { write: (chunk: string) => { text += chunk; return true } } as unknown as NodeJS.WritableStream
  const ui = createUi({ out, color: false, ascii: true })
  const results = await runDoctor({ env: {}, home: "/h", dataDir: "/h/data", nodeVersion: "22.0.0", runSbx: okSbx, mkdir: () => {} })
  reportDoctor(results, ui)
  expect(text).toContain("Celly doctor")
  expect(text).toContain("x  Node")
  expect(text).toContain("→ Install Node 24")
})
