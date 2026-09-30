import { mkdirSync } from "node:fs"
import { loadConfig } from "../config.js"
import type { RunResult } from "../sbx.js"
import type { StatusKind, Ui, UiRow } from "./ui.js"

export type CheckKind = "hard" | "advisory"

export interface CheckResult {
  name: string
  ok: boolean
  kind: CheckKind
  detail?: string
  fix?: string
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv
  home: string
  dataDir: string
  nodeVersion?: string
  runSbx?: (args: string[]) => Promise<RunResult>
  mkdir?: (path: string) => void
}

export function satisfiesNode(version: string): boolean {
  return Number.parseInt(version.split(".")[0] ?? "", 10) === 24
}

export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const runSbx = deps.runSbx
  const mkdir = deps.mkdir ?? ((path: string) => { mkdirSync(path, { recursive: true }) })
  const version = deps.nodeVersion ?? process.versions.node
  const results: CheckResult[] = []

  results.push(satisfiesNode(version)
    ? { name: "Node", ok: true, kind: "hard", detail: `v${version}` }
    : { name: "Node", ok: false, kind: "hard", detail: `v${version}`, fix: "Install Node 24: `fnm install 24` (or `nvm install 24`), then reopen your shell." })

  if (runSbx) {
    try {
      const result = await runSbx(["version"])
      results.push(result.code === 0
        ? { name: "sbx", ok: true, kind: "hard", detail: result.stdout.trim().split("\n")[0] ?? "installed" }
        : { name: "sbx", ok: false, kind: "hard", detail: result.stderr.trim() || `exit ${result.code}`, fix: "Install Docker Sandboxes: `winget install -h Docker.sbx`, then `sbx login`." })
    } catch (error) {
      results.push({ name: "sbx", ok: false, kind: "hard", detail: String(error), fix: "Install Docker Sandboxes: `winget install -h Docker.sbx`, then `sbx login`." })
    }
    try {
      const result = await runSbx(["policy", "ls"])
      results.push(result.code === 0
        ? { name: "Policy", ok: true, kind: "hard", detail: "initialized" }
        : { name: "Policy", ok: false, kind: "hard", detail: result.stderr.trim() || `exit ${result.code}`, fix: "Initialize the network policy: `sbx policy init balanced`." })
    } catch (error) {
      results.push({ name: "Policy", ok: false, kind: "hard", detail: String(error), fix: "Initialize the network policy: `sbx policy init balanced`." })
    }
  }

  try {
    loadConfig(deps.env)
    results.push({ name: "Config", ok: true, kind: "hard", detail: "token and guild IDs present" })
  } catch (error) {
    results.push({ name: "Config", ok: false, kind: "hard", detail: (error as Error).message, fix: "Set DISCORD_TOKEN and DISCORD_GUILD_IDS, or run `bot-celly setup`." })
  }

  try {
    mkdir(deps.home)
    mkdir(deps.dataDir)
    results.push({ name: "Storage", ok: true, kind: "hard", detail: deps.dataDir })
  } catch (error) {
    results.push({ name: "Storage", ok: false, kind: "hard", detail: String(error), fix: `Ensure ${deps.home} and ${deps.dataDir} are writable.` })
  }

  results.push({ name: "Provider secret", ok: true, kind: "advisory", detail: "register credentials once with `sbx secret set <provider>`" })
  return results
}

export function hasHardFailure(results: CheckResult[]): boolean {
  return results.some((result) => result.kind === "hard" && !result.ok)
}

export function reportDoctor(results: CheckResult[], ui: Ui): void {
  ui.heading("Celly doctor")
  ui.rule()
  ui.rows(results.map((result): UiRow => {
    const kind: StatusKind = !result.ok
      ? (result.kind === "advisory" ? "warn" : "fail")
      : (result.kind === "advisory" ? "info" : "ok")
    const row: UiRow = { kind, label: result.name }
    if (result.detail) row.detail = result.detail
    if (result.fix) row.fix = result.fix
    return row
  }))
}
