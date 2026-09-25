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

export function createDiscordClient(cfg: Config): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  })
}
export function rolesOf(member: { roles: { cache: Map<string, { id: string }> } }): string[] {
  return [...member.roles.cache.values()].map((r) => r.id)
}

export function shouldHandleMessage(message: Message, projectChannelId: string | undefined): boolean {
  if (!projectChannelId) return false
  if (message.author.bot || message.webhookId || message.system) return false
  const channel = message.channel
  if (channel.id !== projectChannelId && !("parentId" in channel && channel.parentId === projectChannelId)) return false
  return true
}
