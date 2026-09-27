import { ActionRowBuilder, ApplicationCommandOptionType, ButtonStyle, ComponentType, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js"
import { ANSWER_ACTION, APPROVAL_ACTION, REJECT_QUESTION_ACTION, answerCustomId } from "./approvals.js"
import { APPROVAL_MODES, isApprovalMode } from "./mode.js"
import type { ApprovalManager } from "./approvals.ts"
import type { AuditDraft } from "./audit.ts"
import type { Db } from "./db.ts"
import type { ProjectService } from "./projects.ts"
import type { QueuedPrompt, Runner } from "./runner.ts"
import { formatDiff } from "./session-utils.js"
import type { SessionOps } from "./session-utils.ts"
import { chunkMessage } from "./render.js"

export function commandData(): any[] {
  const project = { name: "project", description: "Manage Celly projects", options: [
    { type: ApplicationCommandOptionType.Subcommand, name: "add", description: "Register an existing directory", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true },
      { type: ApplicationCommandOptionType.String, name: "path", description: "Host directory under PROJECTS_ROOT", required: true } ] },
    { type: ApplicationCommandOptionType.Subcommand, name: "create", description: "Create a project directory", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true } ] },
    { type: ApplicationCommandOptionType.Subcommand, name: "list", description: "List projects" },
    { type: ApplicationCommandOptionType.Subcommand, name: "status", description: "Project status", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true } ] },
    { type: ApplicationCommandOptionType.Subcommand, name: "start", description: "Wake a project", options: [{ type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true }] },
    { type: ApplicationCommandOptionType.Subcommand, name: "stop", description: "Stop a project", options: [{ type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true }] },
    { type: ApplicationCommandOptionType.Subcommand, name: "remove", description: "Remove a project", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true },
      { type: ApplicationCommandOptionType.String, name: "confirm", description: "Type the project name to confirm", required: true } ] },
  ] }
  return [ project,
    { name: "new", description: "Start a new session", options: [{ type: ApplicationCommandOptionType.String, name: "prompt", description: "Initial prompt" }] },
    { name: "resume", description: "Resume a session" },
    { name: "abort", description: "Abort the current run" },
    { name: "model", description: "Choose the model for this thread" },
    { name: "agent", description: "Choose the agent for this thread" },
    { name: "queue", description: "Show and manage this thread's queued prompts" },
    { name: "undo", description: "Revert the session to its last user message" },
    { name: "redo", description: "Restore messages reverted by the last /undo" },
    { name: "diff", description: "List changed files in this session" },
    { name: "mode", description: "Set the approval mode for this session's project channel", options: [
      { type: ApplicationCommandOptionType.String, name: "mode", description: "How permission requests are handled", required: true,
        choices: APPROVAL_MODES.map((mode) => ({ name: mode, value: mode })) } ] } ]
}

export interface CreateThreadInput {
  channelId: string; title: string; sessionId?: string; prompt?: string; authorId?: string
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
  listSessions?(channelId: string): Promise<{ id: string; title: string }[]>
  listModels?(channelId: string): Promise<{ id: string; name: string }[]>
  listAgents?(channelId: string): Promise<{ id: string; name: string }[]>
  setThreadModel?(threadId: string, model: string | null): void
  setThreadAgent?(threadId: string, agent: string | null): void
  sessions?: SessionOps
  approvals?: ApprovalManager
  audit?(entry: AuditDraft): void
}

export const RESUME_SELECT = "resume"
export const MODEL_PROVIDER_SELECT = "model-provider"
export const MODEL_SELECT = "model"
export const AGENT_SELECT = "agent"
export const QUEUE_REMOVE = "queue-remove"
export const QUEUE_CLEAR = "queue-clear"

