import { pathToFileURL } from "node:url"
import { ChannelType, Events } from "discord.js"
import type { Interaction, Message } from "discord.js"
import type { Project, Thread } from "./types.ts"
import { loadConfig } from "./config.js"
import { createLogger } from "./log.js"
import { openDb } from "./db.js"
import { Sbx, SbxRunner } from "./sbx.js"
import { ProjectService } from "./projects.js"
import { createDiscordClient, isAuthorized, rolesOf, shouldHandleMessage } from "./discord.js"
import { commandData, handleCommand } from "./commands.js"
import { acquireLock } from "./lock.js"
import { Runner } from "./runner.js"
import { EventRouter } from "./events.js"
import { Renderer, sanitizeThreadName } from "./render.js"
import { createClient } from "./opencode.js"
import { runShell } from "./shell.js"

export function findCategoryId(
  guild: { channels: { cache: { values(): IterableIterator<{ id: string; name: string; type: ChannelType }> } } },
  configuredId?: string,
): string | undefined {
  if (configuredId) return configuredId
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildCategory && channel.name === "Eregion") return channel.id
  }
  return undefined
}

export function sessionIdFrom(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const record = result as { id?: unknown; data?: { id?: unknown } }
  if (typeof record.data?.id === "string") return record.data.id
  if (typeof record.id === "string") return record.id
  return undefined
}

