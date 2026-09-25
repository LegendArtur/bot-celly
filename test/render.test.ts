import { expect, test } from "vitest"
import { Renderer, chunkMessage, sanitizeThreadName } from "../src/render.ts"

test("chunks plain text under the cap", () => {
  expect(chunkMessage("a".repeat(4500), 1900).every((c) => c.length <= 1900)).toBe(true)
  expect(chunkMessage("hello", 1900)).toEqual(["hello"])
})
test("keeps code fences balanced across chunks", () => {
  const text = "```ts\n" + "x\n".repeat(2000) + "```"
  const chunks = chunkMessage(text, 1900)
  for (const c of chunks) expect((c.match(/```/g) ?? []).length % 2).toBe(0)
})
test("sanitizes thread names", () => {
  expect(sanitizeThreadName("  Hello\n\nWorld  ")).toBe("Hello World")
  expect(sanitizeThreadName("")).toMatch(/^session /)
  expect(sanitizeThreadName("x".repeat(200)).length).toBeLessThanOrEqual(80)
})
test("renderer batches edits within the interval", async () => {
  const calls: string[] = []; let t = 0
  const r = new Renderer({ send: async (c) => { calls.push("send:" + c); return "m1" }, edit: async (_id, c) => { calls.push("edit:" + c) },
    now: () => t, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a" })
  await r.tick(); expect(calls).toEqual(["send:a"])
  t = 500
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "ab" })
  await r.tick(); expect(calls.length).toBe(1)
  t = 1100; await r.tick(); expect(calls.length).toBe(2)
})
