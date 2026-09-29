import { ActionRowBuilder, ApplicationCommandOptionType, ButtonStyle, ChannelType, ComponentType, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js"
import { ANSWER_ACTION, APPROVAL_ACTION, REJECT_QUESTION_ACTION, answerCustomId } from "./approvals.js"
import { APPROVAL_MODES, isApprovalMode } from "./mode.js"
import type { ApprovalManager } from "./approvals.ts"
import type { AuditDraft } from "./audit.ts"
import type { Db } from "./db.ts"
import type { ProjectService } from "./projects.ts"
import type { QueuedPrompt, Runner } from "./runner.ts"
import { attachReply, sessionIdReply } from "./attach.js"
import { DISCORD_CHUNK_LIMIT, getErrorMessage } from "./helpers.js"
import { formatContextUsage, formatDiff } from "./session-utils.js"
import type { SessionOps } from "./session-utils.ts"
import { chunkMessage } from "./render.js"
import { formatCost, formatUsageSummary, resolveBudget } from "./usage.js"

export function commandData(): any[] {
  const project = { name: "project", description: "Manage Celly projects", options: [
    { type: ApplicationCommandOptionType.Subcommand, name: "add", description: "Register an existing directory", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true },
      { type: ApplicationCommandOptionType.String, name: "path", description: "Host directory under PROJECTS_ROOT", required: true } ] },
    { type: ApplicationCommandOptionType.Subcommand, name: "create", description: "Create a project directory", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true },
      { type: ApplicationCommandOptionType.String, name: "clone", description: "Clone an https git repository into the new directory" },
      { type: ApplicationCommandOptionType.String, name: "branch", description: "Branch to clone (requires clone)" } ] },
    { type: ApplicationCommandOptionType.Subcommand, name: "list", description: "List projects" },
    { type: ApplicationCommandOptionType.Subcommand, name: "status", description: "Project status", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true } ] },
    { type: ApplicationCommandOptionType.Subcommand, name: "start", description: "Wake a project", options: [{ type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true }] },
    { type: ApplicationCommandOptionType.Subcommand, name: "stop", description: "Stop a project", options: [{ type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true }] },
    { type: ApplicationCommandOptionType.Subcommand, name: "restart", description: "Restart a project's supervised server", options: [{ type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true }] },
    { type: ApplicationCommandOptionType.Subcommand, name: "remove", description: "Remove a project", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true },
      { type: ApplicationCommandOptionType.String, name: "confirm", description: "Type the project name to confirm", required: true } ] },
  ] }
  const task = { name: "task", description: "Manage scheduled prompts", options: [
    { type: ApplicationCommandOptionType.Subcommand, name: "add", description: "Schedule a recurring prompt in a project channel", options: [
      { type: ApplicationCommandOptionType.Channel, name: "channel", description: "Project channel", required: true, channel_types: [ChannelType.GuildText] },
      { type: ApplicationCommandOptionType.String, name: "prompt", description: "Prompt text", required: true },
      { type: ApplicationCommandOptionType.Integer, name: "every_minutes", description: "Repeat interval in minutes", required: true, min_value: 1 } ] },
    { type: ApplicationCommandOptionType.Subcommand, name: "list", description: "List scheduled prompts" },
    { type: ApplicationCommandOptionType.Subcommand, name: "remove", description: "Remove a scheduled prompt", options: [
      { type: ApplicationCommandOptionType.Integer, name: "id", description: "Task id from /task list", required: true, min_value: 1 } ] },
  ] }
  return [ project, task,
    { name: "new", description: "Start a new session", options: [{ type: ApplicationCommandOptionType.String, name: "prompt", description: "Initial prompt" }] },
    { name: "resume", description: "Resume a session" },
    { name: "abort", description: "Abort the current run" },
    { name: "model", description: "Choose the model for this thread" },
    { name: "agent", description: "Choose the agent for this thread" },
    { name: "thinking", description: "Choose the thinking depth (model variant) for this thread", options: [
      { type: ApplicationCommandOptionType.String, name: "depth", description: "Depth name (for example low, high, max) or 'default'" } ] },
    { name: "queue", description: "Show and manage this thread's queued prompts" },
    { name: "undo", description: "Revert the session to its last user message" },
    { name: "redo", description: "Restore messages reverted by the last /undo" },
    { name: "diff", description: "List changed files in this session" },
    { name: "share", description: "Share the session and post the URL" },
    { name: "unshare", description: "Stop sharing the session" },
    { name: "compact", description: "Summarize the session with the thread's model" },
    { name: "context-usage", description: "Show token use against the model's context limit" },
    { name: "worktree", description: "Manage this thread's git worktree", options: [
      { type: ApplicationCommandOptionType.Subcommand, name: "status", description: "Show this thread's worktree status" },
      { type: ApplicationCommandOptionType.Subcommand, name: "new", description: "Create a git worktree for this thread", options: [
        { type: ApplicationCommandOptionType.String, name: "name", description: "Worktree name (defaults to the thread)", required: false } ] },
      { type: ApplicationCommandOptionType.Subcommand, name: "merge", description: "Merge the worktree branch into the project (owner-only)" },
      { type: ApplicationCommandOptionType.Subcommand, name: "remove", description: "Remove this thread's worktree", options: [
        { type: ApplicationCommandOptionType.Boolean, name: "force", description: "Discard uncommitted changes", required: false } ] },
    ] },
    { name: "fork", description: "Fork this thread's session into a new thread", options: [
      { type: ApplicationCommandOptionType.String, name: "prompt", description: "Initial prompt for the fork" } ] },
    { name: "btw", description: "Fork this thread with a quick side-question", options: [
      { type: ApplicationCommandOptionType.String, name: "prompt", description: "The side-question", required: true } ] },
    { name: "last-sessions", description: "List recent threads in this channel (ephemeral)", options: [
      { type: ApplicationCommandOptionType.Integer, name: "count", description: "How many to show (default 5, max 10)", required: false } ] },
    { name: "cost", description: "Show session and channel cost" },
    { name: "budget", description: "Show or set this channel's session budget (owner-only)", options: [
      { type: ApplicationCommandOptionType.Subcommand, name: "show", description: "Show the current session budget" },
      { type: ApplicationCommandOptionType.Subcommand, name: "set", description: "Set the channel session budget in USD", options: [
        { type: ApplicationCommandOptionType.Number, name: "usd", description: "Budget in USD; 0 disables", required: true } ] },
    ] },
    { name: "mode", description: "Set the approval mode for this session's project channel", options: [
      { type: ApplicationCommandOptionType.String, name: "mode", description: "How permission requests are handled", required: true,
        choices: APPROVAL_MODES.map((mode) => ({ name: mode, value: mode })) } ] },
    { name: "session-id", description: "Show this thread's OpenCode session id" },
    { name: "attach", description: "Show the terminal attach command for this thread" } ]
}

