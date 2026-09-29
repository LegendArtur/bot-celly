import { unrefTimer } from "./helpers.js"
import type { Project } from "./types.ts"

export interface IdleSweeperDeps {
  listProjects(): Project[]
  activeThreads(channelId: string): string[]
  now(): number
  stop(channelId: string): Promise<void> | void
  notify(channelId: string, minutes: number): Promise<void> | void
  idleMs: number
  intervalMs: number
}

export interface IdleSweeper {
  start(): void
  stop(): void
  tick(): Promise<void>
}

export function formatIdleStopNotice(minutes: number): string {
  return `Project stopped after ${minutes} minute${minutes === 1 ? "" : "s"} of inactivity. Send a message to start it again.`
}

export function createIdleSweeper(deps: IdleSweeperDeps): IdleSweeper {
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  const thresholdMinutes = Math.max(1, Math.round(deps.idleMs / 60_000))

  const tick = async (): Promise<void> => {
    if (deps.idleMs <= 0 || running) return
    running = true
    try {
      for (const project of deps.listProjects()) {
        if (project.status === "provisioning") continue
        // A zero timestamp means the project has never been active (fresh row,
        // pre-v5 migration, or booted but not yet used); it must not be swept.
        if (project.lastActiveAt <= 0) continue
        if (deps.activeThreads(project.channelId).length > 0) continue
        const idleMs = deps.now() - project.lastActiveAt
        if (idleMs < deps.idleMs) continue
        try {
          await deps.stop(project.channelId)
          const minutes = Math.min(Math.round(idleMs / 60_000), thresholdMinutes)
          await deps.notify(project.channelId, minutes)
        } catch {
          // stop/notify are wired with their own logging; one failing project
          // must not abort the sweep for the rest.
        }
      }
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (deps.idleMs <= 0 || timer !== undefined) return
      timer = setInterval(() => { void tick() }, deps.intervalMs)
      unrefTimer(timer)
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    tick,
  }
}
