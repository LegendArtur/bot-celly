import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Db } from "./db.ts"
import { unrefTimer } from "./helpers.js"

export interface BackupSchedulerDeps {
  db: Pick<Db, "backupTo">
  dir: string
  intervalMs: number
  keep: number
  now(): number
  warn?(message: string, fields?: Record<string, unknown>): void
}

export interface BackupScheduler {
  start(): void
  stop(): void
  tick(): Promise<string | undefined>
}

function prune(dir: string, keep: number): void {
  const names = readdirSync(dir).filter((name) => name.startsWith("bot-") && name.endsWith(".db")).sort()
  while (names.length > Math.max(1, Math.floor(keep))) {
    const oldest = names.shift()
    if (oldest) rmSync(join(dir, oldest), { force: true })
  }
}

export function createBackupScheduler(deps: BackupSchedulerDeps): BackupScheduler {
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = async (): Promise<string | undefined> => {
    if (deps.dir.includes("\0")) throw new Error(`invalid backup path: ${deps.dir}`)
    const dir = resolve(deps.dir)
    mkdirSync(dir, { recursive: true })
    const file = resolve(dir, `bot-${new Date(deps.now()).toISOString().replace(/[:.]/g, "-")}.db`)
    if (file.includes("\0")) throw new Error(`invalid backup path: ${file}`)
    deps.db.backupTo(file)
    prune(dir, deps.keep)
    return file
  }
  return {
    tick,
    start() {
      if (timer !== undefined || deps.intervalMs <= 0) return
      timer = setInterval(() => {
        void tick().catch((e) => deps.warn?.("backup tick failed", { error: String(e) }))
      }, deps.intervalMs)
      unrefTimer(timer)
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}