export interface CommandDeployGuild {
  id: string
  commands: { set(data: any[]): Promise<unknown> }
}
export interface DeployLog {
  info(message: string, fields?: any): void
  warn(message: string, fields?: any): void
}
/** Token/auth failures fail for every guild; do not mask them as partial outages. */
const FATAL_DEPLOY_ERROR = /disallowed intents|invalid token|token was provided/i

export async function deployCommandsToGuilds(guilds: CommandDeployGuild[], data: any[], deps: { log: DeployLog }): Promise<string[]> {
  const deployed: string[] = []
  const failures: string[] = []
  for (const guild of guilds) {
    try {
      await guild.commands.set(data)
      deployed.push(guild.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (FATAL_DEPLOY_ERROR.test(message)) throw err
      failures.push(`${guild.id}: ${message}`)
      deps.log.warn("command deploy failed for guild", { guildId: guild.id, error: message })
    }
  }
  if (deployed.length === 0) throw new Error(`command deploy failed for every guild (${failures.join("; ")})`)
  deps.log.info("commands deployed", { guilds: deployed })
  return deployed
}

export interface CreateThreadInput {
  channelId: string; title: string; sessionId?: string; prompt?: string; authorId?: string
}

export interface ForkThreadInput {
  sourceThreadId: string; title: string; prompt?: string; authorId?: string
}
export interface ForkedThread { threadId: string; sessionId: string; notice?: string }

export interface WorktreeCommands {
  status(threadId: string): Promise<string>
  create(threadId: string, name?: string): Promise<string>
  merge(threadId: string): Promise<string>
  remove(threadId: string, force: boolean): Promise<string>
}

export interface CommandDeps {
  projects: ProjectService
  runner: Runner
  db: Db
  authorized(interaction: any): boolean
  isOwner?(interaction: any): boolean
  stopSubscription?(channelId: string): void
  startSubscription?(channelId: string): void
  postConnected?(channelId: string, projectName: string): Promise<void> | void
  createThread?(input: CreateThreadInput): Promise<{ threadId: string; sessionId: string; notice?: string }>
  forkThread?(input: ForkThreadInput): Promise<ForkedThread>
  listSessions?(channelId: string): Promise<{ id: string; title: string }[]>
  listModels?(channelId: string): Promise<{ id: string; name: string; variants?: string[] }[]>
  listAgents?(channelId: string): Promise<{ id: string; name: string }[]>
  setThreadModel?(threadId: string, model: string | null): void
  setThreadAgent?(threadId: string, agent: string | null): void
  setThreadVariant?(threadId: string, variant: string | null): void
  setChannelModel?(channelId: string, model: string | null): void
  setChannelAgent?(channelId: string, agent: string | null): void
  setChannelVariant?(channelId: string, variant: string | null): void
  sessions?: SessionOps
  approvals?: ApprovalManager
  audit?(entry: AuditDraft): void
  worktree?: WorktreeCommands
  sessionBudgetUsd?: number
}

export const RESUME_SELECT = "resume"
export const MODEL_PROVIDER_SELECT = "model-provider"
export const MODEL_SELECT = "model"
export const AGENT_SELECT = "agent"
export const THINKING_SELECT = "thinking"
export const QUEUE_REMOVE = "queue-remove"
export const QUEUE_CLEAR = "queue-clear"

export function selectCustomId(action: string, id: string): string { return `celly:${action}:${id}` }
export function buttonCustomId(action: string, id: string, extra?: string): string {
  return extra === undefined ? `celly:${action}:${id}` : `celly:${action}:${id}:${extra}`
}
/**
 * Canonical custom-id parser (spec §3.1). Wire format is
 * `celly:<action>:<id>[:<extra>]`; malformed ids (missing the `celly` prefix or
 * a second segment) return `{ action: "" }`. `extra` is everything after the
 * third segment joined back with `:`, so values containing colons survive.
 * Later plans extend button handling by adding a dedicated `handle*` branch to
 * `handleButton` rather than redefining these helpers.
 */
export interface ParsedCustomId { action: string; id?: string; extra?: string }
export function parseCustomIdFull(customId: string): ParsedCustomId {
  const parts = customId.split(":")
  if (parts[0] !== "celly" || parts.length < 2) return { action: "" }
  return { action: parts[1] ?? "", id: parts[2], extra: parts.length > 3 ? parts.slice(3).join(":") : undefined }
}
export const ANSWER_MODAL_INPUT = "answer"

/**
 * Spec §9: every interaction reply/edit suppresses mentions. Some prompts and
 * select values quote user-controlled text, so `parse: []` is set explicitly.
 */
export function noMentions(content: string, extra: Record<string, unknown> = {}): any {
  return { content, allowedMentions: { parse: [] }, ...extra }
}

async function replyError(interaction: any, e: unknown): Promise<void> {
  const content = `error: ${getErrorMessage(e)}`
  if (interaction.deferred || interaction.replied) return void await interaction.editReply(noMentions(content))
  await interaction.reply(noMentions(content, { flags: 64 }))
}

async function healthSuffix(deps: CommandDeps, channelId: string): Promise<string> {
  let healthy: boolean | undefined
  try { healthy = await deps.projects.health?.(channelId) } catch { healthy = false }
  return healthy === undefined ? "" : healthy ? " healthy" : " unhealthy"
}

/**
 * Discord rejects a select menu whose option values/labels are empty, exceed
 * 100 chars, duplicate, or number more than 25 — the whole interaction edit
 * fails. Model/session ids are user data, so normalize here instead of trusting
 * the caller. Invalid entries are dropped rather than crashing the command.
 */
export const SELECT_OPTION_MAX = 100
export const SELECT_OPTIONS_MAX = 25
export function sanitizeSelectOptions(options: { label?: unknown; value?: unknown }[]): { label: string; value: string }[] {
  const seen = new Set<string>()
  const out: { label: string; value: string }[] = []
  for (const option of options) {
    const rawValue = option?.value == null ? "" : String(option.value)
    const rawLabel = option?.label == null ? "" : String(option.label)
    if (!rawValue && !rawLabel) continue
    let value = rawValue.slice(0, SELECT_OPTION_MAX)
    let label = rawLabel.slice(0, SELECT_OPTION_MAX)
    if (!value) value = label || "?"
    if (!label) label = value
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ label, value })
    if (out.length >= SELECT_OPTIONS_MAX) break
  }
  return out
}

