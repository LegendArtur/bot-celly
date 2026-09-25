import { fileURLToPath, pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { ChannelType, Events, PermissionFlagsBits } from "discord.js"
import type { Guild, Interaction, Message } from "discord.js"
import type { Project, Thread } from "./types.ts"
import { ensureDataDir, loadConfig, loadDotEnv, seedSettings } from "./config.js"
import { createLogger } from "./log.js"
import { openDb } from "./db.js"
import { Sbx, SbxRunner } from "./sbx.js"
import { ProjectService } from "./projects.js"
import { createDiscordClient, isAuthorized, isOwner, rolesOf } from "./discord.js"
import { commandData, handleCommand, handleSelect } from "./commands.js"
import type { CommandDeps, CreateThreadInput } from "./commands.js"
import { acquireLock } from "./lock.js"
import { Runner } from "./runner.js"
import { EventRouter } from "./events.js"
import { Renderer, renderPayload, sanitizeThreadName } from "./render.js"
import { createClient } from "./opencode.js"
import { runShell } from "./shell.js"
import { ingestAttachments } from "./attachments.js"
import { ChannelBuckets, retryAfterMs, TokenBucket } from "./bucket.js"
import { SessionRoutes } from "./routing.js"
import { createMessageHandler, createProjectDownHandler, createProjectMissingHandler, createReadyHandler, createReconcileThreads, createShutdown } from "./handlers.js"
import { buildPromptText, channelIdForBucket, createSubscriptionGate, describeDiscordStartupError, findCategoryId, formatStartupBanner, projectForChannel, sanitizeChannelName, sessionIdFrom, uniqueChannelName } from "./helpers.js"

export { buildPromptText, createSubscriptionGate, findCategoryId, projectForChannel, sanitizeChannelName, sessionIdFrom, uniqueChannelName } from "./helpers.js"

async function main(): Promise<void> {
  loadDotEnv()
  const cfg = loadConfig(process.env)
  ensureDataDir(cfg.dataDir)
  ensureDataDir(cfg.projectsRoot)
  const secrets = [cfg.discordToken]
  const log = createLogger({ level: cfg.logLevel, file: `${cfg.dataDir}/bot.log`, secrets })
  const lock = await acquireLock(4555)
  const db = openDb(`${cfg.dataDir}/bot.db`)
  db.migrate()
  for (const project of db.projects.list()) secrets.push(project.serverPassword)
  seedSettings(db, cfg)

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
  // Spec §9/§14: the shared per-channel bucket is the rate-limit chokepoint;
  // a 429 pauses that channel's bucket for the server-supplied retry_after.
  const scheduleWithBucket = async <T>(channelId: string, fn: () => Promise<T>): Promise<T> => {
    const bucket = buckets.for(channelId)
    try { return await bucket.schedule(fn) }
    catch (e) {
      const wait = retryAfterMs(e, cfg.editIntervalMs)
      if (wait !== undefined) bucket.pause(wait)
      throw e
    }
  }
  const bucketFor = (channelId: string) => ({ schedule: <T>(fn: () => Promise<T>) => scheduleWithBucket(channelId, fn) })
  let guild: Guild | undefined
  const requireGuild = (): Guild => {
    if (!guild) throw new Error("Discord guild not ready")
    return guild
  }

  const sessionRoutes = new SessionRoutes()
  const registerSession = (threadId: string, sessionId: string): void => { sessionRoutes.register(sessionId, threadId) }
  for (const thread of db.threads.recent(1000)) {
    if (thread.sessionId) registerSession(thread.threadId, thread.sessionId)
  }

  const controllers = new Map<string, AbortController>()
  const subscriptionGate = createSubscriptionGate()
  let runnerSvc: Runner

  const projects = new ProjectService({
    sbx, runner: sbxRunner, db, config: cfg, log,
    createChannel: async (name) => {
      const activeGuild = requireGuild()
      const categoryId = findCategoryId(activeGuild, cfg.categoryId)
        ?? (await activeGuild.channels.create({ name: "Forge", type: ChannelType.GuildCategory })).id
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
    onProjectDown: createProjectDownHandler({
      runner: { handleProjectDown: (channelId) => runnerSvc.handleProjectDown(channelId) },
      client, bucketFor, log,
    }),
    onProjectMissing: createProjectMissingHandler({
      runner: { handleProjectDown: (channelId) => runnerSvc.handleProjectDown(channelId) },
      client, bucketFor, log,
    }),
    onProjectReady: (project) => { secrets.push(project.serverPassword); subscribeProject(project) },
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

  const ingestProjectAttachments = async (project: Project, message: Message): Promise<{ hostPath: string; sandboxPath: string }[]> => {
    const attachments = [...message.attachments.values()].map((a: any) => ({ name: a.name, size: a.size, contentType: a.contentType, url: a.url }))
    return ingestAttachments({
      projectDirectory: project.directory,
      sandboxPath: project.sandboxPath,
      attachments,
      maxBytes: cfg.attachmentMaxBytes,
      warn: (msg, fields) => log.warn(msg, fields),
    })
  }

  const typingTimers = new Map<string, ReturnType<typeof setInterval>>()
  const stopTyping = (threadId: string): void => {
    const timer = typingTimers.get(threadId)
    if (timer) { clearInterval(timer); typingTimers.delete(threadId) }
  }
  const startTyping = (threadId: string): void => {
    if (typingTimers.has(threadId)) return
    const thread = db.threads.get(threadId)
    const bucketChannelId = thread ? channelIdForBucket(thread) : threadId
    const tick = async (): Promise<void> => {
      try {
        const channel = await client.channels.fetch(threadId)
        if (channel && "sendTyping" in channel) await scheduleWithBucket(bucketChannelId, () => (channel as any).sendTyping())
      } catch {}
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 8000)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    typingTimers.set(threadId, timer)
  }

  runnerSvc = new Runner({
    db, clientFor,
    createRenderer: async (threadId, liveMessageId, liveMessageIds) => {
      const thread = db.threads.get(threadId)
      if (!thread) throw new Error(`unknown thread ${threadId}`)
      const channel = await client.channels.fetch(threadId)
      if (!channel) throw new Error(`thread channel ${threadId} unavailable`)
      // One bucket per project channel, shared by every thread (spec §9).
      const bucketChannelId = channelIdForBucket(thread)
      return new Renderer({
        initialMessageId: liveMessageId,
        initialMessageIds: liveMessageIds,
        send: async (content) => scheduleWithBucket(bucketChannelId, async () => {
          const sent = await (channel as any).send(renderPayload(content))
          db.threads.setLiveMessage(threadId, sent.id)
          return sent.id as string
        }),
        edit: async (messageId, content) => scheduleWithBucket(bucketChannelId, async () => {
          const message = await (channel as any).messages.fetch(messageId)
          await message.edit(renderPayload(content))
        }),
        delete: async (messageId) => scheduleWithBucket(bucketChannelId, async () => {
          const message = await (channel as any).messages.fetch(messageId).catch(() => null)
          if (message) await message.delete().catch(() => {})
        }),
        now: () => Date.now(),
        intervalMs: cfg.editIntervalMs,
        onMessageId: (id) => db.threads.setLiveMessage(threadId, id),
        onMessageIds: (ids) => db.threads.setLiveMessages(threadId, ids),
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

  const subscribeProject = (project: Project): void => {
    if (!subscriptionGate.claim(project.channelId)) return
    for (const thread of db.threads.byChannel(project.channelId)) if (thread.sessionId) registerSession(thread.threadId, thread.sessionId)
    const controller = new AbortController()
    controllers.set(project.channelId, controller)
    const router = new EventRouter({
      route: (sessionId) => sessionRoutes.route(sessionId, (threadId) => runnerSvc.isActive(threadId), (threadId) => db.threads.get(threadId)?.lastActiveAt ?? 0),
      onEvent: (threadId, event) => {
        void runnerSvc.onEvent(threadId, event).catch((err) => log.error("runner event failed", { threadId, error: String(err) }))
      },
      onResync: async (threadId, sessionId) => { await runnerSvc.recover({ threadId, sessionId }) },
      knownSessions: () => db.threads.byChannel(project.channelId)
        .filter((thread) => !!thread.sessionId
          && (runnerSvc.isActive(thread.threadId) || thread.renderState === "running" || thread.renderState === "aborting"))
        .map((thread) => ({ threadId: thread.threadId, sessionId: thread.sessionId })),
    })
    void router.subscribe(`http://127.0.0.1:${project.hostPort}`, project.serverPassword, controller.signal)
      .catch((err) => { if (!controller.signal.aborted) log.warn("event subscription ended", { channelId: project.channelId, error: String(err) }) })
  }
  const subscribeReadyProjects = (): void => {
    for (const project of db.projects.list()) if (project.status === "ready") subscribeProject(project)
  }
  const stopSubscription = (channelId: string): void => {
    subscriptionGate.release(channelId)
    const controller = controllers.get(channelId)
    if (controller) { controller.abort(); controllers.delete(channelId) }
    const threadIds = db.threads.byChannel(channelId).map((thread) => thread.threadId)
    sessionRoutes.forgetThreads(threadIds)
  }

  const reconcileThreads = createReconcileThreads({ db, runner: runnerSvc, log })

  const isMemberAuthorized = (guildOwnerId: string, member: { id: string; roles: string[]; permissions: { has(bit: bigint): boolean } }): boolean =>
    isAuthorized(member, guildOwnerId, cfg)

  const authorize = (interaction: any): boolean => {
    if (!interaction.inGuild?.() || !interaction.member || !interaction.memberPermissions) return false
    const member = interaction.member
    const roles = Array.isArray(member.roles) ? member.roles as string[] : rolesOf(member)
    return isMemberAuthorized(interaction.guild!.ownerId, { id: interaction.user.id, roles, permissions: interaction.memberPermissions })
  }
  const authorizeOwner = (interaction: any): boolean => {
    if (!interaction.inGuild?.() || !interaction.member) return false
    const member = interaction.member
    const roles = Array.isArray(member.roles) ? member.roles as string[] : rolesOf(member)
    return isOwner({ id: interaction.user.id, roles }, interaction.guild!.ownerId, cfg)
  }

  const startSubscription = (channelId: string): void => {
    const project = db.projects.getByChannel(channelId)
    if (project) subscribeProject(project)
  }

  const createThreadForProject = async (input: CreateThreadInput): Promise<{ threadId: string; sessionId: string; notice?: string }> => {
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
    let notice: string | undefined
    if (input.prompt) {
      notice = await runnerSvc.prompt(thread.id, input.prompt, input.authorId ?? "n/a")
      if (notice === undefined || notice.startsWith("queued")) startTyping(thread.id)
    }
    return { threadId: thread.id, sessionId, notice }
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
    isOwner: authorizeOwner,
    stopSubscription, startSubscription,
    createThread: createThreadForProject,
    listSessions, listModels, listAgents,
    setThreadModel, setThreadAgent,
    postConnected: async (channelId, projectName) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (channel && "send" in channel) {
        await scheduleWithBucket(channelId, () => (channel as any).send(renderPayload(`**${projectName}** is connected.`))).catch(() => {})
      }
    },
  }

  const onMessage = createMessageHandler({
    db, log, projects, runner: runnerSvc, bucketFor, subscribeProject,
    isAuthorized: (message: Message) => isMemberAuthorized(message.guild!.ownerId, { id: message.author.id, roles: rolesOf(message.member!), permissions: message.member!.permissions }),
    ingestAttachments: ingestProjectAttachments,
    runShell: async (channelId, command) => {
      const fresh = db.projects.getByChannel(channelId)
      if (!fresh) return []
      return runShell({ sbx, project: fresh }, command)
    },
    startTyping,
    createThread: createThreadForProject,
    registerSession,
  })

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
  client.on(Events.ClientReady, createReadyHandler({ log, subscribeReadyProjects, reconcileThreads }))

  const shutdown = createShutdown({
    log,
    abortControllers: () => controllers.values(),
    stopProjects: async () => { for (const project of db.projects.list()) await projects.stop(project.channelId).catch(() => {}) },
    destroyClient: () => client.destroy(),
    closeDb: () => db.close(),
    releaseLock: () => lock.release(),
    exit: (code) => process.exit(code),
  })
  process.on("SIGINT", () => { void shutdown() })
  process.on("SIGTERM", () => { void shutdown() })

  const isFatalDiscordError = (err: unknown): boolean =>
    /disallowed intents|invalid token|token was provided/i.test(err instanceof Error ? err.message : String(err))
  client.on(Events.Error, (err) => {
    log.error("discord client error", { error: String(err) })
    if (isFatalDiscordError(err)) { console.error(describeDiscordStartupError(err)); void shutdown(1) }
  })

  try {
    await client.login(cfg.discordToken)
  } catch (err) {
    console.error(describeDiscordStartupError(err))
    await shutdown(1)
    return
  }
  guild = await client.guilds.fetch(cfg.guildId)
  await guild.commands.set(commandData())
  if (client.isReady()) { subscribeReadyProjects(); void reconcileThreads().catch((err) => log.error("boot reconcile failed", { error: String(err) })) }

  log.info("Celly ready", { guild: guild.name })
  const required: Array<[string, bigint]> = [
    ["View Channels", PermissionFlagsBits.ViewChannel],
    ["Send Messages", PermissionFlagsBits.SendMessages],
    ["Send Messages in Threads", PermissionFlagsBits.SendMessagesInThreads],
    ["Create Public Threads", PermissionFlagsBits.CreatePublicThreads],
    ["Manage Channels", PermissionFlagsBits.ManageChannels],
    ["Manage Threads", PermissionFlagsBits.ManageThreads],
    ["Read Message History", PermissionFlagsBits.ReadMessageHistory],
    ["Embed Links", PermissionFlagsBits.EmbedLinks],
  ]
  const me = guild.members.me
  const missingPermissions = required.filter(([, bit]) => !(me?.permissions.has(bit) ?? false)).map(([name]) => name)
  console.log(formatStartupBanner({ guild: guild.name, projects: db.projects.list().length, dataDir: cfg.dataDir, model: cfg.defaultModel, missingPermissions }))
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
  main().catch((e) => { console.error(describeDiscordStartupError(e)); process.exit(1) })
}
