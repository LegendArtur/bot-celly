import { expect, test } from "vitest"
import { loadConfig } from "../src/config.ts"

const base = { DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g", PROJECTS_ROOT: "C:\\projects" }

test("parses defaults", () => {
  const c = loadConfig(base)
  expect(c.portRangeStart).toBe(4300)
  expect(c.sandboxCpus).toBe(2)
  expect(c.maxConcurrentRuns).toBe(4)
  expect(c.editIntervalMs).toBe(1200)
})
test("requires mandatory vars", () => {
  expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/)
})
test("rejects a broken port range", () => {
  expect(() => loadConfig({ ...base, PORT_RANGE_START: "9000", PORT_RANGE_END: "8000" })).toThrow(/PORT_RANGE/)
})
test("rejects non-numeric overrides", () => {
  expect(() => loadConfig({ ...base, MAX_QUEUE: "lots" })).toThrow(/MAX_QUEUE/)
})