function selectRow(customId: string, placeholder: string, options: { label: string; value: string }[]): any {
  return { type: ComponentType.ActionRow, components: [{ type: ComponentType.StringSelect, custom_id: customId, placeholder, min_values: 1, max_values: 1, options: sanitizeSelectOptions(options) }] }
}

async function replyChunks(interaction: any, content: string): Promise<void> {
  const chunks = chunkMessage(content, DISCORD_CHUNK_LIMIT)
  const [first = "no changes", ...rest] = chunks
  await interaction.editReply(noMentions(first))
  for (const chunk of rest) await interaction.followUp(noMentions(chunk, { flags: 64 }))
}

function queueMessage(threadId: string, entries: QueuedPrompt[]): any {
  if (!entries.length) return noMentions("queue is empty")
  const shown = entries.slice(0, 10)
  const content = `Queued (${entries.length}):\n` + shown.map((entry, i) => `${i + 1}. ${entry.text.slice(0, 100)}`).join("\n")
  const rows: any[] = []
  for (let i = 0; i < shown.length; i += 5) {
    rows.push({ type: ComponentType.ActionRow, components: shown.slice(i, i + 5).map((_, j) => ({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      custom_id: buttonCustomId(QUEUE_REMOVE, threadId, String(i + j)),
      label: `Remove #${i + j + 1}`,
    })) })
  }
  rows.push({ type: ComponentType.ActionRow, components: [{
    type: ComponentType.Button,
    style: ButtonStyle.Danger,
    custom_id: buttonCustomId(QUEUE_CLEAR, threadId),
    label: "Clear",
  }] })
  return { content, components: rows, allowedMentions: { parse: [] } }
}

const OWNER_ONLY_PROJECT_SUBS = new Set(["add", "create", "start", "stop", "restart", "remove"])
const OWNER_ONLY_TASK_SUBS = new Set(["add", "remove"])
const OWNER_ONLY_WORKTREE_SUBS = new Set(["merge"])
export function requiresOwner(commandName: string, sub: string | null | undefined): boolean {
  if (commandName === "mode") return true
  if (commandName === "project") return !!sub && OWNER_ONLY_PROJECT_SUBS.has(sub)
  if (commandName === "task") return !!sub && OWNER_ONLY_TASK_SUBS.has(sub)
  if (commandName === "worktree") return !!sub && OWNER_ONLY_WORKTREE_SUBS.has(sub)
  return commandName === "budget"
}

function commandProjectChannel(interaction: any, db: Db): string | undefined {
  if (interaction.channel?.isThread?.() === true) return db.threads.get(interaction.channelId)?.channelId
  return db.projects.getByChannel(interaction.channelId) ? interaction.channelId : undefined
}

