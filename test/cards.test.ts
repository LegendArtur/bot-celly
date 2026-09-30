import { MessageFlags } from "discord.js"
import { expect, test } from "vitest"
import { cardPayload, noticeCard } from "../src/cards.ts"

test("cardPayload marks the message as Components v2 and never pings", () => {
  const payload = cardPayload(noticeCard("warn", "Sandbox missing", "run /project start"))
  expect(payload.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2)
  expect(payload.allowedMentions).toEqual({ parse: [] })
  expect(payload.components).toHaveLength(1)
  expect((payload as { content?: unknown }).content).toBeUndefined()
})

test("noticeCard renders a heading, divider and body inside a container", () => {
  const json = noticeCard("error", "Boom", "it failed").toJSON() as any
  expect(json.type).toBe(17)
  expect(json.accent_color).toBe(0xed4245)
  expect(json.components.map((c: any) => c.type)).toEqual([10, 14, 10])
  expect(json.components[0].content).toContain("Boom")
  expect(json.components[2].content).toBe("it failed")
})

test("noticeCard omits the divider when there is no body", () => {
  const json = noticeCard("ok", "Connected").toJSON() as any
  expect(json.components.map((c: any) => c.type)).toEqual([10])
  expect(json.accent_color).toBe(0x57f287)
})

test("noticeCard trims and drops a whitespace-only body", () => {
  const json = noticeCard("info", "Note", "   ").toJSON() as any
  expect(json.components.map((c: any) => c.type)).toEqual([10])
})
