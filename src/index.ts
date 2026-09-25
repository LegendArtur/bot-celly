import { fileURLToPath, pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ChannelType, Events } from "discord.js"
import type { Guild, Interaction, Message } from "discord.js"
import type { Project, Thread } from "./types.ts"
import { loadConfig } from "./config.js"
import { createLogger } from "./log.js"
import { openDb } from "./db.js"
import { Sbx, SbxRunner } from "./sbx.js"
import { ProjectService } from "./projects.js"
import { createDiscordClient, isAuthorized, rolesOf, shouldHandleMessage } from "./discord.js"
import { commandData, handleCommand, handleSelect } from "./commands.js"
import type { CommandDeps, CreateThreadInput } from "./commands.js"
import { acquireLock } from "./lock.js"
import { Runner } from "./runner.js"
import { EventRouter } from "./events.js"
import { Renderer, sanitizeThreadName } from "./render.js"
import { createClient } from "./opencode.js"
import { runShell } from "./shell.js"
import { attachmentDestination, attachmentSandboxPath, shouldIngestAttachment } from "./attachments.js"
import { ChannelBuckets, TokenBucket } from "./bucket.js"

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

export function buildPromptText(text: string, attachmentPaths: string[]): string {
  return [text, ...attachmentPaths.map((p) => `[attachment] ${p}`)].filter((part) => part.trim().length > 0).join("\n\n")
}

