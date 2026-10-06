import { fileURLToPath, pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { adminConsoleUrl, createAdminServer } from "./admin.js"
import type { AdminServer } from "./admin.js"
import { createBackupScheduler } from "./backup.js"
import { createTaskRunner } from "./tasks.js"
import { ChannelType, Events, PermissionFlagsBits } from "discord.js"
import type { Guild, Interaction, Message } from "discord.js"
import type { Project, Thread } from "./types.ts"
import { ensureDataDir, envFileFrom, loadConfig, loadDotEnv, seedSettings } from "./config.js"
import { createAuditLog } from "./audit.js"
import type { AuditDraft } from "./audit.ts"
import { createLogger } from "./log.js"
import { openDb } from "./db.js"
import { Sbx, SbxRunner } from "./sbx.js"
import { ProjectService } from "./projects.js"
import { WorktreeService, worktreeDefaultFor } from "./worktrees.js"
import { createDiscordClient, fetchConfiguredGuilds, isAuthorized, isOwner, rolesOf } from "./discord.js"
import { commandData, deployCommandsToGuilds, handleButton, handleCommand, handleModalSubmit, handleSelect, stopControls } from "./commands.js"
import type { CommandDeps, CreateThreadInput } from "./commands.js"
import { createAutoThreadResolver } from "./attach.js"
import { APPROVAL_TIMEOUT_MS, ApprovalManager } from "./approvals.js"
import { approvalModeFor } from "./mode.js"
import { acquireLock } from "./lock.js"
import { Runner, withDirectory } from "./runner.js"
import { EventRouter } from "./events.js"
import { Renderer, renderPayload, sanitizeThreadName } from "./render.js"
import { cardPayload, noticeCard } from "./cards.js"
import { bashDenyPatterns, resolveBaseUrl, resolveClient, resolveV2Client } from "./opencode.js"
import { createSessionOps } from "./session-utils.js"
import { createProjectLists } from "./lists.js"
import { runShell } from "./shell.js"
import { ingestAttachments } from "./attachments.js"
import { ChannelBuckets, retryAfterMs, TokenBucket } from "./bucket.js"
import { SessionRoutes } from "./routing.js"
import { createForkThread, createMessageHandler, createProjectDownHandler, createProjectMissingHandler, createReadyHandler, createReconcileThreads, createShutdown, createThreadArchiveHandler } from "./handlers.js"
import { isManualRename, ThreadNamer } from "./thread-name.js"
import { createIdleSweeper, formatIdleStopNotice } from "./idle.js"
import { createTypingIndicators } from "./typing.js"
import { buildPromptText, channelIdForBucket, createSubscriptionGate, describeDiscordStartupError, findCategoryId, formatStartupBanner, modelVariants, projectForChannel, sanitizeChannelName, seedThreadDefaults, sessionIdFrom, uniqueChannelName } from "./helpers.js"

export { buildPromptText, createSubscriptionGate, findCategoryId, modelVariants, projectForChannel, sanitizeChannelName, seedThreadDefaults, sessionIdFrom, uniqueChannelName } from "./helpers.js"

// Boot/upgrade wakes a stopped sandbox via `ensureReady`, which is not user
// activity. Record the wake so the idle sweeper does not immediately stop a
// project whose migrated `last_active_at` is still 0.
export async function touchAfterWake(
  projects: { ensureReady(channelId: string): Promise<unknown> },
  db: { projects: { touch(channelId: string, at: number): void } },
  channelId: string,
): Promise<void> {
  await projects.ensureReady(channelId)
  db.projects.touch(channelId, Date.now())
}

export async function main(): Promise<void> {
  loadDotEnv(envFileFrom())
  const cfg = loadConfig(process.env)
  ensureDataDir(cfg.dataDir)
  ensureDataDir(cfg.projectsRoot)
  const lock = await acquireLock(4555)
  const secrets = [cfg.discordToken]
  if (cfg.githubToken) secrets.push(cfg.githubToken)
  const log = createLogger({ level: cfg.logLevel, file: `${cfg.dataDir}/bot.log`, secrets, truncate: true, maxBytes: cfg.logMaxBytes, maxFiles: cfg.logMaxFiles })
  const db = openDb(`${cfg.dataDir}/bot.db`)
  db.migrate()
  for (const project of db.projects.list()) secrets.push(project.serverPassword)
  seedSettings(db, cfg)
  const auditLog = createAuditLog({ file: `${cfg.dataDir}/audit.jsonl`, error: (message, fields) => log.error(message, fields) })
  const audit = (entry: AuditDraft): void => auditLog.append({
    ...entry,
    channelId: entry.channelId ?? db.threads.get(entry.threadId)?.channelId ?? entry.threadId,
  })

  const backups = cfg.backupIntervalHours > 0
    ? createBackupScheduler({
        db, dir: join(cfg.dataDir, "backups"),
        intervalMs: cfg.backupIntervalHours * 3_600_000,
        keep: cfg.backupKeep, now: () => Date.now(),
        warn: (message, fields) => log.warn(message, fields),
      })
    : undefined
  backups?.start()

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
  const guildsById = new Map<string, Guild>()
  const resolveGuild = async (guildId: string): Promise<Guild> => {
    const cached = guildsById.get(guildId)
    if (cached) return cached
    const fetched = await client.guilds.fetch(guildId)
    guildsById.set(guildId, fetched)
    return fetched
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
    createChannel: async (guildId, name) => {
      const activeGuild = await resolveGuild(guildId)
      const categoryId = findCategoryId(activeGuild, cfg.categoryId)
        ?? (await activeGuild.channels.create({ name: "Forge", type: ChannelType.GuildCategory })).id
      const taken = new Set([...activeGuild.channels.cache.values()].map((c) => c.name))
      const channelName = uniqueChannelName(sanitizeChannelName(name), taken)
      const channel = await activeGuild.channels.create({ name: channelName, parent: categoryId, type: ChannelType.GuildText })
      return channel.id
    },
    deleteChannel: async (guildId, id) => {
      const activeGuild = await resolveGuild(guildId).catch(() => undefined)
      const channel = activeGuild?.channels.cache.get(id) ?? (activeGuild ? await activeGuild.channels.fetch(id).catch(() => null) : null)
      if (channel) await channel.delete().catch(() => {})
    },
    resolveSandboxPath: async (name) => {
      const r = await sbxRunner.run(["exec", name, "pwd"], { timeoutMs: 15_000 })
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
    onProjectReady: (project) => { secrets.push(project.serverPassword); db.projects.touch(project.channelId, Date.now()); subscribeProject(project); warmLists(project.channelId) },
    onProjectRemoved: (project) => {
      const index = secrets.indexOf(project.serverPassword)
      if (index >= 0) secrets.splice(index, 1)
    },
  })

  const clientFor = (threadId: string) => {
    const thread = db.threads.get(threadId)
    if (!thread) throw new Error(`unknown thread ${threadId}`)
    const project = db.projects.getByChannel(thread.channelId)
    if (!project) throw new Error(`unknown project for thread ${threadId}`)
    return resolveClient(project)
  }

  const directoryFor = (threadId: string): string | undefined => db.threads.get(threadId)?.worktreePath ?? undefined
  const sessions = createSessionOps({
    targetFor: (threadId) => {
      const thread = db.threads.get(threadId)
      if (!thread) return undefined
      const directory = directoryFor(threadId)
      return directory ? { sessionId: thread.sessionId, directory } : { sessionId: thread.sessionId }
    },
    clientFor,
    threadModel: (threadId) => db.threads.get(threadId)?.model,
    modelLimit: async (threadId, model) => {
      const thread = db.threads.get(threadId)
      if (!thread) return undefined
      const project = db.projects.getByChannel(thread.channelId)
      if (!project) return undefined
      const slash = model.indexOf("/")
      if (slash <= 0) return undefined
      try {
        const res: any = await resolveClient(project).config.providers()
        const data = res?.data ?? res
        const provider = (data?.providers ?? []).find((p: any) => p?.id === model.slice(0, slash))
        const limit = provider?.models?.[model.slice(slash + 1)]?.limit?.context
        return typeof limit === "number" && limit > 0 ? limit : undefined
      } catch { return undefined }
    },
  })

  const projectForThread = (threadId: string): Project => {
    const thread = db.threads.get(threadId)
    const project = thread ? db.projects.getByChannel(thread.channelId) : undefined
    if (!project) throw new Error(`unknown project for thread ${threadId}`)
    return project
  }
  const v2ClientFor = (threadId: string) => resolveV2Client(projectForThread(threadId))

  const createSessionFor = async (project: Project, title: string, directory?: string | null): Promise<string> => {
    const sdk = resolveClient(project)
    const created = await sdk.session.create(withDirectory(directory, { body: { title } }) as any)
    const sessionId = sessionIdFrom(created)
    if (!sessionId) throw new Error("opencode session.create returned no id")
    return sessionId
  }
  const registerThread = (project: Project, threadId: string, title: string, sessionId: string, worktreePath: string | null = null, originMessageId: string | null = null): Thread => {
    const now = Date.now()
    const defaults = seedThreadDefaults((key) => db.settings.get(key), project.channelId)
    const record: Thread = {
      threadId, channelId: project.channelId, sessionId, title,
      model: defaults.model, agent: defaults.agent, variant: defaults.variant,
      worktreePath, liveMessageId: null, originMessageId, archiveNoticeAt: null,
      renderState: "idle", nameLocked: false, nameManual: false, lastThreadName: null,
      createdAt: now, lastActiveAt: now,
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

  const typing = createTypingIndicators({
    bucketFor: (threadId) => { const thread = db.threads.get(threadId); return thread ? channelIdForBucket(thread) : threadId },
    sendTyping: async (threadId, bucketChannelId) => {
      const channel = await client.channels.fetch(threadId)
      if (channel && "sendTyping" in channel) await scheduleWithBucket(bucketChannelId, () => (channel as any).sendTyping())
    },
  })
  const startTyping = typing.start
  const stopTyping = typing.stop

  const threadChannel = async (threadId: string): Promise<any> => {
    const channel = await client.channels.fetch(threadId)
    if (!channel) throw new Error(`thread channel ${threadId} unavailable`)
    return channel
  }
  const threadBucket = (threadId: string): string => {
    const thread = db.threads.get(threadId)
    return thread ? channelIdForBucket(thread) : threadId
  }
  const approvals = new ApprovalManager({
    send: async (threadId, content, components) => {
      const channel = await threadChannel(threadId)
      const sent = await scheduleWithBucket<{ id: string }>(threadBucket(threadId), () => (channel as any).send({ ...renderPayload(content), components }))
      return sent.id
    },
    edit: async (threadId, messageId, content, components) => {
      const channel = await threadChannel(threadId)
      const message = await (channel as any).messages.fetch(messageId)
      await scheduleWithBucket(threadBucket(threadId), () => message.edit({ ...renderPayload(content), components }))
    },
    onQuestionState: (update) => runnerSvc.onQuestionState(update),
    replyPermission: async ({ threadId, sessionId, requestId, reply, source }) => {
      if (source === "v2") {
        await v2ClientFor(threadId).v2.session.permission.reply({ sessionID: sessionId, requestID: requestId, reply })
        return
      }
      const sdk = resolveClient(projectForThread(threadId))
      await sdk.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: requestId }, body: { response: reply } } as any)
    },
    replyQuestion: async ({ threadId, sessionId, requestId, source, answers }) => {
      if (source === "v2") {
        await v2ClientFor(threadId).v2.session.question.reply({ sessionID: sessionId, requestID: requestId, questionV2Reply: { answers } })
        return
      }
      // v1 questions live in the instance-scoped registry served by
      // POST /question/:requestID/reply, keyed by directory. Replying through
      // the v2 session route answers a different registry and never lands.
      const directory = directoryFor(threadId)
      await v2ClientFor(threadId).question.reply({ requestID: requestId, answers, ...(directory ? { directory } : {}) })
    },
    rejectQuestion: async ({ threadId, sessionId, requestId, source }) => {
      if (source === "v2") {
        await v2ClientFor(threadId).v2.session.question.reject({ sessionID: sessionId, requestID: requestId })
        return
      }
      const directory = directoryFor(threadId)
      await v2ClientFor(threadId).question.reject({ requestID: requestId, ...(directory ? { directory } : {}) })
    },
    onQuestionDeliveryFailed: ({ threadId, requestId, action, error }) => {
      log.warn("question delivery failed; aborting run", { threadId, requestId, action, error })
      void runnerSvc.abort(threadId).catch((err) => log.warn("abort after question failure failed", { threadId, error: String(err) }))
    },
    modeFor: (threadId) => approvalModeFor(db.settings, db.threads.get(threadId)?.channelId ?? threadId),
    now: () => Date.now(),
    timeoutMs: APPROVAL_TIMEOUT_MS,
    audit,
    log: (message, fields) => log.warn(message, fields),
  })

  const threadNamer = new ThreadNamer({
    enabled: () => cfg.smartThreadNames,
    rename: async (threadId, name) => {
      const thread = db.threads.get(threadId)
      if (!thread || thread.nameManual) return
      db.threads.setLastThreadName(threadId, name)
      const channel = await client.channels.fetch(threadId)
      if (channel && typeof (channel as any).setName === "function") {
        await scheduleWithBucket(threadBucket(threadId), () => (channel as any).setName(name))
      }
    },
    getTitle: (threadId) => db.threads.get(threadId)?.title ?? null,
    isLocked: (threadId) => db.threads.get(threadId)?.nameLocked ?? false,
    setLockedTitle: (threadId, title) => { db.threads.setTitle(threadId, title); db.threads.setNameLocked(threadId, true) },
    now: () => Date.now(),
    log: (message, fields) => log.warn(message, fields),
  })

  runnerSvc = new Runner({
    db, clientFor,
    createRenderer: async (threadId, liveMessageId, liveMessageIds, prompt) => {
      const thread = db.threads.get(threadId)
      if (!thread) throw new Error(`unknown thread ${threadId}`)
      const channel = await client.channels.fetch(threadId)
      if (!channel) throw new Error(`thread channel ${threadId} unavailable`)
      // One bucket per project channel, shared by every thread (spec §9).
      const bucketChannelId = channelIdForBucket(thread)
      return new Renderer({
        initialMessageId: liveMessageId,
        initialMessageIds: liveMessageIds,
        prompt,
        controls: stopControls(threadId),
        send: async (content, components) => scheduleWithBucket(bucketChannelId, async () => {
          const sent = await (channel as any).send({ ...renderPayload(content), components: components ?? [] })
          db.threads.setLiveMessage(threadId, sent.id)
          return sent.id as string
        }),
        edit: async (messageId, content, components) => scheduleWithBucket(bucketChannelId, async () => {
          const message = await (channel as any).messages.fetch(messageId)
          await message.edit({ ...renderPayload(content), components: components ?? [] })
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
      const sdk = resolveClient(project)
      const created = await sdk.session.create(withDirectory(thread.worktreePath, { body: { title: thread.title ?? undefined } }) as any)
      const sessionId = sessionIdFrom(created)
      if (!sessionId) throw new Error("opencode session.create returned no id")
      db.threads.upsert({ ...thread, sessionId })
      registerSession(threadId, sessionId)
      return sessionId
    },
    directoryFor: (threadId) => db.threads.get(threadId)?.worktreePath ?? undefined,
    log: (message, fields) => log.info(message, fields),
    maxQueue: cfg.maxQueue,
    maxConcurrentRuns: cfg.maxConcurrentRuns,
    // Mirror the sandbox policy: `git push` is only approval-gated (not denied)
    // when a shared GitHub token is configured.
    denyPatterns: bashDenyPatterns({ githubToken: cfg.githubToken }),
    approvalModeFor: (channelId) => approvalModeFor(db.settings, channelId),
    respondPermission: async ({ source, threadId, sessionId, requestId, reply }) => {
      if (source === "v2") {
        await v2ClientFor(threadId).v2.session.permission.reply({ sessionID: sessionId, requestID: requestId, reply })
        return
      }
      const sdk = resolveClient(projectForThread(threadId))
      await sdk.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: requestId }, body: { response: reply } } as any)
    },
    approvals,
    audit,
    budgetUsd: cfg.sessionBudgetUsd,
    notify: async (channelId, text) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (channel && "send" in channel) await scheduleWithBucket(channelId, () => (channel as any).send(renderPayload(text))).catch(() => {})
    },
    onThreadIdle: (threadId) => stopTyping(threadId),
    onThreadState: (threadId, status) => threadNamer.setStatus(threadId, status),
    onFinalText: (threadId, text) => threadNamer.noteFinalText(threadId, text),
  })

  const worktrees = new WorktreeService({ sbx, db, log })

  const forkThread = createForkThread({
    db, client, runner: runnerSvc,
    ensureReady: (channelId) => projects.ensureReady(channelId),
    resolveClient,
    registerSession,
    startTyping,
    worktree: worktrees,
    log,
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
      onUnknownSession: (sessionId) => controller.signal.aborted ? Promise.resolve(undefined) : autoThread(project, sessionId),
      knownSessions: () => db.threads.byChannel(project.channelId)
        .filter((thread) => !!thread.sessionId
          && (runnerSvc.isActive(thread.threadId) || thread.renderState === "running" || thread.renderState === "aborting"))
        .map((thread) => ({ threadId: thread.threadId, sessionId: thread.sessionId })),
      log: { warn: (message, fields) => log.warn(message, { channelId: project.channelId, ...fields }) },
    })
    void router.subscribe(resolveBaseUrl(project), project.serverPassword, controller.signal)
      .catch((err) => { if (!controller.signal.aborted) log.warn("event subscription ended", { channelId: project.channelId, error: String(err) }) })
  }
  const subscribeReadyProjects = async (): Promise<void> => {
    for (const project of db.projects.list()) {
      if (project.status === "provisioning") continue
      try {
        // After a restart the sandbox may be stopped and the serve child is
        // always gone (it died with the previous bot process). Wake and boot it
        // before subscribing, otherwise the SSE connection refuses forever.
        // The wake also counts as activity so the idle sweeper does not stop
        // every project right after boot.
        await touchAfterWake(projects, db, project.channelId)
      } catch (e) {
        log.warn("project not ready at boot", { channelId: project.channelId, error: String(e) })
        continue
      }
      const fresh = db.projects.getByChannel(project.channelId)
      if (fresh) subscribeProject(fresh)
      warmLists(project.channelId)
    }
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

  let admin: AdminServer | undefined
  if (cfg.adminPort > 0) {
    try {
      admin = await createAdminServer({
        port: cfg.adminPort,
        db,
        secrets,
        guildIds: cfg.guildIds,
        log,
        logFileFor: (channelId) => {
          const project = db.projects.getByChannel(channelId)
          return project ? join(cfg.dataDir, "logs", `${project.sandboxName}.log`) : undefined
        },
        start: async (channelId) => { await projects.start(channelId); startSubscription(channelId) },
        stop: async (channelId) => {
          await runnerSvc.resetChannel(channelId, { notify: true })
          stopSubscription(channelId)
          await projects.stop(channelId)
        },
        restart: async (channelId) => {
          stopSubscription(channelId)
          await projects.restartServer(channelId)
          startSubscription(channelId)
        },
        remove: async (channelId) => {
          await runnerSvc.resetChannel(channelId, { notify: true })
          stopSubscription(channelId)
          await projects.remove(channelId)
        },
        create: async (input, onProgress) => {
          if (input.branch && !input.cloneUrl) throw new Error("branch requires clone")
          const directory = input.path
            ? await projects.prepareProjectDirectory(input.path)
            : await projects.createProjectDirectory(input.name)
          const clone = input.cloneUrl ? { url: input.cloneUrl, ...(input.branch ? { branch: input.branch } : {}) } : undefined
          return projects.addProject({ guildId: input.guildId, name: input.name, directory, ...(clone ? { clone } : {}) }, onProgress)
        },
        auditTail: (limit) => auditLog.tail(limit),
      })
      log.info("admin server listening", { port: admin.port })
    } catch (e) {
      log.warn("admin server failed to start", { port: cfg.adminPort, error: String(e) })
    }
  }
  // Only advertise the console when the server actually started; a failed bind
  // or ADMIN_PORT=0 leaves it undefined so /dashboard says it is disabled.
  const adminUrl = admin ? adminConsoleUrl(admin.port) : undefined

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
    const ready = db.projects.getByChannel(input.channelId) ?? project
    const worktreePath = !input.sessionId && worktreeDefaultFor((key) => db.settings.get(key), project.channelId)
      ? await worktrees.ensure(ready, thread.id)
      : null
    const sessionId = input.sessionId ?? (await createSessionFor(project, title, worktreePath))
    registerThread(project, thread.id, title, sessionId, worktreePath, input.originMessageId ?? null)
    let notice: string | undefined
    if (input.prompt) {
      notice = await runnerSvc.prompt(thread.id, input.prompt, input.authorId ?? "n/a")
      if (notice === undefined || notice.startsWith("queued")) startTyping(thread.id)
    }
    return { threadId: thread.id, sessionId, notice }
  }

  const autoThread = createAutoThreadResolver({
    enabled: cfg.attachAutoThread,
    sessionTitle: async (project, sessionId) => {
      const sdk = resolveClient(project)
      const res: any = await sdk.session.get({ path: { id: sessionId } })
      const data = res?.data ?? res
      const title = typeof data?.title === "string" ? data.title.trim() : ""
      return title || undefined
    },
    createThread: createThreadForProject,
    log,
  })

  const taskRunner = createTaskRunner({
    db,
    now: () => Date.now(),
    everyMs: 30_000,
    prompt: (threadId, text, actor) => runnerSvc.prompt(threadId, text, actor),
    ensureThread: async (channelId) => (await createThreadForProject({ channelId, title: "scheduled task" })).threadId,
    log: { warn: (message, fields) => log.warn(message, fields) },
    audit,
  })
  taskRunner.start()

  const lists = createProjectLists({
    projectFor: (channelId) => db.projects.getByChannel(channelId),
    ensureReady: (channelId) => projects.ensureReady(channelId),
    clientFor: (project) => resolveClient(project),
    modelVariants,
    log,
  })
  const { listSessions, listModels, listAgents, warmLists } = lists
  const setThreadModel = (threadId: string, model: string | null): void => { if (db.threads.get(threadId)) db.threads.setModel(threadId, model) }
  const setThreadAgent = (threadId: string, agent: string | null): void => { if (db.threads.get(threadId)) db.threads.setAgent(threadId, agent) }
  const setThreadVariant = (threadId: string, variant: string | null): void => { if (db.threads.get(threadId)) db.threads.setVariant(threadId, variant) }
  const setChannelModel = (channelId: string, model: string | null): void => {
    if (!model || !db.projects.getByChannel(channelId)) return
    db.settings.set(`default_model:${channelId}`, model)
  }
  const setChannelAgent = (channelId: string, agent: string | null): void => {
    if (!agent || !db.projects.getByChannel(channelId)) return
    db.settings.set(`default_agent:${channelId}`, agent)
  }
  const setChannelVariant = (channelId: string, variant: string | null): void => {
    if (!db.projects.getByChannel(channelId)) return
    if (variant) db.settings.set(`default_variant:${channelId}`, variant)
    else db.settings.set(`default_variant:${channelId}`, "")
  }
  // Archive prompt "Remove session": delete the OpenCode session (best effort,
  // to reclaim sandbox disk), then roll up usage and drop the thread row.
  const removeThreadSession = async (threadId: string): Promise<boolean> => {
    const thread = db.threads.get(threadId)
    if (!thread) return false
    const project = db.projects.getByChannel(thread.channelId)
    if (project) {
      try {
        await resolveClient(project).session.delete(withDirectory(thread.worktreePath, { path: { id: thread.sessionId } }) as any)
      } catch (err) {
        log.warn("session delete failed", { threadId, sessionId: thread.sessionId, error: String(err) })
      }
    }
    db.threads.prune(threadId)
    threadNamer.cancel(threadId)
    sessionRoutes.forgetThread(threadId)
    audit({ kind: "session", channelId: thread.channelId, threadId, actorId: "archive-prompt", detail: `remove session ${thread.sessionId}`, decision: "removed" })
    return true
  }

  const commandDeps: CommandDeps = {
    projects, runner: runnerSvc, db,
    approvals,
    audit,
    authorized: authorize,
    isOwner: authorizeOwner,
    stopSubscription, startSubscription,
    createThread: createThreadForProject,
    forkThread,
    listSessions, listModels, listAgents,
    setThreadModel, setThreadAgent, setThreadVariant, setChannelModel, setChannelAgent, setChannelVariant,
    sessions,
    removeSession: removeThreadSession,
    worktree: worktrees,
    sessionBudgetUsd: cfg.sessionBudgetUsd,
    adminUrl,
    postConnected: async (channelId, projectName) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (channel && "send" in channel) {
        await scheduleWithBucket(channelId, () => (channel as any).send(cardPayload(noticeCard("ok", `${projectName} connected`)))).catch(() => {})
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
    audit,
  })

  const onInteraction = async (interaction: Interaction): Promise<void> => {
    try {
      // Buttons and modals are dispatched through the shared handlers owned by
      // this feature; later plans add their own `handle*` branch inside
      // `handleButton` rather than redefining the dispatcher (spec §3.1).
      if (interaction.isButton()) { await handleButton(interaction, commandDeps); return }
      if (interaction.isModalSubmit()) { await handleModalSubmit(interaction, commandDeps); return }
      if (interaction.isStringSelectMenu()) { await handleSelect(interaction, commandDeps); return }
      if (!interaction.isChatInputCommand()) return
      await handleCommand(interaction, commandDeps)
    } catch (err) {
      log.error("interaction handler failed", { error: err instanceof Error ? err.stack ?? err.message : String(err) })
    }
  }

  client.on(Events.MessageCreate, (message) => { void onMessage(message) })
  client.on(Events.InteractionCreate, (interaction) => { void onInteraction(interaction) })
  client.on(Events.ClientReady, createReadyHandler({ log, subscribeReadyProjects, reconcileThreads }))
  const onThreadUpdate = createThreadArchiveHandler({
    db,
    isActive: (id) => runnerSvc.isActive(id),
    now: () => Date.now(),
    log,
    send: async (channelId, payload, replyToMessageId) => {
      const channel = await client.channels.fetch(channelId).catch(() => null) as any
      if (!channel || typeof channel.send !== "function") return
      await scheduleWithBucket(channelId, async () => {
        if (replyToMessageId) {
          const target = await channel.messages?.fetch?.(replyToMessageId).catch(() => null)
          if (target && typeof target.reply === "function") { await target.reply(payload); return }
        }
        await channel.send(payload)
      })
    },
  })
  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    const thread = newThread?.id ? db.threads.get(newThread.id) : undefined
    if (cfg.smartThreadNames && isManualRename({
      oldName: oldThread?.name, newName: newThread?.name, archived: !!newThread?.archived,
      known: !!thread, manual: thread?.nameManual ?? false, lastThreadName: thread?.lastThreadName ?? null,
    })) {
      db.threads.setNameManual(newThread.id, true)
      threadNamer.onManualRename(newThread.id)
    }
    void onThreadUpdate(oldThread, newThread)
  })

  const shutdown = createShutdown({
    log,
    abortControllers: () => controllers.values(),
    stopProjects: async () => {
      taskRunner.stop()
      backups?.stop()
      for (const project of db.projects.list()) await projects.stop(project.channelId).catch(() => {})
    },
    destroyClient: () => client.destroy(),
    closeDb: () => { admin?.close(); db.close() },
    releaseLock: () => lock.release(),
    exit: (code) => process.exit(code),
  })
  process.on("SIGINT", () => { void shutdown() })
  process.on("SIGTERM", () => { void shutdown() })
  // A stray rejection (e.g. from a background Discord/SDK task) must not take
  // the whole bot down; log the stack so it is diagnosable instead.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) })
  })

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
  const fetchedGuilds = await fetchConfiguredGuilds(cfg.guildIds, (id) => client.guilds.fetch(id), log)
  for (const g of fetchedGuilds) guildsById.set(g.id, g)
  await deployCommandsToGuilds(fetchedGuilds, commandData(), { log })
  // Boot subscribe + thread reconcile are driven by the Events.ClientReady
  // handler registered above; running them again here would double-wake every
  // project. ClientReady fires during `client.login()` (the handler is attached
  // before login), so no explicit fallback is needed.

  log.info("Celly ready", { guilds: fetchedGuilds.map((g) => g.id) })
  if (cfg.idleStopMinutes > 0) {
    const idleSweeper = createIdleSweeper({
      // The DB selector narrows candidates with the same cutoff; the sweeper's
      // injected clock remains the authority for testability.
      listProjects: () => db.projects.idleSince(Date.now() - cfg.idleStopMinutes * 60_000),
      activeThreads: (channelId) => runnerSvc.activeThreadsFor(channelId),
      now: () => Date.now(),
      stop: async (channelId) => {
        await runnerSvc.resetChannel(channelId)
        stopSubscription(channelId)
        await projects.stop(channelId)
        // The sweep itself counts as activity so the next tick does not stop and
        // notify again until another full idle window passes.
        db.projects.touch(channelId, Date.now())
      },
      notify: async (channelId, minutes) => {
        const channel = await client.channels.fetch(channelId).catch(() => null)
        if (channel && "send" in channel) {
          await scheduleWithBucket(channelId, () => (channel as any).send(cardPayload(noticeCard("info", "Idle timeout", formatIdleStopNotice(minutes))))).catch(() => {})
        }
      },
      idleMs: cfg.idleStopMinutes * 60_000,
      intervalMs: 60_000,
    })
    idleSweeper.start()
    log.info("idle auto-stop enabled", { minutes: cfg.idleStopMinutes })
  } else {
    log.info("idle auto-stop disabled", { minutes: cfg.idleStopMinutes })
  }
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
  console.log(formatStartupBanner({
    guilds: fetchedGuilds.map((g) => {
      const me = g.members.me
      const missingPermissions = required.filter(([, bit]) => !(me?.permissions.has(bit) ?? false)).map(([name]) => name)
      return { id: g.id, name: g.name, missingPermissions }
    }),
    projects: db.projects.list().length,
    dataDir: cfg.dataDir,
    model: cfg.defaultModel,
    adminUrl,
  }))
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
