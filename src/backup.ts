import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { Db } from "./db.ts"

export interface BackupSchedulerDeps {
  db: Pick<Db, "backupTo">
  dir: string
  intervalMs: number
  keep: number
  now(): number
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
    mkdirSync(deps.dir, { recursive: true })
    const file = join(deps.dir, `bot-${new Date(deps.now()).toISOString().replace(/[:.]/g, "-")}.db`)
    if (!isAbsolute(file) || file.includes("\0")) throw new Error(`invalid backup path: ${file}`)
    deps.db.backupTo(file)
    prune(deps.dir, deps.keep)
    return file
  }
  return {
    tick,
    start() {
      if (timer !== undefined || deps.intervalMs <= 0) return
      timer = setInterval(() => { void tick().catch(() => {}) }, deps.intervalMs)
      if (typeof (timer as any).unref === "function") (timer as any).unref()
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}