export async function handleCommand(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const sub = interaction.commandName === "project" || interaction.commandName === "task" || interaction.commandName === "worktree" || interaction.commandName === "budget"
    ? interaction.options.getSubcommand(false)
    : null
  if (requiresOwner(interaction.commandName, sub) && !deps.isOwner?.(interaction)) {
    await interaction.reply(noMentions("This command is owner-only.", { flags: 64 })); return
  }
  try {
    await interaction.deferReply({ flags: 64 })
    const name = interaction.options.getString("name", false)
    if (interaction.commandName === "project") {
      if (sub === "add" || sub === "create") {
        const onProgress = (stage: string) => interaction.editReply(noMentions(stage))
        const cloneUrl = sub === "create" ? interaction.options.getString("clone", false) : null
        const branch = sub === "create" ? interaction.options.getString("branch", false) : null
        if (branch && !cloneUrl) return void await interaction.editReply(noMentions("branch requires clone"))
        const directory = sub === "create" ? await deps.projects.createProjectDirectory(name) : interaction.options.getString("path", true)
        const clone = cloneUrl ? { url: cloneUrl, ...(branch ? { branch } : {}) } : undefined
        const added = await deps.projects.addProject({ guildId: interaction.guildId, name, directory, ...(clone ? { clone } : {}) }, onProgress)
        await deps.postConnected?.(added.channelId, added.name)
        return void await interaction.editReply(noMentions(sub === "create" ? `created ${added.name}` : `added ${added.name}`))
      }
      if (sub === "list") {
        const projects = deps.db.projects.list()
        const lines = await Promise.all(projects.map(async (p) => {
          const health = await healthSuffix(deps, p.channelId)
          return `${p.name} (${p.status}${health})`
        }))
        return void await interaction.editReply(noMentions(lines.join("\n") || "no projects"))
      }
      if (sub === "status") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply(noMentions("not found"))
        const sessions = deps.db.threads.byChannel(p.channelId).length
        const health = await healthSuffix(deps, p.channelId)
        return void await interaction.editReply(noMentions(`${p.name}: ${p.status}${health} on 127.0.0.1:${p.hostPort} (${sessions} session${sessions === 1 ? "" : "s"})`))
      }
      if (sub === "start") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply(noMentions("not found"))
        deps.startSubscription?.(p.channelId)
        await deps.projects.start(p.channelId)
        return void await interaction.editReply(noMentions("started"))
      }
      if (sub === "stop") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply(noMentions("not found"))
        await deps.runner.resetChannel?.(p.channelId, { notify: true })
        deps.stopSubscription?.(p.channelId)
        await deps.projects.stop(p.channelId)
        return void await interaction.editReply(noMentions("stopped"))
      }
      if (sub === "restart") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply(noMentions("not found"))
        deps.stopSubscription?.(p.channelId)
        await deps.projects.restartServer(p.channelId)
        deps.startSubscription?.(p.channelId)
        return void await interaction.editReply(noMentions("restarted"))
      }
      if (sub === "remove") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply(noMentions("not found"))
        const expected = interaction.options.getString("confirm", true)
        if (expected !== name) return void await interaction.editReply(noMentions("confirmation name does not match"))
        await deps.runner.resetChannel?.(p.channelId, { notify: true })
        deps.stopSubscription?.(p.channelId)
        await deps.projects.remove(p.channelId)
        return void await interaction.editReply(noMentions("removed"))
      }
    }
    if (interaction.commandName === "task") {
      if (sub === "add") {
        const channelId = interaction.options.getChannel("channel", true)?.id
        const project = channelId ? deps.db.projects.getByChannel(channelId) : undefined
        if (!project) return void await interaction.editReply(noMentions("channel is not a project"))
        const prompt = interaction.options.getString("prompt", true)
        const everyMinutes = interaction.options.getInteger("every_minutes", true)
        const now = Date.now()
        const id = deps.db.tasks.add({ channelId: project.channelId, prompt, everyMinutes, nextRunAt: now + everyMinutes * 60_000, createdAt: now })
        deps.audit?.({ kind: "task", channelId: project.channelId, threadId: interaction.channelId, actorId: interaction.user?.id ?? "unknown", detail: `add:${id} every ${everyMinutes}m`, decision: "add" })
        return void await interaction.editReply(noMentions(`scheduled task ${id} every ${everyMinutes}m in <#${project.channelId}>`))
      }
      if (sub === "list") {
        const lines = deps.db.tasks.list().map((t) => `#${t.id} <#${t.channelId}> every ${t.everyMinutes}m next ${new Date(t.nextRunAt).toISOString()}${t.enabled ? "" : " (disabled)"}`)
        return void await interaction.editReply(noMentions(lines.join("\n") || "no scheduled tasks"))
      }
      if (sub === "remove") {
        const id = interaction.options.getInteger("id", true)
        const existing = deps.db.tasks.list().find((t) => t.id === id)
        const removed = deps.db.tasks.remove(id)
        deps.audit?.({ kind: "task", channelId: existing?.channelId ?? interaction.channelId, threadId: interaction.channelId, actorId: interaction.user?.id ?? "unknown", detail: `remove:${id}`, decision: removed ? "remove" : "missing" })
        return void await interaction.editReply(noMentions(removed ? `removed task ${id}` : `task ${id} not found`))
      }
    }
    if (interaction.commandName === "new") {
      const project = deps.db.projects.getByChannel(interaction.channelId)
      if (!project) return void await interaction.editReply(noMentions("this channel is not a project"))
      if (!deps.createThread) return void await interaction.editReply(noMentions("thread creation unavailable"))
      const prompt = interaction.options.getString("prompt", false) ?? undefined
      const thread = await deps.createThread({ channelId: project.channelId, title: prompt ?? `session ${new Date().toISOString()}`, prompt, authorId: interaction.user?.id })
      const note = thread.notice ? ` (${thread.notice})` : ""
      return void await interaction.editReply(noMentions(`created <#${thread.threadId}>${note}`))
    }
    if (interaction.commandName === "resume") {
      const project = deps.db.projects.getByChannel(interaction.channelId)
      if (!project) return void await interaction.editReply(noMentions("this channel is not a project"))
      const sessions = (await deps.listSessions?.(project.channelId)) ?? []
      if (!sessions.length) return void await interaction.editReply(noMentions("no sessions to resume"))
      const options = sessions.slice(0, 25).map((s) => ({ label: (s.title || s.id).slice(0, 100), value: s.id }))
      return void await interaction.editReply({ content: "Choose a session to resume:", components: [selectRow(selectCustomId(RESUME_SELECT, project.channelId), "Select a session", options)], allowedMentions: { parse: [] } })
    }
    if (interaction.commandName === "model" || interaction.commandName === "agent") {
      const thread = deps.db.threads.get(interaction.channelId)
      const channelProject = thread ? undefined : deps.db.projects.getByChannel(interaction.channelId)
      const scope = thread ? thread.threadId : channelProject ? interaction.channelId : undefined
      if (!scope) return void await interaction.editReply(noMentions("this channel is not a project"))
      // Spec §9: wake the sandbox before asking it for models/agents.
      await deps.projects.ensureReady?.(thread?.channelId ?? interaction.channelId)
      if (interaction.commandName === "model") {
        const models = (await deps.listModels?.(thread?.channelId ?? interaction.channelId)) ?? []
        if (!models.length) return void await interaction.editReply(noMentions("no models available"))
        // Discord select menus cap at 25 options, and a flattened model list
        // across every provider overflows it. Offer providers first, then that
        // provider's models, so no provider is unreachable.
        const providers = new Map<string, number>()
        for (const m of models) {
          if (typeof m?.id !== "string" || !m.id) continue
          const slash = m.id.indexOf("/")
          const provider = slash > 0 ? m.id.slice(0, slash) : m.id
          if (!provider) continue
          providers.set(provider, (providers.get(provider) ?? 0) + 1)
        }
        const options = [...providers.entries()].map(([provider, count]) => ({ label: `${provider} (${count})`, value: provider }))
        if (!options.length) return void await interaction.editReply(noMentions("no models available"))
        const where = thread ? "thread" : "channel"
        return void await interaction.editReply({ content: `Choose a provider for this ${where}:`, components: [selectRow(selectCustomId(MODEL_PROVIDER_SELECT, scope), "Select a provider", options)], allowedMentions: { parse: [] } })
      }
      const agents = (await deps.listAgents?.(thread?.channelId ?? interaction.channelId)) ?? []
      if (!agents.length) return void await interaction.editReply(noMentions("no agents available"))
      const options = agents.slice(0, 25).map((a) => ({ label: (a.name || a.id).slice(0, 100), value: a.id }))
      const where = thread ? "thread" : "channel"
      return void await interaction.editReply({ content: `Choose an agent for this ${where}:`, components: [selectRow(selectCustomId(AGENT_SELECT, scope), "Select an agent", options)], allowedMentions: { parse: [] } })
    }
    if (interaction.commandName === "thinking") {
      const thread = deps.db.threads.get(interaction.channelId)
      const channelProject = thread ? undefined : deps.db.projects.getByChannel(interaction.channelId)
      const scope = thread ? thread.threadId : channelProject ? interaction.channelId : undefined
      if (!scope) return void await interaction.editReply(noMentions("this channel is not a project"))
      // Spec §9: wake the sandbox before asking it for models.
      await deps.projects.ensureReady?.(thread?.channelId ?? interaction.channelId)
      const channelId = thread?.channelId ?? interaction.channelId
      const apply = (variant: string | null): void => { if (thread) deps.setThreadVariant?.(scope, variant); else deps.setChannelVariant?.(scope, variant) }
      const label = thread ? "thinking depth" : "channel thinking depth"
      // Variant names are the thinking depths the model advertises via OpenCode;
      // resolve the effective model's list so a typed depth can be validated.
      const resolveVariants = async (): Promise<{ model: string; variants: string[] } | string> => {
        const model = thread?.model ?? deps.db.settings.get(`default_model:${channelId}`) ?? deps.db.settings.get("default_model") ?? null
        if (!model) return "set a model with /model first"
        const models = (await deps.listModels?.(channelId)) ?? []
        const variants = models.find((m) => m.id === model)?.variants ?? []
        if (!variants.length) return `${model} has no thinking depths`
        return { model, variants }
      }
      const direct = interaction.options.getString("depth", false)
      if (direct !== undefined && direct !== null) {
        const value = direct.trim().toLowerCase()
        if (!value || value === "default") {
          apply(null)
          return void await interaction.editReply(noMentions(`${label} reset to default`))
        }
        const resolved = await resolveVariants()
        if (typeof resolved === "string") return void await interaction.editReply(noMentions(resolved))
        if (!resolved.variants.includes(value)) {
          return void await interaction.editReply(noMentions(`unknown thinking depth '${direct}' for ${resolved.model}; choose one of: ${["default", ...resolved.variants].join(", ")}`))
        }
        apply(value)
        return void await interaction.editReply(noMentions(`${label} set to ${value}`))
      }
      const resolved = await resolveVariants()
      if (typeof resolved === "string") return void await interaction.editReply(noMentions(resolved))
      const options = [{ label: "default (no override)", value: "default" }, ...resolved.variants.map((v) => ({ label: v, value: v }))]
      const where = thread ? "thread" : "channel"
      return void await interaction.editReply({ content: `Choose a thinking depth for this ${where}:`, components: [selectRow(selectCustomId(THINKING_SELECT, scope), "Select a thinking depth", options)], allowedMentions: { parse: [] } })
    }
    if (interaction.commandName === "fork" || interaction.commandName === "btw") {
      const source = deps.db.threads.get(interaction.channelId)
      if (!source) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
      if (!deps.forkThread) return void await interaction.editReply(noMentions("fork support unavailable"))
      const prompt = interaction.options.getString("prompt", false) ?? undefined
      if (interaction.commandName === "btw" && !prompt) return void await interaction.editReply(noMentions("usage: /btw <prompt>"))
      const title = interaction.commandName === "btw" ? `btw · ${prompt}` : (prompt ?? `fork of ${source.title ?? source.threadId}`)
      const forked = await deps.forkThread({ sourceThreadId: source.threadId, title, prompt, authorId: interaction.user?.id })
      const note = forked.notice ? ` (${forked.notice})` : ""
      return void await interaction.editReply(noMentions(`forked into <#${forked.threadId}>${note}`))
    }
    if (interaction.commandName === "abort") {
      const isThread = interaction.channel?.isThread?.() === true
      const threadIds = isThread
        ? (deps.runner.isActive(interaction.channelId) ? [interaction.channelId] : [])
        : deps.runner.activeThreadsFor(interaction.channelId)
      if (!threadIds.length) return void await interaction.editReply(noMentions("nothing to abort"))
      for (const threadId of threadIds) await deps.runner.abort(threadId)
      return void await interaction.editReply(noMentions("aborted"))
    }
    if (interaction.commandName === "queue") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions("use /queue inside a thread"))
      return void await interaction.editReply(queueMessage(thread.threadId, deps.runner.queuedFor(thread.threadId)))
    }
    if (interaction.commandName === "undo" || interaction.commandName === "redo") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
      if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
      if (interaction.commandName === "undo") {
        const result = await deps.sessions.undo(thread.threadId)
        return void await interaction.editReply(noMentions(result === "reverted" ? "reverted the last message" : "nothing to undo"))
      }
      await deps.sessions.redo(thread.threadId)
      return void await interaction.editReply(noMentions("redone"))
    }
    if (interaction.commandName === "diff") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions("use /diff inside a thread"))
      if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
      const files = await deps.sessions.diff(thread.threadId)
      return void await replyChunks(interaction, formatDiff(files))
    }
    if (interaction.commandName === "share" || interaction.commandName === "unshare") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
      if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
      if (interaction.commandName === "share") {
        const url = await deps.sessions.share(thread.threadId)
        return void await interaction.editReply(noMentions(`shared: ${url}`))
      }
      await deps.sessions.unshare(thread.threadId)
      return void await interaction.editReply(noMentions("unshared"))
    }
    if (interaction.commandName === "compact") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions("use /compact inside a thread"))
      if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
      await deps.sessions.compact(thread.threadId)
      return void await interaction.editReply(noMentions("compacted"))
    }
    if (interaction.commandName === "context-usage") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions("use /context-usage inside a thread"))
      if (!deps.sessions) return void await interaction.editReply(noMentions("session utilities unavailable"))
      const usage = await deps.sessions.contextUsage(thread.threadId)
      if (usage === "no-usage") return void await interaction.editReply(noMentions("no usage recorded for this thread yet"))
      if (usage === "no-limit") return void await interaction.editReply(noMentions("context limit unavailable for this model"))
      return void await interaction.editReply(noMentions(formatContextUsage(usage.used, usage.limit)))
    }
    if (interaction.commandName === "mode") {
      const requested = interaction.options.getString("mode", true)
      if (!isApprovalMode(requested)) return void await interaction.editReply(noMentions(`unknown mode: ${requested}`))
      const thread = deps.db.threads.get(interaction.channelId)
      const channelId = thread?.channelId ?? interaction.channelId
      if (!deps.db.projects.getByChannel(channelId)) return void await interaction.editReply(noMentions("this channel is not a project"))
      deps.db.settings.set(`approval_mode:${channelId}`, requested)
      deps.audit?.({
        kind: "mode", channelId, threadId: interaction.channelId,
        actorId: interaction.user?.id ?? "unknown", detail: `approval_mode:${channelId}`, decision: requested,
      })
      return void await interaction.editReply(noMentions(`approval mode set to ${requested}`))
    }
    if (interaction.commandName === "attach" || interaction.commandName === "session-id") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
      const project = deps.db.projects.getByChannel(thread.channelId)
      if (!project) return void await interaction.editReply(noMentions("project not found"))
      const content = interaction.commandName === "attach"
        ? attachReply(project, thread.sessionId)
        : sessionIdReply(project, thread.sessionId)
      return void await interaction.editReply(noMentions(content))
    }
    if (interaction.commandName === "last-sessions") {
      const parentId = interaction.channel?.isThread?.() ? interaction.channel.parentId : interaction.channelId
      const project = parentId ? deps.db.projects.getByChannel(parentId) : undefined
      if (!project) return void await interaction.editReply(noMentions("this channel is not a project"))
      const requested = interaction.options.getInteger("count", false) ?? 5
      const count = Math.min(Math.max(requested, 1), 10)
      const threads = deps.db.threads.byChannel(project.channelId).slice(0, count)
      if (threads.length === 0) return void await interaction.editReply(noMentions("no sessions yet"))
      const lines = threads.map((t) => `<#${t.threadId}> — ${t.title ?? t.sessionId}`)
      return void await interaction.editReply(noMentions(lines.join("\n")))
    }
    if (interaction.commandName === "worktree") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions("use /worktree inside a thread"))
      if (!deps.worktree) return void await interaction.editReply(noMentions("worktree support unavailable"))
      if (sub === "status") return void await interaction.editReply(noMentions(await deps.worktree.status(thread.threadId)))
      if (sub === "new") {
        const worktreeName = interaction.options.getString("name", false) ?? undefined
        return void await interaction.editReply(noMentions(await deps.worktree.create(thread.threadId, worktreeName)))
      }
      if (sub === "merge") return void await interaction.editReply(noMentions(await deps.worktree.merge(thread.threadId)))
      if (sub === "remove") {
        const force = interaction.options.getBoolean("force", false) ?? false
        return void await interaction.editReply(noMentions(await deps.worktree.remove(thread.threadId, force)))
      }
    }
    if (interaction.commandName === "cost") {
      const channelId = commandProjectChannel(interaction, deps.db)
      if (!channelId) return void await interaction.editReply(noMentions("this channel is not a project"))
      const thread = interaction.channel?.isThread?.() === true ? deps.db.usage.thread(interaction.channelId) : undefined
      const budget = resolveBudget(deps.db.settings, channelId, deps.sessionBudgetUsd ?? 0)
      const lines = [
        thread ? formatUsageSummary("session", thread) : "",
        formatUsageSummary("channel", deps.db.usage.channel(channelId)),
        budget > 0 ? `budget: ${formatCost(budget)}/session` : "budget: off",
      ].filter(Boolean)
      return void await interaction.editReply(noMentions(lines.join("\n")))
    }
    if (interaction.commandName === "budget") {
      const channelId = commandProjectChannel(interaction, deps.db)
      if (!channelId) return void await interaction.editReply(noMentions("this channel is not a project"))
      if (sub === "set") {
        const usd = interaction.options.getNumber("usd", true)
        if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return void await interaction.editReply(noMentions("error: usd must be a number >= 0"))
        deps.db.settings.set(`budget_usd:${channelId}`, String(usd))
        return void await interaction.editReply(noMentions(`budget set to ${formatCost(usd)} per session`))
      }
      const budget = resolveBudget(deps.db.settings, channelId, deps.sessionBudgetUsd ?? 0)
      return void await interaction.editReply(noMentions(budget > 0 ? `session budget: ${formatCost(budget)}` : "session budget: off"))
    }
    await interaction.editReply(noMentions("not implemented in this build"))
  } catch (e) {
    await replyError(interaction, e)
  }
}

