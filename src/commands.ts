import type { Db } from "./db.ts"
import type { ProjectService } from "./projects.ts"
import type { Runner } from "./runner.ts"

export function commandData(): any[] {
  const project = { name: "project", description: "Manage Cely projects", options: [
    { type: 1, name: "add", description: "Register an existing directory", options: [
      { type: 3, name: "name", description: "Project name", required: true },
      { type: 3, name: "path", description: "Host directory under PROJECTS_ROOT", required: true } ] },
    { type: 1, name: "create", description: "Create a project directory", options: [
      { type: 3, name: "name", description: "Project name", required: true } ] },
    { type: 1, name: "list", description: "List projects" },
    { type: 1, name: "status", description: "Project status", options: [
      { type: 3, name: "name", description: "Project name", required: true } ] },
    { type: 1, name: "start", description: "Wake a project", options: [{ type: 3, name: "name", description: "Project name", required: true }] },
    { type: 1, name: "stop", description: "Stop a project", options: [{ type: 3, name: "name", description: "Project name", required: true }] },
    { type: 1, name: "remove", description: "Remove a project", options: [
      { type: 3, name: "name", description: "Project name", required: true },
      { type: 3, name: "confirm", description: "Type the project name to confirm", required: true } ] },
  ] }
  return [ project,
    { name: "new", description: "Start a new session", options: [{ type: 3, name: "prompt", description: "Initial prompt" }] },
    { name: "resume", description: "Resume a session" },
    { name: "abort", description: "Abort the current run" },
    { name: "model", description: "Choose the model for this thread" },
    { name: "agent", description: "Choose the agent for this thread" } ]
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
  createThread?(input: CreateThreadInput): Promise<{ threadId: string; sessionId: string }>
  listSessions?(channelId: string): Promise<{ id: string; title: string }[]>
  listModels?(channelId: string): Promise<{ id: string; name: string }[]>
  listAgents?(channelId: string): Promise<{ id: string; name: string }[]>
  setThreadModel?(threadId: string, model: string | null): void
  setThreadAgent?(threadId: string, agent: string | null): void
}

export const RESUME_SELECT = "resume"
export const MODEL_SELECT = "model"
export const AGENT_SELECT = "agent"

export function selectCustomId(action: string, id: string): string { return `cely:${action}:${id}` }
export function parseCustomId(customId: string): { action: string; id?: string } {
  const [, action = "", id] = customId.split(":")
  return { action, id }
}
function selectRow(customId: string, placeholder: string, options: { label: string; value: string }[]): any {
  return { type: 1, components: [{ type: 3, custom_id: customId, placeholder, min_values: 1, max_values: 1, options: options.slice(0, 25) }] }
}

const OWNER_ONLY_PROJECT_SUBS = new Set(["add", "create", "start", "stop", "remove"])
export function requiresOwner(commandName: string, sub: string | null | undefined): boolean {
  return commandName === "project" && !!sub && OWNER_ONLY_PROJECT_SUBS.has(sub)
}