export function projectForChannel<T extends { channelId: string }>(
  projects: T[],
  channelId: string,
  parentId?: string | null,
): T | undefined {
  return projects.find((p) => p.channelId === channelId || (parentId != null && p.channelId === parentId))
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const log = createLogger({ level: cfg.logLevel, file: `${cfg.dataDir}/bot.log`, secrets: [cfg.discordToken] })
  const lock = await acquireLock(4555)
  const db = openDb(`${cfg.dataDir}/bot.db`)
  db.migrate()
  if (cfg.defaultModel) db.settings.set("default_model", cfg.defaultModel)
  if (cfg.defaultAgent) db.settings.set("default_agent", cfg.defaultAgent)

  const sbxRunner = new SbxRunner()
  const sbx = new Sbx(sbxRunner, cfg.sandboxTemplate)
  let probe: { code: number }
  try {
    probe = await sbxRunner.run(["version"])
  } catch {
    lock.release(); db.close()
    throw new Error("sbx CLI not found; install Docker Sandboxes and run `sbx login`")
  }
  if (probe.code !== 0) {
    lock.release(); db.close()
    throw new Error("sbx CLI not available or not logged in; run `sbx login`")
  }

  const client = createDiscordClient(cfg)
  await client.login(cfg.discordToken)
  const guild = await client.guilds.fetch(cfg.guildId)
  await guild.commands.set(commandData())

  const sessionToThread = new Map<string, string>()
  const registerSession = (threadId: string, sessionId: string): void => {
    sessionToThread.set(sessionId, threadId)
  }
  for (const thread of db.threads.recent(1000)) {
    if (thread.sessionId && !sessionToThread.has(thread.sessionId)) registerSession(thread.threadId, thread.sessionId)
  }

  const projects = new ProjectService({
    sbx, runner: sbxRunner, db, config: cfg, log,
    createChannel: async (name) => {
      const categoryId = findCategoryId(guild, cfg.categoryId)
        ?? (await guild.channels.create({ name: "Eregion", type: ChannelType.GuildCategory })).id
      const channel = await guild.channels.create({ name, parent: categoryId, type: ChannelType.GuildText })
      return channel.id
    },
    deleteChannel: async (id) => {
      const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null))
      if (channel) await channel.delete().catch(() => {})
    },
  })

  const clientFor = (threadId: string) => {
    const thread = db.threads.get(threadId)
    if (!thread) throw new Error(`unknown thread ${threadId}`)
    const project = db.projects.getByChannel(thread.channelId)
    if (!project) throw new Error(`unknown project for thread ${threadId}`)
    return createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
  }

  const runnerSvc = new Runner({
    db, clientFor,
    rendererFor: async (threadId) => {
      const thread = db.threads.get(threadId)
      if (!thread) throw new Error(`unknown thread ${threadId}`)
      const channel = await client.channels.fetch(threadId)
      if (!channel) throw new Error(`thread channel ${threadId} unavailable`)
      return new Renderer({
        send: async (content) => {
          const sent = await (channel as any).send({ content, allowedMentions: { parse: [] } })
          db.threads.setLiveMessage(threadId, sent.id)
          return sent.id as string
        },
        edit: async (messageId, content) => {
          const message = await (channel as any).messages.fetch(messageId)
          await message.edit({ content, allowedMentions: { parse: [] } })
        },
        now: () => Date.now(),
        intervalMs: cfg.editIntervalMs,
        onMessageId: (id) => db.threads.setLiveMessage(threadId, id),
      })
    },
    sessionFor: async (threadId) => {
      const thread = db.threads.get(threadId)
      if (!thread) throw new Error(`unknown thread ${threadId}`)
      if (thread.sessionId) return thread.sessionId
      const project = db.projects.getByChannel(thread.channelId)
      if (!project) throw new Error(`unknown project for thread ${threadId}`)
      const sdk = createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
      const created = await sdk.session.create({ body: { title: thread.title ?? undefined } })
      const sessionId = sessionIdFrom(created)
      if (!sessionId) throw new Error("opencode session.create returned no id")
      db.threads.upsert({ ...thread, sessionId })
      registerSession(threadId, sessionId)
      return sessionId
    },
    log: (message, fields) => log.info(message, fields),
    maxQueue: cfg.maxQueue,
    maxConcurrentRuns: cfg.maxConcurrentRuns,
  })

  const controllers = new Map<string, AbortController>()
  const subscribeProject = (project: Project): void => {
    if (controllers.has(project.channelId)) return
    const controller = new AbortController()
    controllers.set(project.channelId, controller)
    const router = new EventRouter({
      route: (sessionId) => sessionToThread.get(sessionId),
      onEvent: (threadId, event) => {
        void runnerSvc.onEvent(threadId, event).catch((err) => log.error("runner event failed", { threadId, error: String(err) }))
      },
      onResync: async (threadId, sessionId) => { await runnerSvc.recover({ threadId, sessionId }) },
      knownSessions: () => [...sessionToThread.entries()].map(([sessionId, threadId]) => ({ threadId, sessionId })),
    })
    void router.subscribe(`http://127.0.0.1:${project.hostPort}`, project.serverPassword, controller.signal)
      .catch((err) => { if (!controller.signal.aborted) log.warn("event subscription ended", { channelId: project.channelId, error: String(err) }) })
  }
  const subscribeReadyProjects = (): void => {
    for (const project of db.projects.list()) if (project.status === "ready") subscribeProject(project)
  }

  const isMemberAuthorized = (guildOwnerId: string, member: { id: string; roles: string[]; permissions: { has(bit: bigint): boolean } }): boolean =>
    isAuthorized(member, guildOwnerId, cfg)

  const onMessage = async (message: Message): Promise<void> => {
    try {
      if (!message.inGuild() || !message.member) return
      const parentId = message.channel.isThread() ? message.channel.parentId : null
      const project = projectForChannel(db.projects.list(), message.channelId, parentId)
      if (!project || !shouldHandleMessage(message, project.channelId)) return
      const member = message.member
      if (!isMemberAuthorized(message.guild.ownerId, { id: member.id, roles: rolesOf(member), permissions: member.permissions })) return
      const text = message.content
      if (text.startsWith("!")) {
        const command = text.slice(1).trim()
        if (!command) return
        await projects.ensureReady(project.channelId)
        const fresh = db.projects.getByChannel(project.channelId)
        if (!fresh) return
        for (const chunk of await runShell({ sbx, project: fresh }, command)) {
          await (message.channel as any).send({ content: chunk, allowedMentions: { parse: [] } })
        }
        return
      }
      if (!text.trim()) return
      const existing = db.threads.get(message.channelId)
      if (existing) {
        const notice = await runnerSvc.prompt(existing.threadId, text, message.author.id)
        if (notice) await message.reply({ content: notice, allowedMentions: { parse: [] } })
        return
      }
      if (message.channel.isThread()) return
      await projects.ensureReady(project.channelId)
      subscribeProject(project)
      const thread = await message.startThread({ name: sanitizeThreadName(text) })
      const sdk = createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
      const created = await sdk.session.create({ body: { title: sanitizeThreadName(text) } })
      const sessionId = sessionIdFrom(created)
      if (!sessionId) throw new Error("opencode session.create returned no id")
      const now = Date.now()
      const record: Thread = {
        threadId: thread.id, channelId: project.channelId, sessionId,
        title: sanitizeThreadName(text), model: db.settings.get("default_model") ?? null,
        agent: db.settings.get("default_agent") ?? null, worktreePath: null,
        liveMessageId: null, renderState: "idle", createdAt: now, lastActiveAt: now,
      }
      db.threads.upsert(record)
      registerSession(thread.id, sessionId)
      await runnerSvc.prompt(thread.id, text, message.author.id)
    } catch (err) {
      log.error("message handler failed", { error: String(err) })
    }
  }

  const onInteraction = async (interaction: Interaction): Promise<void> => {
    try {
      if (!interaction.isChatInputCommand()) return
      await handleCommand(interaction, {
        projects, runner: runnerSvc, db,
        authorized: () => {
          if (!interaction.inGuild() || !interaction.member || !interaction.memberPermissions) return false
          const member = interaction.member
          const roles = Array.isArray((member as any).roles) ? (member as any).roles as string[] : rolesOf(member as any)
          return isMemberAuthorized(interaction.guild!.ownerId, { id: interaction.user.id, roles, permissions: interaction.memberPermissions })
        },
      })
    } catch (err) {
      log.error("interaction handler failed", { error: String(err) })
    }
  }

  client.on(Events.MessageCreate, (message) => { void onMessage(message) })
  client.on(Events.InteractionCreate, (interaction) => { void onInteraction(interaction) })
  client.on(Events.ClientReady, () => subscribeReadyProjects())
  if (client.isReady()) subscribeReadyProjects()

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("shutting down")
    for (const controller of controllers.values()) controller.abort()
    for (const project of db.projects.list()) await projects.stop(project.channelId).catch(() => {})
    client.destroy()
    db.close()
    lock.release()
    process.exit(0)
  }
  process.on("SIGINT", () => { void shutdown() })
  process.on("SIGTERM", () => { void shutdown() })

  log.info("Cely ready", { guild: guild.name, permissions: guild.members.me?.permissions.toArray() })
}

const isMain = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