export function selectCustomId(action: string, id: string): string { return `celly:${action}:${id}` }
export function buttonCustomId(action: string, id: string, extra?: string): string {
  return extra === undefined ? `celly:${action}:${id}` : `celly:${action}:${id}:${extra}`
}
export function parseCustomId(customId: string): { action: string; id?: string } {
  const { action, id } = parseCustomIdFull(customId)
  return { action, id }
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
  const chunks = chunkMessage(content, 1900)
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

const OWNER_ONLY_PROJECT_SUBS = new Set(["add", "create", "start", "stop", "remove"])
export function requiresOwner(commandName: string, sub: string | null | undefined): boolean {
  if (commandName === "mode") return true
  return commandName === "project" && !!sub && OWNER_ONLY_PROJECT_SUBS.has(sub)
}

export async function handleCommand(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const sub = interaction.commandName === "project" ? interaction.options.getSubcommand(false) : null
  if (requiresOwner(interaction.commandName, sub) && !deps.isOwner?.(interaction)) {
    await interaction.reply(noMentions("This command is owner-only.", { flags: 64 })); return
  }
  try {
    await interaction.deferReply({ flags: 64 })
    const name = interaction.options.getString("name", false)
    if (interaction.commandName === "project") {
      if (sub === "add" || sub === "create") {
        const onProgress = (stage: string) => interaction.editReply(noMentions(stage))
        const directory = sub === "create" ? await deps.projects.createProjectDirectory(name) : interaction.options.getString("path", true)
        const added = await deps.projects.addProject({ guildId: interaction.guildId, name, directory }, onProgress)
        await deps.postConnected?.(added.channelId, added.name)
        return void await interaction.editReply(noMentions(sub === "create" ? `created ${added.name}` : `added ${added.name}`))
      }
      if (sub === "list") {
        const projects = deps.db.projects.list()
        const lines = await Promise.all(projects.map(async (p) => {
          let healthy: boolean | undefined
          try { healthy = await deps.projects.health?.(p.channelId) } catch { healthy = false }
          const health = healthy === undefined ? "" : healthy ? " healthy" : " unhealthy"
          return `${p.name} (${p.status}${health})`
        }))
        return void await interaction.editReply(noMentions(lines.join("\n") || "no projects"))
      }
      if (sub === "status") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply(noMentions("not found"))
        const sessions = deps.db.threads.byChannel(p.channelId).length
        let healthy: boolean | undefined
        try { healthy = await deps.projects.health?.(p.channelId) } catch { healthy = false }
        const health = healthy === undefined ? "" : healthy ? " healthy" : " unhealthy"
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
      if (!thread) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
      // Spec §9: wake the sandbox before asking it for models/agents.
      await deps.projects.ensureReady?.(thread.channelId)
      if (interaction.commandName === "model") {
        const models = (await deps.listModels?.(thread.channelId)) ?? []
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
        return void await interaction.editReply({ content: "Choose a provider for this thread:", components: [selectRow(selectCustomId(MODEL_PROVIDER_SELECT, thread.threadId), "Select a provider", options)], allowedMentions: { parse: [] } })
      }
      const agents = (await deps.listAgents?.(thread.channelId)) ?? []
      if (!agents.length) return void await interaction.editReply(noMentions("no agents available"))
      const options = agents.slice(0, 25).map((a) => ({ label: (a.name || a.id).slice(0, 100), value: a.id }))
      return void await interaction.editReply({ content: "Choose an agent for this thread:", components: [selectRow(selectCustomId(AGENT_SELECT, thread.threadId), "Select an agent", options)], allowedMentions: { parse: [] } })
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
    await interaction.editReply(noMentions("not implemented in this build"))
  } catch (e) {
    await interaction.editReply(noMentions(`error: ${(e as Error).message}`))
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
      deps.setThreadModel?.(id ?? interaction.channelId, value ?? null)
      return void await interaction.editReply({ content: `model set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
    }
    if (action === AGENT_SELECT) {
      deps.setThreadAgent?.(id ?? interaction.channelId, value ?? null)
      return void await interaction.editReply({ content: `agent set to ${value ?? "default"}`, components: [], allowedMentions: { parse: [] } })
    }
    return void await interaction.editReply({ content: "unknown selection", components: [], allowedMentions: { parse: [] } })
  } catch (e) {
    const content = `error: ${(e as Error).message}`
    if (interaction.deferred || interaction.replied) return void await interaction.editReply(noMentions(content))
    await interaction.reply(noMentions(content, { flags: 64 }))
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
    const content = `error: ${(e as Error).message}`
    if (interaction.deferred || interaction.replied) return void await interaction.editReply(noMentions(content))
    await interaction.reply(noMentions(content, { flags: 64 }))
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
