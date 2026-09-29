import { ChannelType } from "discord.js"
import { ANSI, colorEnabled, paint } from "./ansi.js"

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function findCategoryId(
  guild: { channels: { cache: { values(): IterableIterator<{ id: string; name: string; type: ChannelType }> } } },
  configuredId?: string,
): string | undefined {
  if (configuredId) return configuredId
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildCategory && channel.name === "Forge") return channel.id
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

/**
 * Spec §9: one shared token bucket per CHANNEL, not per thread, so live edits
 * in different threads of the same project channel do not race each other's
 * rate-limit budget.
 */
export function channelIdForBucket(thread: { channelId: string }): string {
  return thread.channelId
}

export function unrefTimer(timer: unknown): void {
  const t = timer as { unref?: () => void }
  t.unref?.()
}

export const DISCORD_CHUNK_LIMIT = 1900

export function buildPromptText(text: string, attachmentPaths: string[]): string {
  return [text, ...attachmentPaths.map((p) => `[attachment] ${p}`)].filter((part) => part.trim().length > 0).join("\n\n")
}

export function seedThreadDefaults(
  get: (key: string) => string | undefined,
  channelId: string,
): { model: string | null; agent: string | null; variant: string | null } {
  return {
    model: get(`default_model:${channelId}`) ?? get("default_model") ?? null,
    agent: get(`default_agent:${channelId}`) ?? get("default_agent") ?? null,
    variant: get(`default_variant:${channelId}`) || get("default_variant") || null,
  }
}

/** The thinking-depth variant names a provider model advertises, if any. */
export function modelVariants(model: { variants?: unknown }): string[] {
  const variants = model?.variants
  if (!variants || typeof variants !== "object") return []
  return Object.keys(variants as Record<string, unknown>)
}

export const CHANNEL_NAME_MAX = 90
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

/**
 * Idempotency gate for the per-project SSE subscription. A project can become
 * `ready` from add, start, recreate, or reconnect; `claim` ensures exactly one
 * subscription is started per channel and `release` lets a later `/project start`
 * re-subscribe after stop/remove.
 */
export function createSubscriptionGate(): { claim(channelId: string): boolean; release(channelId: string): void; has(channelId: string): boolean } {
  const claimed = new Set<string>()
  return {
    claim(channelId) { if (claimed.has(channelId)) return false; claimed.add(channelId); return true },
    release(channelId) { claimed.delete(channelId) },
    has(channelId) { return claimed.has(channelId) },
  }
}

/** Turn raw Discord login/gateway errors into an actionable message for the operator. */
export function describeDiscordStartupError(err: unknown, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? colorEnabled()
  const raw = err instanceof Error ? err.message : String(err)
  if (/disallowed intents/i.test(raw)) {
    const [headline, ...rest] = [
      'Discord rejected the bot\'s privileged intents ("Used disallowed intents").',
      "Enable the Message Content intent, then restart:",
      "  1. Open https://discord.com/developers/applications and select your app.",
      "  2. Go to the Bot tab, then Privileged Gateway Intents.",
      '  3. Turn on "Message Content Intent" and click Save Changes.',
      "  4. Run `node dist/index.js` again.",
    ]
    return [paint(ANSI.red, headline, color), ...rest].join("\n")
  }
  if (/invalid token|token was provided/i.test(raw)) {
    const headline = paint(ANSI.red, "Discord rejected the bot token. Check DISCORD_TOKEN in .env (Developer Portal -> Bot -> Reset Token).", color)
    return `${headline}\n${raw}`
  }
  return raw
}

export interface StartupBannerGuild {
  id: string
  name: string
  missingPermissions: string[]
}
export interface StartupBanner {
  guilds: StartupBannerGuild[]
  projects: number
  dataDir: string
  model?: string
}
const LABEL_WIDTH = 10
export function formatStartupBanner(info: StartupBanner, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? colorEnabled()
  const rows: { label: string; value: string; tone?: string }[] = [
    { label: "Projects", value: String(info.projects) },
    { label: "Data", value: info.dataDir },
    { label: "Model", value: info.model ?? "(OpenCode default)" },
  ]
  for (const g of info.guilds) {
    rows.push({ label: "Guild", value: `${g.name} (${g.id})` })
    if (g.missingPermissions.length > 0) rows.push({ label: "MISSING", value: g.missingPermissions.join(", "), tone: ANSI.red })
  }
  const title = "Celly is running"
  const width = Math.max(title.length, ...rows.map((r) => r.label.padEnd(LABEL_WIDTH).length + r.value.length))
  const body = rows.map((row) => {
    if (row.tone) return paint(row.tone, `${row.label.padEnd(LABEL_WIDTH)}${row.value}`, color)
    return paint(ANSI.dim, row.label.padEnd(LABEL_WIDTH), color) + row.value
  })
  const next = info.projects === 0
    ? "in Discord run  /project add <name> <path>  then send a message in its channel."
    : "send a message in a project channel to start a session."
  const indent = "  "
  return [
    indent + paint(`${ANSI.bold}${ANSI.cyan}`, title, color),
    indent + paint(ANSI.dim, "─".repeat(width), color),
    ...body.map((line) => indent + line),
    indent + paint(ANSI.dim, "─".repeat(width), color),
    indent + paint(ANSI.dim, "Next".padEnd(LABEL_WIDTH), color) + next,
  ].join("\n")
}