export async function handleSelect(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action, id } = parseCustomIdFull(interaction.customId ?? "")
  try {
    await interaction.deferUpdate()
    const value: string | undefined = interaction.values?.[0]
    if (action === ANSWER_ACTION) return handleAnswerSelect(interaction, deps)
    if (action === RESUME_SELECT) {
      if (!id || !value) return void await interaction.editReply({ content: "no session selected", components: [], allowedMentions: { parse: [] } })
      const project = deps.db.projects.getByChannel(id)
      if (!project) return void await interaction.editReply({ content: "project not found", components: [], allowedMentions: { parse: [] } })
      const existing = deps.db.threads.getBySession(value)[0]
      const thread = await deps.createThread?.({ channelId: id, title: existing?.title ?? `resume ${new Date().toISOString()}`, sessionId: value, authorId: interaction.user?.id })
      return void await interaction.editReply({ content: thread ? `resumed in <#${thread.threadId}>` : "resume unavailable", components: [], allowedMentions: { parse: [] } })
    }
    if (action === MODEL_PROVIDER_SELECT) {
      if (!id || !value) return void await interaction.editReply({ content: "no provider selected", components: [], allowedMentions: { parse: [] } })
      const thread = deps.db.threads.get(id)
      const models = (await deps.listModels?.(thread?.channelId ?? interaction.channelId)) ?? []
      const forProvider = models.filter((m) => typeof m?.id === "string" && m.id.startsWith(`${value}/`))
      if (!forProvider.length) return void await interaction.editReply({ content: `no models available for ${value}`, components: [], allowedMentions: { parse: [] } })
      const options = forProvider.map((m) => ({ label: m.name || m.id, value: m.id }))
      return void await interaction.editReply({ content: `Choose a ${value} model:`, components: [selectRow(selectCustomId(MODEL_SELECT, id), "Select a model", options)], allowedMentions: { parse: [] } })
    }
    if (action === MODEL_SELECT) {
      const scope = id ?? interaction.channelId
      if (deps.db.threads.get(scope)) {
        deps.setThreadModel?.(scope, value ?? null)
        return void await interaction.editReply({ content: `model set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
      }
      deps.setChannelModel?.(scope, value ?? null)
      return void await interaction.editReply({ content: `channel model set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
    }
    if (action === AGENT_SELECT) {
      const scope = id ?? interaction.channelId
      if (deps.db.threads.get(scope)) {
        deps.setThreadAgent?.(scope, value ?? null)
        return void await interaction.editReply({ content: `agent set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
      }
      deps.setChannelAgent?.(scope, value ?? null)
      return void await interaction.editReply({ content: `channel agent set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
    }
    if (action === THINKING_SELECT) {
      const scope = id ?? interaction.channelId
      const variant = value && value !== "default" ? value : null
      const label = variant ?? "default"
      if (deps.db.threads.get(scope)) {
        deps.setThreadVariant?.(scope, variant)
        return void await interaction.editReply({ content: `thinking depth set to ${label}`, components: [], allowedMentions: { parse: [] } })
      }
      deps.setChannelVariant?.(scope, variant)
      return void await interaction.editReply({ content: `channel thinking depth set to ${label}`, components: [], allowedMentions: { parse: [] } })
    }
    return void await interaction.editReply({ content: "unknown selection", components: [], allowedMentions: { parse: [] } })
  } catch (e) {
    await replyError(interaction, e)
  }
}

export async function handleQueueButton(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action, id: threadId, extra } = parseCustomIdFull(interaction.customId ?? "")
  try {
    await interaction.deferUpdate()
    if (action === QUEUE_REMOVE) {
      if (!threadId) return void await interaction.editReply(noMentions("unknown queue button"))
      const index = Number(extra)
      if (!Number.isInteger(index) || !deps.runner.removeQueued(threadId, index)) {
        return void await interaction.editReply({ content: "queue changed; run /queue again", components: [], allowedMentions: { parse: [] } })
      }
      return void await interaction.editReply(queueMessage(threadId, deps.runner.queuedFor(threadId)))
    }
    if (action === QUEUE_CLEAR) {
      if (!threadId) return void await interaction.editReply(noMentions("unknown queue button"))
      const cleared = deps.runner.clearQueued(threadId)
      const content = cleared > 0 ? `cleared ${cleared} queued prompt${cleared === 1 ? "" : "s"}` : "queue is empty"
      return void await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } })
    }
    return void await interaction.editReply({ content: "unknown button", components: [], allowedMentions: { parse: [] } })
  } catch (e) {
    await replyError(interaction, e)
  }
}

function stale(interaction: any): Promise<void> {
  return interaction.reply(noMentions("this request is no longer active", { flags: 64 }))
}

export function customAnswerModal(requestId: string, questionIndex: number): any {
  const input = new TextInputBuilder()
    .setCustomId(ANSWER_MODAL_INPUT)
    .setLabel("Your answer")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000)
  return new ModalBuilder()
    .setCustomId(answerCustomId(requestId, questionIndex))
    .setTitle("Custom answer")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
}

