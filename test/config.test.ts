import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { ensureDataDir, loadConfig, loadDotEnv, seedSettings } from "../src/config.ts"

const base = { DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g", PROJECTS_ROOT: "C:\\projects" }

test("parses defaults", () => {
  const c = loadConfig(base)
  expect(c.portRangeStart).toBe(4300)
  expect(c.sandboxCpus).toBe(2)
  expect(c.maxConcurrentRuns).toBe(4)
  expect(c.editIntervalMs).toBe(1200)
})
test("parses the owner role", () => {
  expect(loadConfig({ ...base, OWNER_ROLE_ID: "own" }).ownerRoleId).toBe("own")
  expect(loadConfig(base).ownerRoleId).toBeUndefined()
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

test("rejects a non-positive EDIT_INTERVAL_MS", () => {
  expect(() => loadConfig({ ...base, EDIT_INTERVAL_MS: "0" })).toThrow(/EDIT_INTERVAL_MS/)
  expect(() => loadConfig({ ...base, EDIT_INTERVAL_MS: "-5" })).toThrow(/EDIT_INTERVAL_MS/)
  expect(loadConfig({ ...base, EDIT_INTERVAL_MS: "1" }).editIntervalMs).toBe(1)
})

test("rejects fractional counts and ports and non-positive cpu counts", () => {
  expect(() => loadConfig({ ...base, MAX_QUEUE: "1.5" })).toThrow(/MAX_QUEUE/)
  expect(() => loadConfig({ ...base, MAX_CONCURRENT_RUNS: "0" })).toThrow(/MAX_CONCURRENT_RUNS/)
  expect(() => loadConfig({ ...base, PORT_RANGE_START: "4300.5" })).toThrow(/PORT_RANGE_START/)
  expect(() => loadConfig({ ...base, SANDBOX_CPUS: "0" })).toThrow(/SANDBOX_CPUS/)
})

test("ensureDataDir creates nested directories", () => {
  const root = mkdtempSync(join(tmpdir(), "cely-data-"))
  const nested = join(root, "a", "b", "c")
  try {
    expect(existsSync(nested)).toBe(false)
    ensureDataDir(nested)
    expect(existsSync(nested)).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("seedSettings writes defaults only when a key is unset", () => {
  const store = new Map<string, string>()
  const db = { settings: { get: (k: string) => store.get(k), set: (k: string, v: string) => { store.set(k, v) } } }
  seedSettings(db, { defaultModel: "anthropic/claude", defaultAgent: "build" })
  expect(store.get("default_model")).toBe("anthropic/claude")
  expect(store.get("default_agent")).toBe("build")
  seedSettings(db, { defaultModel: "openai/gpt", defaultAgent: "plan" })
  expect(store.get("default_model")).toBe("anthropic/claude")
  expect(store.get("default_agent")).toBe("build")
})

test("loadDotEnv reports success and failure without throwing", () => {
  let called = ""
  expect(loadDotEnv(".env.test", (p) => { called = p })).toBe(true)
  expect(called).toBe(".env.test")
  expect(loadDotEnv(".env.test", () => { throw new Error("missing") })).toBe(false)
})

test("loadDotEnv loads a real .env into process.env", () => {
  const root = mkdtempSync(join(tmpdir(), "cely-env-"))
  const envPath = join(root, ".env")
  const key = "CELY_TEST_DOTENV_VALUE"
  try {
    writeFileSync(envPath, `${key}=loaded\n`)
    delete process.env[key]
    expect(loadDotEnv(envPath)).toBe(true)
    expect(process.env[key]).toBe("loaded")
  } finally {
    delete process.env[key]
    rmSync(root, { recursive: true, force: true })
  }
})
