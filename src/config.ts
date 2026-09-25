import { mkdirSync } from "node:fs"

export interface Config {
  discordToken: string; guildId: string; projectsRoot: string
  accessRoleId?: string; blockRoleId?: string; ownerRoleId?: string; categoryId?: string
  sandboxTemplate: string; sandboxCpus: number; sandboxMemory: string
  portRangeStart: number; portRangeEnd: number
  defaultModel?: string; defaultAgent?: string
  bootTimeoutMs: number; healthTimeoutMs: number; editIntervalMs: number
  attachmentMaxBytes: number; maxQueue: number; maxConcurrentRuns: number
  dataDir: string; logLevel: "debug" | "info" | "warn" | "error"
}
/** Create DATA_DIR (and parents) before the logger or SQLite file is opened. */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * Load `.env` into `process.env` before `loadConfig`. Missing files and load
 * failures are non-fatal: required values still fail fast in `loadConfig`.
 */
export function loadDotEnv(path = ".env", loader: (p: string) => void = (p) => { process.loadEnvFile?.(p) }): boolean {
  try { loader(path); return true } catch { return false }
}

/**
 * Spec §6: `settings` is seeded from env on first boot only. An existing value
 * (set by the user or a future admin surface) is authoritative and never
 * overwritten by re-reading `.env` at every boot.
 */
export function seedSettings(
  db: { settings: { get(key: string): string | undefined; set(key: string, value: string): void } },
  cfg: { defaultModel?: string; defaultAgent?: string },
): void {
  if (cfg.defaultModel && db.settings.get("default_model") === undefined) db.settings.set("default_model", cfg.defaultModel)
  if (cfg.defaultAgent && db.settings.get("default_agent") === undefined) db.settings.set("default_agent", cfg.defaultAgent)
}

const str = (e: NodeJS.ProcessEnv, k: string) => e[k]?.trim() || undefined
const num = (e: NodeJS.ProcessEnv, k: string, d: number) => {
  const raw = e[k]; if (raw === undefined || raw === "") return d
  const n = Number(raw); if (!Number.isFinite(n)) throw new Error(`${k} must be a number, got "${raw}"`)
  return n
}
const int = (e: NodeJS.ProcessEnv, k: string, d: number, min = 1) => {
  const n = num(e, k, d)
  if (!Number.isInteger(n) || n < min) throw new Error(`${k} must be an integer >= ${min}, got "${e[k]}"`)
  return n
}
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = ["DISCORD_TOKEN", "DISCORD_GUILD_ID", "PROJECTS_ROOT"].filter((k) => !str(env, k))
  if (missing.length) throw new Error(`Missing required env: ${missing.join(", ")}`)
  const portRangeStart = int(env, "PORT_RANGE_START", 4300, 1)
  const portRangeEnd = int(env, "PORT_RANGE_END", 4399, 1)
  if (portRangeEnd <= portRangeStart) throw new Error("PORT_RANGE_END must exceed PORT_RANGE_START")
  const level = str(env, "LOG_LEVEL") ?? "info"
  if (!["debug", "info", "warn", "error"].includes(level)) throw new Error(`LOG_LEVEL invalid: ${level}`)
  return {
    discordToken: str(env, "DISCORD_TOKEN")!, guildId: str(env, "DISCORD_GUILD_ID")!,
    projectsRoot: str(env, "PROJECTS_ROOT")!,
    accessRoleId: str(env, "ACCESS_ROLE_ID"), blockRoleId: str(env, "BLOCK_ROLE_ID"),
    ownerRoleId: str(env, "OWNER_ROLE_ID"),
    categoryId: str(env, "CATEGORY_ID"),
    sandboxTemplate: str(env, "SANDBOX_TEMPLATE") ?? "opencode",
    sandboxCpus: int(env, "SANDBOX_CPUS", 2, 1), sandboxMemory: str(env, "SANDBOX_MEMORY") ?? "4g",
    portRangeStart, portRangeEnd,
    defaultModel: str(env, "DEFAULT_MODEL"), defaultAgent: str(env, "DEFAULT_AGENT"),
    bootTimeoutMs: int(env, "BOOT_TIMEOUT_MS", 120000, 1), healthTimeoutMs: int(env, "HEALTH_TIMEOUT_MS", 30000, 1),
    editIntervalMs: int(env, "EDIT_INTERVAL_MS", 1200, 1),
    attachmentMaxBytes: int(env, "ATTACHMENT_MAX_BYTES", 102400, 1),
    maxQueue: int(env, "MAX_QUEUE", 20, 1), maxConcurrentRuns: int(env, "MAX_CONCURRENT_RUNS", 4, 1),
    dataDir: str(env, "DATA_DIR") ?? "./data",
    logLevel: level as Config["logLevel"],
  }
}
