import type { AuditDraft } from "./audit.ts"
import type { Db } from "./db.ts"
import type { ScheduledTask } from "./types.ts"
import { unrefTimer } from "./helpers.js"

export interface TaskRunnerDeps {
  db: Pick<Db, "tasks" | "threads">
  now(): number
  everyMs: number
  prompt(threadId: string, text: string, actor: string): Promise<string | undefined>
  ensureThread(channelId: string): Promise<string>
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
  audit?(entry: AuditDraft): void
}

export interface TaskRunner {
  start(): void
  stop(): void
  tick(): Promise<void>
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const tick = async (): Promise<void> => {
    let due: ScheduledTask[]
    try {
      due = deps.db.tasks.due(deps.now())
    } catch (e) {
      deps.log?.warn("task tick failed", { error: String(e) })
      return
    }
    for (const task of due) {
      try {
        const threadId = deps.db.threads.byChannel(task.channelId)[0]?.threadId ?? await deps.ensureThread(task.channelId)
        deps.audit?.({ kind: "task", channelId: task.channelId, threadId, actorId: "scheduler", detail: task.prompt.slice(0, 200), decision: "run" })
        await deps.prompt(threadId, task.prompt, "task")
        deps.db.tasks.markRun(task.id, deps.now() + task.everyMinutes * 60_000)
      } catch (e) {
        deps.log?.warn("scheduled task failed", { id: task.id, channelId: task.channelId, error: String(e) })
      }
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    tick,
    start() {
      if (timer !== undefined || deps.everyMs <= 0) return
      timer = setInterval(() => { void tick() }, deps.everyMs)
      unrefTimer(timer)
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}
