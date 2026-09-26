import type { Db } from "./db.ts"
import type { Logger } from "./log.ts"
import type { Project } from "./types.ts"
import { buildPromptText, projectForChannel } from "./helpers.js"
import { shouldHandleMessage } from "./discord.js"
import { renderPayload, sanitizeThreadName } from "./render.js"
import type { CreateThreadInput } from "./commands.ts"
import type { Runner } from "./runner.ts"

type Bucket = { schedule<T>(fn: () => Promise<T>): Promise<T> }

export interface MessageHandlerDeps {
  db: Db
  log: Logger
  projects: { ensureReady(channelId: string): Promise<void> }
  runner: Pick<Runner, "prompt">
  bucketFor(channelId: string): Bucket
  subscribeProject(project: Project): void
  isAuthorized(message: any): boolean
  ingestAttachments(project: Project, message: any): Promise<{ hostPath: string; sandboxPath: string }[]>
  runShell(channelId: string, command: string): Promise<string[]>
  startTyping(threadId: string): void
  createThread(input: CreateThreadInput): Promise<{ threadId: string; sessionId: string; notice?: string }>
  registerSession(threadId: string, sessionId: string): void
}

/**
 * Builds the messageCreate handler. Kept as a factory so routing can be tested
 * with fake Discord/runner/projects. Resolves the project for archived threads
 * from the DB before the parentId gate because partial thread channels may
 * report `parentId === null`.
 */
export function createMessageHandler(deps: MessageHandlerDeps): (message: any) => Promise<void> {
  return async function onMessage(message: any): Promise<void> {
    try {
      if (typeof message.inGuild === "function" && !message.inGuild()) return
      if (!message.member) return
      const isThread = typeof message.channel?.isThread === "function" && message.channel.isThread()
      const knownThread = isThread ? deps.db.threads.get(message.channelId) : undefined
      let project = knownThread ? deps.db.projects.getByChannel(knownThread.channelId) : undefined
      if (!project) {
        const parentId = isThread ? message.channel.parentId : null
        project = projectForChannel(deps.db.projects.list(), message.channelId, parentId)
      }
      if (!project) return
      if (!shouldHandleMessage(message, project.channelId, !!knownThread)) return
      if (!deps.isAuthorized(message)) return

      const text = message.content ?? ""
      if (text.startsWith("!")) {
        const command = text.slice(1).trim()
        if (!command) return
        await deps.projects.ensureReady(project.channelId)
        deps.subscribeProject(project)
        for (const chunk of await deps.runShell(project.channelId, command)) {
          await deps.bucketFor(project.channelId).schedule(() => message.channel.send(renderPayload(chunk)))
        }
        return
      }
      const imported = await deps.ingestAttachments(project, message)
      const promptText = buildPromptText(text, imported.map((a) => a.sandboxPath))
      if (!promptText.trim()) return
      const existing = deps.db.threads.get(message.channelId)
      if (existing) {
        await deps.projects.ensureReady(project.channelId)
        deps.subscribeProject(project)
        if (existing.sessionId) deps.registerSession(existing.threadId, existing.sessionId)
        const notice = await deps.runner.prompt(existing.threadId, promptText, message.author.id)
        if (notice) await deps.bucketFor(existing.channelId).schedule(() => message.reply(renderPayload(notice)))
        else deps.startTyping(existing.threadId)
        return
      }
      if (isThread) return
      await deps.projects.ensureReady(project.channelId)
      deps.subscribeProject(project)
      const title = sanitizeThreadName(text.trim() || message.attachments?.first?.()?.name || "")
      const created = await deps.createThread({ channelId: project.channelId, title, prompt: promptText, authorId: message.author.id })
      if (created.notice) await deps.bucketFor(project.channelId).schedule(() => message.reply(renderPayload(created.notice!)))
      if (!created.notice || created.notice.startsWith("queued")) deps.startTyping(created.threadId)
    } catch (err) {
      deps.log.error("message handler failed", { error: String(err) })
      try {
        if (message?.channel && typeof message.reply === "function") {
          await deps.bucketFor(message.channelId).schedule(() => message.reply(renderPayload("Something went wrong handling that message; check the bot logs.")))
        }
      } catch {}
    }
  }
}

