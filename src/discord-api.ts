// Minimal, dependency-free Discord REST client for the setup wizard and doctor.
//
// It only does what onboarding needs: confirm the bot token, read the
// application (to detect the privileged Gateway Intents), and list the guilds
// the bot is already in. Every call takes its base URL as a parameter so tests
// can point it at a local server; production uses DISCORD_API_BASE. No shell is
// ever involved, so this module keeps the argv-only invariant intact.

export const DISCORD_API_BASE = "https://discord.com/api/v10"

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type DiscordApiErrorKind = "unauthorized" | "network" | "http"

export class DiscordApiError extends Error {
  readonly kind: DiscordApiErrorKind
  readonly status?: number
  constructor(kind: DiscordApiErrorKind, message: string, status?: number) {
    super(message)
    this.name = "DiscordApiError"
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

export interface BotIdentity { id: string; username: string; discriminator?: string; globalName?: string }
export interface ApplicationInfo { id: string; name: string; flags: number }
export interface GuildInfo { id: string; name: string }
export interface IntentStatus { messageContent: boolean; guildMembers: boolean }

/**
 * The permissions Celly's invite URL requests, by Discord name. Kept small and
 * on purpose: manage channels (it creates `#project` channels), post and edit
 * messages and threads, read history, embeds/attachments for its cards, and
 * reactions. Documented in docs-site/reference/security.mdx.
 */
export const INVITE_PERMISSIONS = {
  MANAGE_CHANNELS: 1n << 4n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CREATE_PUBLIC_THREADS: 1n << 34n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const

export type InvitePermissionName = keyof typeof INVITE_PERMISSIONS

export const INVITE_PERMISSION_NAMES = Object.keys(INVITE_PERMISSIONS) as InvitePermissionName[]

export const INVITE_PERMISSION_VALUE: bigint = Object.values(INVITE_PERMISSIONS).reduce((acc, bit) => acc | bit, 0n)

// Discord "Application Flags". The *_LIMITED variants are the under-100-servers
// form of the same toggle; either bit means the intent is on.
const APPLICATION_FLAG = {
  GATEWAY_GUILD_MEMBERS: 1 << 14,
  GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
} as const

export function intentStatus(flags: number): IntentStatus {
  return {
    messageContent:
      (flags & APPLICATION_FLAG.GATEWAY_MESSAGE_CONTENT) !== 0 ||
      (flags & APPLICATION_FLAG.GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0,
    guildMembers:
      (flags & APPLICATION_FLAG.GATEWAY_GUILD_MEMBERS) !== 0 ||
      (flags & APPLICATION_FLAG.GATEWAY_GUILD_MEMBERS_LIMITED) !== 0,
  }
}

/**
 * The bot invite URL. `bot applications.commands` are the scopes; permissions is
 * the decimal bitfield Discord expects. Built by hand rather than with
 * URLSearchParams so the scope separator stays `%20`, not `+`.
 */
export function buildInviteUrl(applicationId: string, permissions: bigint = INVITE_PERMISSION_VALUE): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${permissions.toString()}`
}

/** Deep link to the application's Bot page, where the privileged intents live. */
export function settingsUrl(applicationId: string): string {
  return `https://discord.com/developers/applications/${applicationId}/bot`
}

export interface DiscordApiDeps {
  token: string
  base?: string
  fetch?: FetchLike
}

async function request(deps: DiscordApiDeps, path: string): Promise<unknown> {
  const base = deps.base ?? DISCORD_API_BASE
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike)
  let response: { ok: boolean; status: number; json(): Promise<unknown> }
  try {
    response = await doFetch(`${base}${path}`, { headers: { Authorization: `Bot ${deps.token}`, "User-Agent": "bot-celly" } })
  } catch (error) {
    throw new DiscordApiError("network", error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401) {
    throw new DiscordApiError("unauthorized", `Discord rejected the bot token (401) on ${path}`, 401)
  }
  if (!response.ok) {
    throw new DiscordApiError("http", `Discord API ${path} returned ${response.status}`, response.status)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new DiscordApiError("http", `Discord API ${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, response.status)
  }
}

export async function validateBotToken(deps: DiscordApiDeps): Promise<BotIdentity> {
  const data = (await request(deps, "/users/@me")) as { id?: unknown; username?: unknown; discriminator?: unknown; global_name?: unknown }
  if (!data || typeof data.id !== "string" || typeof data.username !== "string") {
    throw new DiscordApiError("http", "Discord returned an unexpected user payload")
  }
  const identity: BotIdentity = { id: data.id, username: data.username }
  if (typeof data.discriminator === "string") identity.discriminator = data.discriminator
  if (typeof data.global_name === "string") identity.globalName = data.global_name
  return identity
}

export async function getApplication(deps: DiscordApiDeps): Promise<ApplicationInfo> {
  const data = (await request(deps, "/applications/@me")) as { id?: unknown; name?: unknown; flags?: unknown }
  if (!data || typeof data.id !== "string") {
    throw new DiscordApiError("http", "Discord returned an unexpected application payload")
  }
  return {
    id: data.id,
    name: typeof data.name === "string" ? data.name : data.id,
    flags: typeof data.flags === "number" ? data.flags : 0,
  }
}

export async function listBotGuilds(deps: DiscordApiDeps): Promise<GuildInfo[]> {
  const data = await request(deps, "/users/@me/guilds")
  if (!Array.isArray(data)) return []
  return data
    .filter((guild): guild is { id: string; name?: unknown } => Boolean(guild) && typeof (guild as { id?: unknown }).id === "string")
    .map((guild) => ({ id: guild.id, name: typeof guild.name === "string" ? guild.name : guild.id }))
}

/** Convenience wrapper the wizard/doctor depend on; easy to fake in tests. */
export interface DiscordSetup {
  validateToken(token: string): Promise<BotIdentity>
  getApplication(token: string): Promise<ApplicationInfo>
  listGuilds(token: string): Promise<GuildInfo[]>
}

export function createDiscordSetup(options: { base?: string; fetch?: FetchLike } = {}): DiscordSetup {
  return {
    validateToken: (token) => validateBotToken({ token, ...options }),
    getApplication: (token) => getApplication({ token, ...options }),
    listGuilds: (token) => listBotGuilds({ token, ...options }),
  }
}