export async function handleCommand(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply({ content: "You are not authorized.", flags: 64 }); return }
  const sub = interaction.commandName === "project" ? interaction.options.getSubcommand(false) : null
  if (requiresOwner(interaction.commandName, sub) && !deps.isOwner?.(interaction)) {
    await interaction.reply({ content: "This command is owner-only.", flags: 64 }); return
  }
  try {
    await interaction.deferReply({ flags: 64 })
    const name = interaction.options.getString("name", false)
    if (interaction.commandName === "project") {
      if (sub === "add") {
        const added = await deps.projects.addProject({ guildId: interaction.guildId, name, directory: interaction.options.getString("path", true) })
        return void await interaction.editReply(`added ${added.name}`)
      }
      if (sub === "create") {
        const directory = await deps.projects.createProjectDirectory(name)
        const added = await deps.projects.addProject({ guildId: interaction.guildId, name, directory })
        return void await interaction.editReply(`created ${added.name}`)
      }
      if (sub === "list") return void await interaction.editReply(deps.db.projects.list().map((p) => `${p.name} (${p.status})`).join("\n") || "no projects")
      if (sub === "status") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply("not found")
        const sessions = deps.db.threads.byChannel(p.channelId).length
        let healthy: boolean | undefined
        try { healthy = await deps.projects.health?.(p.channelId) } catch { healthy = false }
        const health = healthy === undefined ? "" : healthy ? " healthy" : " unhealthy"
        return void await interaction.editReply(`${p.name}: ${p.status}${health} on 127.0.0.1:${p.hostPort} (${sessions} session${sessions === 1 ? "" : "s"})`)
      }
      if (sub === "start") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply("not found")
        deps.startSubscription?.(p.channelId)
        await deps.projects.start(p.channelId)
        return void await interaction.editReply("started")
      }
      if (sub === "stop") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply("not found")
        await deps.runner.resetChannel?.(p.channelId, { notify: true })
        deps.stopSubscription?.(p.channelId)
        await deps.projects.stop(p.channelId)
        return void await interaction.editReply("stopped")
      }
      if (sub === "remove") {
        const p = deps.db.projects.getByName(name)
        if (!p) return void await interaction.editReply("not found")
        const expected = interaction.options.getString("confirm", true)
        if (expected !== name) return void await interaction.editReply("confirmation name does not match")
        await deps.runner.resetChannel?.(p.channelId, { notify: true })
        deps.stopSubscription?.(p.channelId)
        await deps.projects.remove(p.channelId)
        return void await interaction.editReply("removed")
      }
    }
    if (interaction.commandName === "new") {
      const project = deps.db.projects.getByChannel(interaction.channelId)
      if (!project) return void await interaction.editReply("this channel is not a project")
      if (!deps.createThread) return void await interaction.editReply("thread creation unavailable")
      const prompt = interaction.options.getString("prompt", false) ?? undefined
      const thread = await deps.createThread({ channelId: project.channelId, title: prompt ?? `session ${new Date().toISOString()}`, prompt, authorId: interaction.user?.id })
      return void await interaction.editReply(`created <#${thread.threadId}>`)
    }
    if (interaction.commandName === "resume") {
      const project = deps.db.projects.getByChannel(interaction.channelId)
      if (!project) return void await interaction.editReply("this channel is not a project")
      const sessions = (await deps.listSessions?.(project.channelId)) ?? []
      if (!sessions.length) return void await interaction.editReply("no sessions to resume")
      const options = sessions.slice(0, 25).map((s) => ({ label: (s.title || s.id).slice(0, 100), value: s.id }))
      return void await interaction.editReply({ content: "Choose a session to resume:", components: [selectRow(selectCustomId(RESUME_SELECT, project.channelId), "Select a session", options)] })
    }
    if (interaction.commandName === "model" || interaction.commandName === "agent") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(`use /${interaction.commandName} inside a thread`)
      if (interaction.commandName === "model") {
        const models = (await deps.listModels?.(thread.channelId)) ?? []
        if (!models.length) return void await interaction.editReply("no models available")
        const options = models.slice(0, 25).map((m) => ({ label: (m.name || m.id).slice(0, 100), value: m.id }))
        return void await interaction.editReply({ content: "Choose a model for this thread:", components: [selectRow(selectCustomId(MODEL_SELECT, thread.threadId), "Select a model", options)] })
      }
      const agents = (await deps.listAgents?.(thread.channelId)) ?? []
      if (!agents.length) return void await interaction.editReply("no agents available")
      const options = agents.slice(0, 25).map((a) => ({ label: (a.name || a.id).slice(0, 100), value: a.id }))
      return void await interaction.editReply({ content: "Choose an agent for this thread:", components: [selectRow(selectCustomId(AGENT_SELECT, thread.threadId), "Select an agent", options)] })
    }
    if (interaction.commandName === "abort") {
      const isThread = interaction.channel?.isThread?.() === true
      const threadIds = isThread
        ? (deps.runner.isActive(interaction.channelId) ? [interaction.channelId] : [])
        : deps.runner.activeThreadsFor(interaction.channelId)
      if (!threadIds.length) return void await interaction.editReply("nothing to abort")
      for (const threadId of threadIds) await deps.runner.abort(threadId)
      return void await interaction.editReply("aborted")
    }
    await interaction.editReply("not implemented in this build")
  } catch (e) {
    await interaction.editReply(`error: ${(e as Error).message}`)
  }
}

export async function handleSelect(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply({ content: "You are not authorized.", flags: 64 }); return }
  const { action, id } = parseCustomId(interaction.customId ?? "")
  try {
    await interaction.deferUpdate()
    const value: string | undefined = interaction.values?.[0]
    if (action === RESUME_SELECT) {
      if (!id || !value) return void await interaction.editReply({ content: "no session selected", components: [] })
      const project = deps.db.projects.getByChannel(id)
      if (!project) return void await interaction.editReply({ content: "project not found", components: [] })
      const existing = deps.db.threads.getBySession(value)[0]
      const thread = await deps.createThread?.({ channelId: id, title: existing?.title ?? `resume ${new Date().toISOString()}`, sessionId: value, authorId: interaction.user?.id })
      return void await interaction.editReply({ content: thread ? `resumed in <#${thread.threadId}>` : "resume unavailable", components: [] })
    }
    if (action === MODEL_SELECT) {
      deps.setThreadModel?.(id ?? interaction.channelId, value ?? null)
      return void await interaction.editReply({ content: `model set to ${value ?? "default"}`, components: [] })
    }
    if (action === AGENT_SELECT) {
      deps.setThreadAgent?.(id ?? interaction.channelId, value ?? null)
      return void await interaction.editReply({ content: `agent set to ${value ?? "default"}`, components: [] })
    }
    return void await interaction.editReply({ content: "unknown selection", components: [] })
  } catch (e) {
    const content = `error: ${(e as Error).message}`
    if (interaction.deferred || interaction.replied) return void await interaction.editReply({ content })
    await interaction.reply({ content, flags: 64 })
  }
}
