import { ContainerBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder } from "discord.js"

export type CardTone = "info" | "ok" | "warn" | "error"

const ACCENT: Record<CardTone, number> = {
  info: 0x5865f2,
  ok: 0x57f287,
  warn: 0xfee75c,
  error: 0xed4245,
}

const GLYPH: Record<CardTone, string> = {
  info: "ℹ️",
  ok: "✅",
  warn: "⚠️",
  error: "❌",
}

/**
 * A Components v2 card for one-shot notices and errors: an accent-coloured
 * container with a bold heading and, when there is a body, a divider.
 */
export function noticeCard(tone: CardTone, title: string, body = ""): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(ACCENT[tone])
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${GLYPH[tone]} **${title}**`))
  const text = body.trim()
  if (text) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
  }
  return container
}

export interface CardPayload {
  components: ContainerBuilder[]
  allowedMentions: { parse: [] }
  flags: number
}

/**
 * Wrap one or more cards as a Components v2 message. A v2 message carries no
 * `content`, so this replaces `renderPayload` for card-shaped notices.
 */
export function cardPayload(...containers: ContainerBuilder[]): CardPayload {
  return { components: containers, allowedMentions: { parse: [] }, flags: MessageFlags.IsComponentsV2 }
}
