import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { defaultProjectsRoot, ensureDataDir, loadConfig, loadDotEnv, parseGuildIds, seedSettings } from "../src/config.ts"
import { withTempDir } from "./helpers/tmp.ts"

const base = { DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g", PROJECTS_ROOT: "C:\\projects" }

test("parses defaults", () => {
  const c = loadConfig(base)
  expect(c.portRangeStart).toBe(4300)
  expect(c.sandboxCpus).toBe(2)
  expect(c.maxConcurrentRuns).toBe(4)
  expect(c.editIntervalMs).toBe(1200)
})
test("github token is optional, GITHUB_TOKEN wins over GH_TOKEN", () => {
  expect(loadConfig(base).githubToken).toBeUndefined()
  expect(loadConfig({ ...base, GITHUB_TOKEN: " ghp_a " }).githubToken).toBe("ghp_a")
  expect(loadConfig({ ...base, GH_TOKEN: "ghp_b" }).githubToken).toBe("ghp_b")
  expect(loadConfig({ ...base, GITHUB_TOKEN: "ghp_a", GH_TOKEN: "ghp_b" }).githubToken).toBe("ghp_a")
})
test("only token and guild are required; PROJECTS_ROOT defaults under the home dir", () => {
  const c = loadConfig({ DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g" })
  expect(c.projectsRoot).toBe(join(homedir(), "Celly", "projects"))
  expect(c.projectsRoot).toBe(defaultProjectsRoot())
})
test("SESSION_BUDGET_USD defaults to 0 and rejects negatives and non-numbers", () => {
  expect(loadConfig(base).sessionBudgetUsd).toBe(0)
  expect(loadConfig({ ...base, SESSION_BUDGET_USD: "5.5" }).sessionBudgetUsd).toBe(5.5)
  expect(loadConfig({ ...base, SESSION_BUDGET_USD: "0" }).sessionBudgetUsd).toBe(0)
  expect(() => loadConfig({ ...base, SESSION_BUDGET_USD: "-1" })).toThrow(/SESSION_BUDGET_USD/)
  expect(() => loadConfig({ ...base, SESSION_BUDGET_USD: "lots" })).toThrow(/SESSION_BUDGET_USD/)
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

test("parses ATTACH_AUTO_THREAD as a boolean defaulting to false", () => {
  expect(loadConfig(base).attachAutoThread).toBe(false)
  expect(loadConfig({ ...base, ATTACH_AUTO_THREAD: "true" }).attachAutoThread).toBe(true)
  expect(loadConfig({ ...base, ATTACH_AUTO_THREAD: "1" }).attachAutoThread).toBe(true)
  expect(loadConfig({ ...base, ATTACH_AUTO_THREAD: "false" }).attachAutoThread).toBe(false)
  expect(() => loadConfig({ ...base, ATTACH_AUTO_THREAD: "maybe" })).toThrow(/ATTACH_AUTO_THREAD/)
})

test("SMART_THREAD_NAMES defaults to true and parses booleans", () => {
  expect(loadConfig({ ...base }).smartThreadNames).toBe(true)
  expect(loadConfig({ ...base, SMART_THREAD_NAMES: "false" }).smartThreadNames).toBe(false)
  expect(loadConfig({ ...base, SMART_THREAD_NAMES: "1" }).smartThreadNames).toBe(true)
})

test("parses IDLE_STOP_MINUTES, defaulting to 0 (disabled)", () => {
  expect(loadConfig(base).idleStopMinutes).toBe(0)
  expect(loadConfig({ ...base, IDLE_STOP_MINUTES: "5" }).idleStopMinutes).toBe(5)
  expect(loadConfig({ ...base, IDLE_STOP_MINUTES: "0" }).idleStopMinutes).toBe(0)
})

test("rejects a negative or fractional IDLE_STOP_MINUTES", () => {
  expect(() => loadConfig({ ...base, IDLE_STOP_MINUTES: "-1" })).toThrow(/IDLE_STOP_MINUTES/)
  expect(() => loadConfig({ ...base, IDLE_STOP_MINUTES: "1.5" })).toThrow(/IDLE_STOP_MINUTES/)
})

test("the idle auto-stop setting is documented in the env example and the config guide", () => {
  expect(readFileSync(".env.example", "utf8")).toContain("# IDLE_STOP_MINUTES=0")
  expect(readFileSync("docs-site/guides/configuration.mdx", "utf8")).toContain("| `IDLE_STOP_MINUTES` | `0` |")
})

test("ensureDataDir creates nested directories", async () => {
  await withTempDir("celly-data-", (root) => {
    const nested = join(root, "a", "b", "c")
    expect(existsSync(nested)).toBe(false)
    ensureDataDir(nested)
    expect(existsSync(nested)).toBe(true)
  })
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
  seedSettings(db, { approvalMode: "plan" })
  expect(store.get("approval_mode")).toBe("plan")
  seedSettings(db, { approvalMode: "auto" })
  expect(store.get("approval_mode")).toBe("plan")
  seedSettings(db, { worktreeDefault: true })
  expect(store.get("worktree_default")).toBe("true")
  seedSettings(db, { worktreeDefault: false })
  expect(store.get("worktree_default")).toBe("true")
})

test("WORKTREE_DEFAULT defaults to false and parses booleans", () => {
  expect(loadConfig(base).worktreeDefault).toBe(false)
  expect(loadConfig({ ...base, WORKTREE_DEFAULT: "true" }).worktreeDefault).toBe(true)
  expect(loadConfig({ ...base, WORKTREE_DEFAULT: "1" }).worktreeDefault).toBe(true)
  expect(loadConfig({ ...base, WORKTREE_DEFAULT: "false" }).worktreeDefault).toBe(false)
  expect(() => loadConfig({ ...base, WORKTREE_DEFAULT: "maybe" })).toThrow(/WORKTREE_DEFAULT/)
})

test("APPROVAL_MODE defaults to buttons and rejects unknown modes", () => {
  expect(loadConfig(base).approvalMode).toBe("buttons")
  expect(loadConfig({ ...base, APPROVAL_MODE: "plan" }).approvalMode).toBe("plan")
  expect(() => loadConfig({ ...base, APPROVAL_MODE: "yolo" })).toThrow(/APPROVAL_MODE/)
})

test("loadDotEnv reports success and failure without throwing", () => {
  let called = ""
  expect(loadDotEnv(".env.test", (p) => { called = p })).toBe(true)
  expect(called).toBe(".env.test")
  expect(loadDotEnv(".env.test", () => { throw new Error("missing") })).toBe(false)
})

test("loadDotEnv loads a real .env into process.env", async () => {
  await withTempDir("celly-env-", (root) => {
    const envPath = join(root, ".env")
    const key = "CELLY_TEST_DOTENV_VALUE"
    try {
      writeFileSync(envPath, `${key}=loaded\n`)
      delete process.env[key]
      expect(loadDotEnv(envPath)).toBe(true)
      expect(process.env[key]).toBe("loaded")
    } finally {
      delete process.env[key]
    }
  })
})

test("parses log rotation settings and defaults", () => {
  const c = loadConfig({ ...base, LOG_MAX_BYTES: "1024", LOG_MAX_FILES: "2" })
  expect(c.logMaxBytes).toBe(1024)
  expect(c.logMaxFiles).toBe(2)
  const d = loadConfig(base)
  expect(d.logMaxBytes).toBe(5_000_000)
  expect(d.logMaxFiles).toBe(3)
})

test("rejects invalid log rotation settings", () => {
  expect(() => loadConfig({ ...base, LOG_MAX_BYTES: "0" })).toThrow(/LOG_MAX_BYTES/)
  expect(() => loadConfig({ ...base, LOG_MAX_FILES: "0" })).toThrow(/LOG_MAX_FILES/)
})

test("parses backup settings and defaults", () => {
  const c = loadConfig({ ...base, BACKUP_INTERVAL_HOURS: "0", BACKUP_KEEP: "3" })
  expect(c.backupIntervalHours).toBe(0)
  expect(c.backupKeep).toBe(3)
  const d = loadConfig(base)
  expect(d.backupIntervalHours).toBe(24)
  expect(d.backupKeep).toBe(7)
})

test("rejects invalid backup settings", () => {
  expect(() => loadConfig({ ...base, BACKUP_INTERVAL_HOURS: "-1" })).toThrow(/BACKUP_INTERVAL_HOURS/)
  expect(() => loadConfig({ ...base, BACKUP_KEEP: "0" })).toThrow(/BACKUP_KEEP/)
})

test("admin port defaults to 4560 and accepts 0 to disable", () => {
  expect(loadConfig(base).adminPort).toBe(4560)
  expect(loadConfig({ ...base, ADMIN_PORT: "0" }).adminPort).toBe(0)
  expect(() => loadConfig({ ...base, ADMIN_PORT: "-1" })).toThrow(/ADMIN_PORT/)
})

test("parseGuildIds reads the plural list, trims, drops blanks, and dedupes", () => {
  expect(parseGuildIds({ DISCORD_GUILD_IDS: " g1 , ,g2,g1 " })).toEqual(["g1", "g2"])
})
test("parseGuildIds falls back to the singular guild id", () => {
  expect(parseGuildIds({ DISCORD_GUILD_ID: " g1 " })).toEqual(["g1"])
})
test("parseGuildIds returns undefined when neither variable is set", () => {
  expect(parseGuildIds({})).toBeUndefined()
})
test("parseGuildIds rejects an all-blank plural list", () => {
  expect(() => parseGuildIds({ DISCORD_GUILD_IDS: " , " })).toThrow(/DISCORD_GUILD_IDS/)
})
test("loadConfig prefers DISCORD_GUILD_IDS over the legacy singular id", () => {
  const c = loadConfig({ DISCORD_TOKEN: "t", DISCORD_GUILD_IDS: "g1,g2", DISCORD_GUILD_ID: "legacy" })
  expect(c.guildIds).toEqual(["g1", "g2"])
})
test("loadConfig falls back to the singular guild id", () => {
  const c = loadConfig({ ...base })
  expect(c.guildIds).toEqual(["g"])
})
test("loadConfig requires a guild id in either form", () => {
  expect(() => loadConfig({ DISCORD_TOKEN: "t" })).toThrow(/DISCORD_GUILD_ID/)
})
