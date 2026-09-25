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

export interface CommandDeps {
  projects: ProjectService
  runner: Runner
  db: Db
  authorized(interaction: any): boolean
}

export async function handleCommand(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply({ content: "You are not authorized.", flags: 64 }); return }
  await interaction.deferReply({ flags: 64 })
  const name = interaction.options.getString("name", false)
  try {
    if (interaction.commandName === "project") {
      const sub = interaction.options.getSubcommand(false)
      if (sub === "add") return void await interaction.editReply(JSON.stringify(await deps.projects.addProject({ guildId: interaction.guildId, name, directory: interaction.options.getString("path", true) })))
      if (sub === "list") return void await interaction.editReply(deps.db.projects.list().map((p) => `${p.name} (${p.status})`).join("\n") || "no projects")
      if (sub === "status") { const p = deps.db.projects.getByName(name); return void await interaction.editReply(p ? `${p.name}: ${p.status} on 127.0.0.1:${p.hostPort}` : "not found") }
      if (sub === "start") { await deps.projects.ensureReady(deps.db.projects.getByName(name)!.channelId); return void await interaction.editReply("started") }
      if (sub === "stop") { await deps.projects.stop(deps.db.projects.getByName(name)!.channelId); return void await interaction.editReply("stopped") }
      if (sub === "remove") {
        const expected = interaction.options.getString("confirm", true)
        if (expected !== name) return void await interaction.editReply("confirmation name does not match")
        await deps.projects.remove(deps.db.projects.getByName(name)!.channelId)
        return void await interaction.editReply("removed")
      }
      if (sub === "create") return void await interaction.editReply("use /project add for v1")
    }
    if (interaction.commandName === "abort") { await deps.runner.abort(interaction.channelId); return void await interaction.editReply("aborted") }
    await interaction.editReply("not implemented in this build")
  } catch (e) {
    await interaction.editReply(`error: ${(e as Error).message}`)
  }
}