export async function handleButton(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action } = parseCustomIdFull(interaction.customId ?? "")
  if (action === QUEUE_REMOVE || action === QUEUE_CLEAR) return handleQueueButton(interaction, deps)
  if (action === APPROVAL_ACTION) return handleApprovalButton(interaction, deps)
  if (action === ANSWER_ACTION) return handleAnswerButton(interaction, deps)
  if (action === REJECT_QUESTION_ACTION) return handleRejectQuestionButton(interaction, deps)
}

export async function handleApprovalButton(interaction: any, deps: CommandDeps): Promise<void> {
  const { id, extra } = parseCustomIdFull(interaction.customId ?? "")
  const decision = extra === "once" || extra === "always" || extra === "reject" ? extra : undefined
  if (!id || !decision || !deps.approvals?.resolvePermission(id, decision, interaction.user?.id ?? "unknown")) {
    await stale(interaction)
    return
  }
  await interaction.deferUpdate()
}

export async function handleAnswerButton(interaction: any, deps: CommandDeps): Promise<void> {
  const { id, extra } = parseCustomIdFull(interaction.customId ?? "")
  if (!id || !extra || !deps.approvals?.hasPending(id)) { await stale(interaction); return }
  const [indexPart, optionPart] = extra.split(".")
  const questionIndex = Number(indexPart)
  if (!Number.isInteger(questionIndex) || questionIndex < 0) { await stale(interaction); return }
  if (optionPart !== undefined) {
    const optionIndex = Number(optionPart)
    if (!Number.isInteger(optionIndex) || optionIndex < 0
      || !deps.approvals.answerOption(id, questionIndex, optionIndex, interaction.user?.id ?? "unknown")) {
      await stale(interaction)
      return
    }
    await interaction.deferUpdate()
    return
  }
  await interaction.showModal(customAnswerModal(id, questionIndex))
}