export interface ProjectDownDeps {
  runner: Pick<Runner, "handleProjectDown">
  client: { channels: { cache: { get(id: string): any } } }
  bucketFor(channelId: string): Bucket
  log: Logger
}

export function createProjectDownHandler(deps: ProjectDownDeps): (channelId: string) => void {
  return (channelId: string): void => {
    void deps.runner.handleProjectDown(channelId).catch((e) => deps.log.warn("project down reset failed", { channelId, error: String(e) }))
    const channel = deps.client.channels.cache.get(channelId)
    if (channel && "send" in channel) {
      void deps.bucketFor(channelId)
        .schedule(() => channel.send(renderPayload("The project server stopped unexpectedly; it will restart on the next message.")))
        .catch(() => {})
    } else {
      deps.log.warn("project down but the channel is unavailable", { channelId })
    }
  }
}

export function createProjectMissingHandler(deps: ProjectDownDeps): (channelId: string, projectName: string) => void {
  return (channelId: string, projectName: string): void => {
    void deps.runner.handleProjectDown(channelId).catch((e) => deps.log.warn("project down reset failed", { channelId, error: String(e) }))
    const channel = deps.client.channels.cache.get(channelId)
    if (channel && "send" in channel) {
      void deps.bucketFor(channelId)
        .schedule(() => channel.send(renderPayload(`The sandbox for **${projectName}** is missing. Run /project start to recreate it.`)))
        .catch(() => {})
    } else {
      deps.log.warn("sandbox missing but the channel is unavailable", { channelId })
    }
  }
}

export interface ShutdownDeps {
  log: Logger
  abortControllers(): Iterable<AbortController>
  stopProjects(): Promise<void>
  destroyClient(): void
  closeDb(): void
  releaseLock(): void
  exit(code: number): void
}

export function createShutdown(deps: ShutdownDeps): (code?: number) => Promise<void> {
  let shuttingDown = false
  return async function shutdown(code = 0): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    deps.log.info("shutting down")
    for (const controller of deps.abortControllers()) controller.abort()
    await deps.stopProjects()
    deps.destroyClient()
    deps.closeDb()
    deps.releaseLock()
    deps.exit(code)
  }
}

export interface ReconcileDeps {
  db: Pick<Db, "threads" | "projects">
  runner: Pick<Runner, "recover">
  log: Logger
}

/** Boot/restart reconcile: re-attach live runs and reset stale render states. */
export function createReconcileThreads(deps: ReconcileDeps): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  const run = async (): Promise<void> => {
    for (const thread of deps.db.threads.recent(1000)) {
      const project = deps.db.projects.getByChannel(thread.channelId)
      if (!project || project.status !== "ready") {
        if (thread.renderState !== "idle") deps.db.threads.setRenderState(thread.threadId, "idle")
        continue
      }
      if (thread.renderState === "running" || thread.renderState === "aborting") {
        try {
          await deps.runner.recover({ threadId: thread.threadId, sessionId: thread.sessionId })
        } catch (err) {
          deps.log.warn("boot reconcile failed for thread", { threadId: thread.threadId, error: String(err) })
          deps.db.threads.setRenderState(thread.threadId, "idle")
        }
      } else if (thread.renderState !== "idle") {
        deps.db.threads.setRenderState(thread.threadId, "idle")
      }
    }
  }
  return function reconcileThreads(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = run().finally(() => { inFlight = undefined })
    return inFlight
  }
}

export interface ReadyDeps {
  log: Logger
  subscribeReadyProjects(): void | Promise<void>
  reconcileThreads(): Promise<void>
}

export function createReadyHandler(deps: ReadyDeps): () => void {
  return (): void => {
    void (async () => {
      try { await deps.subscribeReadyProjects() } catch (err) { deps.log.error("boot subscribe failed", { error: String(err) }) }
      await deps.reconcileThreads().catch((err) => deps.log.error("boot reconcile failed", { error: String(err) }))
    })()
  }
}
