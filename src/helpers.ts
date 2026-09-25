import { ChannelType } from "discord.js"

export function findCategoryId(
  guild: { channels: { cache: { values(): IterableIterator<{ id: string; name: string; type: ChannelType }> } } },
  configuredId?: string,
): string | undefined {
  if (configuredId) return configuredId
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildCategory && channel.name === "Eregion") return channel.id
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

export function buildPromptText(text: string, attachmentPaths: string[]): string {
  return [text, ...attachmentPaths.map((p) => `[attachment] ${p}`)].filter((part) => part.trim().length > 0).join("\n\n")
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