const CHANNEL_NAME_MAX = 90
export function sanitizeChannelName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, CHANNEL_NAME_MAX)
    .replace(/[-._]+$/, "")
  return cleaned || "project"
}
export function uniqueChannelName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const candidate = base.slice(0, CHANNEL_NAME_MAX - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
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

  let policy: { code: number }
  try {
    policy = await sbxRunner.run(["policy", "ls"])
  } catch {
    lock.release(); db.close()
    throw new Error("sbx policy check failed; run `sbx policy init balanced`")
  }
  if (policy.code !== 0) {
    lock.release(); db.close()
    throw new Error("sbx network policy not initialized; run `sbx policy init balanced`")
  }

  const client = createDiscordClient(cfg)
  const buckets = new ChannelBuckets(() => new TokenBucket({
    capacity: 5,
    refillPerSecond: 1000 / Math.max(1, cfg.editIntervalMs),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }))
  const bucketFor = (channelId: string) => buckets.for(channelId)
  let guild: Guild | undefined
  const requireGuild = (): Guild => {
    if (!guild) throw new Error("Discord guild not ready")
    return guild
  }

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
      const activeGuild = requireGuild()
      const categoryId = findCategoryId(activeGuild, cfg.categoryId)
        ?? (await activeGuild.channels.create({ name: "Eregion", type: ChannelType.GuildCategory })).id
      const taken = new Set([...activeGuild.channels.cache.values()].map((c) => c.name))
      const channelName = uniqueChannelName(sanitizeChannelName(name), taken)
      const channel = await activeGuild.channels.create({ name: channelName, parent: categoryId, type: ChannelType.GuildText })
      return channel.id
    },
    deleteChannel: async (id) => {
      const activeGuild = requireGuild()
      const channel = activeGuild.channels.cache.get(id) ?? (await activeGuild.channels.fetch(id).catch(() => null))
      if (channel) await channel.delete().catch(() => {})
    },
    resolveSandboxPath: async (name) => {
      const r = await sbxRunner.run(["exec", name, "pwd"])
      const path = r.stdout.trim()
      if (r.code !== 0 || !path) throw new Error(`could not resolve in-sandbox workspace for ${name}`)
      return path
    },
    onProjectDown: (channelId) => {
      void runnerSvc.handleProjectDown(channelId)
      const channel = client.channels.cache.get(channelId)
      if (channel && "send" in channel) {
        void bucketFor(channelId).schedule(() => (channel as any).send({ content: "The project server stopped unexpectedly; it will restart on the next message.", allowedMentions: { parse: [] } })).catch(() => {})
      }
    },
  })

  const clientFor = (threadId: string) => {
    const thread = db.threads.get(threadId)
    if (!thread) throw new Error(`unknown thread ${threadId}`)
    const project = db.projects.getByChannel(thread.channelId)
    if (!project) throw new Error(`unknown project for thread ${threadId}`)
    return createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
  }

  const createSessionFor = async (project: Project, title: string): Promise<string> => {
    const sdk = createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
    const created = await sdk.session.create({ body: { title } })
    const sessionId = sessionIdFrom(created)
    if (!sessionId) throw new Error("opencode session.create returned no id")
    return sessionId
  }
  const registerThread = (project: Project, threadId: string, title: string, sessionId: string): Thread => {
    const now = Date.now()
    const record: Thread = {
      threadId, channelId: project.channelId, sessionId, title,
      model: db.settings.get("default_model") ?? null, agent: db.settings.get("default_agent") ?? null,
      worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: now, lastActiveAt: now,
    }
    db.threads.upsert(record)
    registerSession(threadId, sessionId)
    return record
  }

  const ingestAttachments = async (project: Project, message: Message): Promise<{ hostPath: string; sandboxPath: string }[]> => {
    const paths: { hostPath: string; sandboxPath: string }[] = []
    for (const attachment of message.attachments.values()) {
      const like = { name: attachment.name, size: attachment.size, contentType: attachment.contentType }
      if (!shouldIngestAttachment(like, cfg.attachmentMaxBytes)) continue
      try {
        const destination = attachmentDestination(project.directory, attachment.name, randomUUID())
        const res = await fetch(attachment.url)
        if (!res.ok) continue
        const body = Buffer.from(await res.arrayBuffer())
        if (body.byteLength > cfg.attachmentMaxBytes) continue
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, body)
        paths.push({ hostPath: destination, sandboxPath: attachmentSandboxPath(project.directory, project.sandboxPath, destination) })
      } catch (e) {
        log.warn("attachment ingest failed", { name: attachment.name, error: String(e) })
      }
    }
    return paths
  }

  const typingTimers = new Map<string, ReturnType<typeof setInterval>>()
  const stopTyping = (threadId: string): void => {
    const timer = typingTimers.get(threadId)
    if (timer) { clearInterval(timer); typingTimers.delete(threadId) }
  }
  const startTyping = (threadId: string): void => {
    if (typingTimers.has(threadId)) return
    const tick = async (): Promise<void> => {
      try {
        const channel = await client.channels.fetch(threadId)
        if (channel && "sendTyping" in channel) await (channel as any).sendTyping()
      } catch {}
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 8000)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    typingTimers.set(threadId, timer)
  }

  const runnerSvc = new Runner({
    db, clientFor,
    createRenderer: async (threadId) => {
      const thread = db.threads.get(threadId)
      if (!thread) throw new Error(`unknown thread ${threadId}`)
      const channel = await client.channels.fetch(threadId)
      if (!channel) throw new Error(`thread channel ${threadId} unavailable`)
      return new Renderer({
        send: async (content) => bucketFor(threadId).schedule(async () => {
          const sent = await (channel as any).send({ content, allowedMentions: { parse: [] } })
          db.threads.setLiveMessage(threadId, sent.id)
          return sent.id as string
        }),
        edit: async (messageId, content) => bucketFor(threadId).schedule(async () => {
          const message = await (channel as any).messages.fetch(messageId)
          await message.edit({ content, allowedMentions: { parse: [] } })
        }),
        delete: async (messageId) => bucketFor(threadId).schedule(async () => {
          const message = await (channel as any).messages.fetch(messageId).catch(() => null)
          if (message) await message.delete().catch(() => {})
        }),
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
    onThreadIdle: (threadId) => stopTyping(threadId),
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
      knownSessions: () => db.threads.byChannel(project.channelId)
        .filter((thread) => !!thread.sessionId)
        .map((thread) => ({ threadId: thread.threadId, sessionId: thread.sessionId })),
    })
    void router.subscribe(`http://127.0.0.1:${project.hostPort}`, project.serverPassword, controller.signal)
      .catch((err) => { if (!controller.signal.aborted) log.warn("event subscription ended", { channelId: project.channelId, error: String(err) }) })
  }
  const subscribeReadyProjects = (): void => {
    for (const project of db.projects.list()) if (project.status === "ready") subscribeProject(project)
  }
  const stopSubscription = (channelId: string): void => {
    const controller = controllers.get(channelId)
    if (controller) { controller.abort(); controllers.delete(channelId) }
    const threadIds = new Set(db.threads.byChannel(channelId).map((thread) => thread.threadId))
    for (const [sessionId, threadId] of sessionToThread) if (threadIds.has(threadId)) sessionToThread.delete(sessionId)
  }

  const isMemberAuthorized = (guildOwnerId: string, member: { id: string; roles: string[]; permissions: { has(bit: bigint): boolean } }): boolean =>
    isAuthorized(member, guildOwnerId, cfg)

  const authorize = (interaction: any): boolean => {
    if (!interaction.inGuild?.() || !interaction.member || !interaction.memberPermissions) return false
    const member = interaction.member
    const roles = Array.isArray(member.roles) ? member.roles as string[] : rolesOf(member)
    return isMemberAuthorized(interaction.guild!.ownerId, { id: interaction.user.id, roles, permissions: interaction.memberPermissions })
  }

  const startSubscription = (channelId: string): void => {
    const project = db.projects.getByChannel(channelId)
    if (project) subscribeProject(project)
  }

  const createThreadForProject = async (input: CreateThreadInput): Promise<{ threadId: string; sessionId: string }> => {
    const project = db.projects.getByChannel(input.channelId)
    if (!project) throw new Error(`unknown project channel ${input.channelId}`)
    await projects.ensureReady(project.channelId)
    subscribeProject(project)
    const channel = await client.channels.fetch(project.channelId)
    if (!channel || !("threads" in channel)) throw new Error("project channel unavailable")
    const title = sanitizeThreadName(input.title)
    const thread = await (channel as any).threads.create({ name: title })
    if (input.authorId) await thread.members.add(input.authorId).catch(() => {})
    const sessionId = input.sessionId ?? (await createSessionFor(project, title))
    registerThread(project, thread.id, title, sessionId)
    if (input.prompt) {
      const notice = await runnerSvc.prompt(thread.id, input.prompt, input.authorId ?? "n/a")
      if (notice === undefined) startTyping(thread.id)
    }
    return { threadId: thread.id, sessionId }
  }

  const listSessions = async (channelId: string): Promise<{ id: string; title: string }[]> => {
    const project = db.projects.getByChannel(channelId)
    if (!project) return []
    await projects.ensureReady(channelId).catch(() => {})
    try {
      const sdk = createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
      const res: any = await sdk.session.list()
      const data = res?.data ?? res
      const list = Array.isArray(data) ? data : []
      return list.map((s: any) => ({ id: String(s.id), title: String(s.title ?? s.id) }))
    } catch { return [] }
  }
  const listModels = async (channelId: string): Promise<{ id: string; name: string }[]> => {
    const project = db.projects.getByChannel(channelId)
    if (!project) return []
    try {
      const sdk = createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
      const res: any = await sdk.config.providers()
      const data = res?.data ?? res
      const providers = Array.isArray(data?.providers) ? data.providers : []
      const out: { id: string; name: string }[] = []
      for (const p of providers) {
        for (const [mid, model] of Object.entries(p.models ?? {})) out.push({ id: `${p.id}/${mid}`, name: (model as any)?.name ?? `${p.name ?? p.id}/${mid}` })
      }
      return out
    } catch { return [] }
  }
  const listAgents = async (channelId: string): Promise<{ id: string; name: string }[]> => {
    const project = db.projects.getByChannel(channelId)
    if (!project) return []
    try {
      const sdk = createClient(`http://127.0.0.1:${project.hostPort}`, project.serverPassword)
      const res: any = await sdk.app.agents()
      const data = res?.data ?? res
      const list = Array.isArray(data) ? data : []
      return list.filter((a: any) => a?.mode !== "subagent").map((a: any) => ({ id: String(a.name), name: a.description ? `${a.name} — ${a.description}` : String(a.name) }))
    } catch { return [] }
  }
  const setThreadModel = (threadId: string, model: string | null): void => { if (db.threads.get(threadId)) db.threads.setModel(threadId, model) }
  const setThreadAgent = (threadId: string, agent: string | null): void => { if (db.threads.get(threadId)) db.threads.setAgent(threadId, agent) }

  const commandDeps: CommandDeps = {
    projects, runner: runnerSvc, db,
    authorized: authorize,
    stopSubscription, startSubscription,
    createThread: createThreadForProject,
    listSessions, listModels, listAgents,
    setThreadModel, setThreadAgent,
  }

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
        subscribeProject(project)
        const fresh = db.projects.getByChannel(project.channelId)
        if (!fresh) return
        for (const chunk of await runShell({ sbx, project: fresh }, command)) {
          await bucketFor(project.channelId).schedule(() => (message.channel as any).send({ content: chunk, allowedMentions: { parse: [] } }))
        }
        return
      }
      const imported = await ingestAttachments(project, message)
      const promptText = buildPromptText(text, imported.map((a) => a.sandboxPath))
      if (!promptText.trim()) return
      const existing = db.threads.get(message.channelId)
      if (existing) {
        await projects.ensureReady(project.channelId)
        subscribeProject(project)
        if (existing.sessionId) registerSession(existing.threadId, existing.sessionId)
        const notice = await runnerSvc.prompt(existing.threadId, promptText, message.author.id)
        if (notice) await bucketFor(existing.channelId).schedule(() => message.reply({ content: notice, allowedMentions: { parse: [] } }))
        else startTyping(existing.threadId)
        return
      }
      if (message.channel.isThread()) return
      await projects.ensureReady(project.channelId)
      subscribeProject(project)
      const title = sanitizeThreadName(text.trim() || message.attachments.first()?.name || "")
      const thread = await message.startThread({ name: title })
      await thread.members.add(message.author.id)
      const sessionId = await createSessionFor(project, title)
      registerThread(project, thread.id, title, sessionId)
      const notice = await runnerSvc.prompt(thread.id, promptText, message.author.id)
      if (notice === undefined) startTyping(thread.id)
    } catch (err) {
      log.error("message handler failed", { error: String(err) })
    }
  }

  const onInteraction = async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isStringSelectMenu()) { await handleSelect(interaction, commandDeps); return }
      if (!interaction.isChatInputCommand()) return
      await handleCommand(interaction, commandDeps)
    } catch (err) {
      log.error("interaction handler failed", { error: String(err) })
    }
  }

  client.on(Events.MessageCreate, (message) => { void onMessage(message) })
  client.on(Events.InteractionCreate, (interaction) => { void onInteraction(interaction) })
  client.on(Events.ClientReady, () => subscribeReadyProjects())

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

  await client.login(cfg.discordToken)
  guild = await client.guilds.fetch(cfg.guildId)
  await guild.commands.set(commandData())
  if (client.isReady()) subscribeReadyProjects()

  log.info("Cely ready", { guild: guild.name, permissions: guild.members.me?.permissions.toArray() })
}

export function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