export async function handleAnswerSelect(interaction: any, deps: CommandDeps): Promise<void> {
  const { id, extra } = parseCustomIdFull(interaction.customId ?? "")
  const questionIndex = Number(extra)
  const values: string[] = Array.isArray(interaction.values)
    ? interaction.values.slice(0, 25).filter((value: unknown): value is string => typeof value === "string" && !!value)
    : []
  const known = deps.approvals?.answerQuestion(id ?? "", questionIndex, values, interaction.user?.id ?? "unknown")
  if (!id || !Number.isInteger(questionIndex) || !values.length || !known) {
    return void await interaction.editReply({ content: "this request is no longer active", components: [], allowedMentions: { parse: [] } })
  }
}

export async function handleRejectQuestionButton(interaction: any, deps: CommandDeps): Promise<void> {
  const { id } = parseCustomIdFull(interaction.customId ?? "")
  if (!id || !deps.approvals?.rejectQuestion(id, interaction.user?.id ?? "unknown")) { await stale(interaction); return }
  await interaction.deferUpdate()
}

export async function handleModalSubmit(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action, id, extra } = parseCustomIdFull(interaction.customId ?? "")
  if (action !== ANSWER_ACTION) return
  const questionIndex = Number(extra)
  const value = String(interaction.fields?.getTextInputValue?.(ANSWER_MODAL_INPUT) ?? "").trim()
  if (!value) { await interaction.reply(noMentions("answer cannot be empty", { flags: 64 })); return }
  if (!id || !Number.isInteger(questionIndex)
    || !deps.approvals?.answerQuestion(id, questionIndex, [value], interaction.user?.id ?? "unknown")) {
    await stale(interaction)
    return
  }
  await interaction.deferUpdate()
}
