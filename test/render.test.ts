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
test("chunks longer fences without corruption", () => {
  const text = "````\n" + "a\n".repeat(1200) + "```\n" + "b\n".repeat(1200) + "````"
  const chunks = chunkMessage(text, 1900)
  for (const c of chunks) expect((c.match(/`{5}/g) ?? []).length % 2).toBe(0)
  const strip = (s: string) => s.replace(/`+/g, "").replace(/\s+/g, "")
  expect(strip(chunks.join(""))).toBe(strip(text))
})
test("renderer spills long output into additional messages", async () => {
  const sends: { id: string; content: string }[] = []
  const edits: { id: string; content: string }[] = []
  const ids: string[] = []
  let n = 0, t = 0
  const r = new Renderer({
    send: async (c) => { const id = "m" + (++n); sends.push({ id, content: c }); return id },
    edit: async (id, c) => { edits.push({ id, content: c }) },
    now: () => t, intervalMs: 1000, onMessageId: (id) => ids.push(id),
  })
  const first = "a".repeat(1800)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: first })
  await r.tick()
  expect(sends.length).toBe(1)
  expect(sends[0].content).toBe(first)
  t = 2000
  const grown = "a".repeat(1800) + "b".repeat(1800)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: grown })
  await r.tick()
  const grownChunks = chunkMessage(grown, 1900)
  expect(grownChunks.length).toBe(2)
  expect(sends.length).toBe(2)
  expect(edits.length).toBe(1)
  expect(edits[0].id).toBe(sends[0].id)
  expect(edits[0].content).toBe(grownChunks[0])
  expect(sends[1].content).toBe(grownChunks[1])
  t = 5000
  const final = "a".repeat(1800) + "b".repeat(3000)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: final })
  await r.finalize()
  const finalChunks = chunkMessage(final, 1900)
  expect(finalChunks.length).toBe(3)
  expect(sends.length).toBe(3)
  expect(ids).toEqual(["m1", "m2", "m3"])
  const latest = new Map<string, string>()
  for (const s of sends) latest.set(s.id, s.content)
  for (const e of edits) latest.set(e.id, e.content)
  expect(["m1", "m2", "m3"].map((id) => latest.get(id)).join("")).toBe(finalChunks.join(""))
})
test("caps chunks when a backtick run exceeds the fence budget", () => {
  const text = "`".repeat(1200) + "\nbody\n" + "`".repeat(1200)
  const chunks = chunkMessage(text, 1900)
  expect(chunks.every((c) => c.length <= 2000)).toBe(true)
  expect(chunks.every((c) => c.length <= 1900)).toBe(true)
})
test("renderer does not double-send under overlapping ticks", async () => {
  const sends: string[] = []
  let n = 0
  const r = new Renderer({
    send: async (c) => { sends.push(c); return "m" + (++n) },
    edit: async () => {},
    now: () => 0, intervalMs: 1000,
  })
  const body = "a".repeat(1900) + "b".repeat(1900) + "c".repeat(200)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: body })
  await Promise.all([r.tick(), r.tick()])
  expect(chunkMessage(body, 1900).length).toBe(3)
  expect(sends.length).toBe(3)
  expect(new Set(sends).size).toBe(sends.length)
})
test("renderer retries a failed send and keeps the body dirty", async () => {
  let attempts = 0
  const r = new Renderer({
    send: async () => { attempts++; if (attempts === 1) throw new Error("boom"); return "m1" },
    edit: async () => {},
    now: () => 0, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a" })
  await expect(r.tick()).rejects.toThrow("boom")
  await r.finalize()
  expect(attempts).toBe(2)
})

test("renderer deletes surplus chunk messages when the body shrinks", async () => {
  const sends: string[] = []
  const edits: string[] = []
  const deletes: string[] = []
  let n = 0, t = 0
  const r = new Renderer({
    send: async (c) => { sends.push(c); return "m" + (++n) },
    edit: async (id) => { edits.push(id) },
    delete: async (id) => { deletes.push(id) },
    now: () => t, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a".repeat(1800) + "b".repeat(1800) })
  await r.finalize()
  expect(sends.length).toBe(2)
  t = 5000
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "small" })
  await r.finalize()
  expect(sends.length).toBe(2)
  expect(edits).toEqual(["m1"])
  expect(deletes).toEqual(["m2"])
})

test("renderer without a delete dep still drops surplus ids without throwing", async () => {
  const sends: string[] = []
  let n = 0, t = 0
  const r = new Renderer({
    send: async (c) => { sends.push(c); return "m" + (++n) },
    edit: async () => {},
    now: () => t, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a".repeat(1800) + "b".repeat(1800) })
  await r.finalize()
  t = 5000
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "small" })
  await expect(r.finalize()).resolves.toBeUndefined()
})

test("finalize flushes content pushed during an in-flight send", async () => {
  const sends: string[] = []
  const edits: { id: string; content: string }[] = []
  let releaseSend!: () => void
  const sendGate = new Promise<void>((r) => { releaseSend = r })
  let t = 0
  const r = new Renderer({
    send: async (c) => { sends.push(c); await sendGate; return "m1" },
    edit: async (id, c) => { edits.push({ id, content: c }) },
    now: () => t, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a" })
  const pending = r.flush()
  await Promise.resolve()
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "ab" })
  releaseSend()
  await pending
  expect(sends).toEqual(["a"])
  expect(edits).toEqual([{ id: "m1", content: "ab" }])
})

test("renderer rebuilds interleaved text parts", async () => {
  const calls: string[] = []
  const r = new Renderer({
    send: async (c) => { calls.push(c); return "m1" },
    edit: async () => {},
    now: () => 0, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "a", text: "A" })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "b", text: "B" })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "a", text: "AA" })
  await r.tick()
  expect(calls).toEqual(["AA\n\nB"])
})
