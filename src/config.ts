import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { APPROVAL_MODES, isApprovalMode } from "./mode.js"
import type { ApprovalMode } from "./mode.ts"

export interface Config {
  discordToken: string; guildIds: string[]; projectsRoot: string
  accessRoleId?: string; blockRoleId?: string; ownerRoleId?: string; categoryId?: string
  sandboxTemplate: string; sandboxCpus: number; sandboxMemory: string
  portRangeStart: number; portRangeEnd: number
  defaultModel?: string; defaultAgent?: string
  approvalMode: ApprovalMode
  bootTimeoutMs: number; healthTimeoutMs: number; editIntervalMs: number
  attachmentMaxBytes: number; maxQueue: number; maxConcurrentRuns: number; sessionBudgetUsd: number
  attachAutoThread: boolean
  idleStopMinutes: number
  dataDir: string; logLevel: "debug" | "info" | "warn" | "error"
  logMaxBytes: number; logMaxFiles: number
  backupIntervalHours: number; backupKeep: number
  adminPort: number
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
 * The env file `main()` loads. The CLI points `CELLY_ENV_FILE` at
 * `~/.bot-celly/.env`; the repo/dev flow falls back to `./.env`.
 */
export function envFileFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.CELLY_ENV_FILE ?? ".env"
}

/**
 * Spec §6: `settings` is seeded from env on first boot only. An existing value
 * (set by the user or a future admin surface) is authoritative and never
 * overwritten by re-reading `.env` at every boot.
 */
export function seedSettings(
  db: { settings: { get(key: string): string | undefined; set(key: string, value: string): void } },
  cfg: { defaultModel?: string; defaultAgent?: string; approvalMode?: string },
): void {
  if (cfg.defaultModel && db.settings.get("default_model") === undefined) db.settings.set("default_model", cfg.defaultModel)
  if (cfg.defaultAgent && db.settings.get("default_agent") === undefined) db.settings.set("default_agent", cfg.defaultAgent)
  if (cfg.approvalMode && db.settings.get("approval_mode") === undefined) db.settings.set("approval_mode", cfg.approvalMode)
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
const bool = (e: NodeJS.ProcessEnv, k: string, d: boolean): boolean => {
  const raw = e[k]?.trim().toLowerCase()
  if (raw === undefined || raw === "") return d
  if (raw === "true" || raw === "1") return true
  if (raw === "false" || raw === "0") return false
  throw new Error(`${k} must be a boolean, got "${e[k]}"`)
}
const nonNegative = (e: NodeJS.ProcessEnv, k: string, d: number) => {
  const n = num(e, k, d)
  if (n < 0) throw new Error(`${k} must be >= 0, got "${e[k]}"`)
  return n
}
/**
 * Spec §4.4: `DISCORD_GUILD_IDS` (comma-separated) wins when set; the singular
 * `DISCORD_GUILD_ID` remains supported. Entries are trimmed, blanks dropped,
 * and duplicates collapsed in first-seen order.
 */
export function parseGuildIds(env: NodeJS.ProcessEnv): string[] | undefined {
  const plural = str(env, "DISCORD_GUILD_IDS")
  if (plural !== undefined) {
    const ids = [...new Set(plural.split(",").map((id) => id.trim()).filter((id) => id.length > 0))]
    if (ids.length === 0) throw new Error("DISCORD_GUILD_IDS must contain at least one non-empty guild id")
    return ids
  }
  const single = str(env, "DISCORD_GUILD_ID")
  return single ? [single] : undefined
}
export function defaultProjectsRoot(): string {
  return join(homedir(), "Celly", "projects")
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const guildIds = parseGuildIds(env)
  const missing = [
    ...(str(env, "DISCORD_TOKEN") ? [] : ["DISCORD_TOKEN"]),
    ...(guildIds ? [] : ["DISCORD_GUILD_ID or DISCORD_GUILD_IDS"]),
  ]
  if (missing.length) throw new Error(`Missing required env: ${missing.join(", ")}`)
  const portRangeStart = int(env, "PORT_RANGE_START", 4300, 1)
  const portRangeEnd = int(env, "PORT_RANGE_END", 4399, 1)
  if (portRangeEnd <= portRangeStart) throw new Error("PORT_RANGE_END must exceed PORT_RANGE_START")
  const level = str(env, "LOG_LEVEL") ?? "info"
  if (!["debug", "info", "warn", "error"].includes(level)) throw new Error(`LOG_LEVEL invalid: ${level}`)
  const approvalMode = str(env, "APPROVAL_MODE") ?? "buttons"
  if (!isApprovalMode(approvalMode)) throw new Error(`APPROVAL_MODE must be one of ${APPROVAL_MODES.join(", ")}, got "${approvalMode}"`)
  const sessionBudgetUsd = num(env, "SESSION_BUDGET_USD", 0)
  if (sessionBudgetUsd < 0) throw new Error(`SESSION_BUDGET_USD must be >= 0, got "${env.SESSION_BUDGET_USD}"`)
  return {
    discordToken: str(env, "DISCORD_TOKEN")!, guildIds: guildIds!,
    projectsRoot: str(env, "PROJECTS_ROOT") ?? defaultProjectsRoot(),
    accessRoleId: str(env, "ACCESS_ROLE_ID"), blockRoleId: str(env, "BLOCK_ROLE_ID"),
    ownerRoleId: str(env, "OWNER_ROLE_ID"),
    categoryId: str(env, "CATEGORY_ID"),
    sandboxTemplate: str(env, "SANDBOX_TEMPLATE") ?? "opencode",
    sandboxCpus: int(env, "SANDBOX_CPUS", 2, 1), sandboxMemory: str(env, "SANDBOX_MEMORY") ?? "4g",
    portRangeStart, portRangeEnd,
    defaultModel: str(env, "DEFAULT_MODEL"), defaultAgent: str(env, "DEFAULT_AGENT"),
    approvalMode,
    bootTimeoutMs: int(env, "BOOT_TIMEOUT_MS", 120000, 1), healthTimeoutMs: int(env, "HEALTH_TIMEOUT_MS", 30000, 1),
    editIntervalMs: int(env, "EDIT_INTERVAL_MS", 1200, 1),
    attachmentMaxBytes: int(env, "ATTACHMENT_MAX_BYTES", 102400, 1),
    maxQueue: int(env, "MAX_QUEUE", 20, 1), maxConcurrentRuns: int(env, "MAX_CONCURRENT_RUNS", 4, 1),
    attachAutoThread: bool(env, "ATTACH_AUTO_THREAD", false),
    idleStopMinutes: int(env, "IDLE_STOP_MINUTES", 0, 0),
    sessionBudgetUsd,
    dataDir: str(env, "DATA_DIR") ?? "./data",
    logLevel: level as Config["logLevel"],
    logMaxBytes: int(env, "LOG_MAX_BYTES", 5000000, 1),
    logMaxFiles: int(env, "LOG_MAX_FILES", 3, 1),
    backupIntervalHours: nonNegative(env, "BACKUP_INTERVAL_HOURS", 24),
    backupKeep: int(env, "BACKUP_KEEP", 7, 1),
    adminPort: int(env, "ADMIN_PORT", 4560, 0),
  }
}
