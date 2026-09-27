import { Client, GatewayIntentBits, Partials, PermissionFlagsBits } from "discord.js"
import type { Message } from "discord.js"
import type { Config } from "./config.ts"

export function isAuthorized(
  member: { id: string; roles: string[]; permissions: { has(bit: bigint): boolean } },
  guildOwnerId: string,
  cfg: { accessRoleId?: string; blockRoleId?: string },
): boolean {
  if (cfg.blockRoleId && member.roles.includes(cfg.blockRoleId)) return false
  if (member.id === guildOwnerId) return true
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true
  if (cfg.accessRoleId && member.roles.includes(cfg.accessRoleId)) return true
  return false
}

export function isOwner(
  member: { id: string; roles: string[] },
  guildOwnerId: string,
  cfg: { ownerRoleId?: string },
): boolean {
  if (member.id === guildOwnerId) return true
  if (cfg.ownerRoleId && member.roles.includes(cfg.ownerRoleId)) return true
  return false
}

export function createDiscordClient(cfg: Config): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  })
}
export function rolesOf(member: { roles: { cache: Map<string, { id: string }> } }): string[] {
  return [...member.roles.cache.values()].map((r) => r.id)
}

export async function fetchConfiguredGuilds<G extends { id: string }>(
  ids: string[],
  fetchGuild: (id: string) => Promise<G>,
  log: { warn(message: string, fields?: any): void },
): Promise<G[]> {
  const guilds: G[] = []
  const failures: string[] = []
  for (const id of ids) {
    try {
      guilds.push(await fetchGuild(id))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${id}: ${message}`)
      log.warn("configured guild is unavailable; skipping", { guildId: id, error: message })
    }
  }
  if (guilds.length === 0) throw new Error(`could not fetch any configured guild (${failures.join("; ")})`)
  return guilds
}

export function shouldHandleMessage(message: Message, projectChannelId: string | undefined, knownThread = false): boolean {
  if (!projectChannelId) return false
  if (message.author.bot || message.webhookId || message.system) return false
  // Archived/partial thread channels can report parentId === null, so when the
  // DB already knows this thread we trust the resolved project instead.
  if (knownThread) return true
  const channel = message.channel
  if (channel.id !== projectChannelId && !("parentId" in channel && channel.parentId === projectChannelId)) return false
  return true
}
