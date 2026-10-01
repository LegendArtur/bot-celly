import { MessageFlags } from "discord.js"
import { expect, test } from "vitest"
import { Renderer, chunkMessage, formatPrompt, renderPayload, sanitizeThreadName, toolGlyph } from "../src/render.ts"

test("chunks plain text under the cap", () => {
  expect(chunkMessage("a".repeat(4500), 1900).every((c) => c.length <= 1900)).toBe(true)
  expect(chunkMessage("hello", 1900)).toEqual(["hello"])
})
test("chunkMessage returns no chunks for an empty body", () => {
  expect(chunkMessage("")).toEqual([])
})
test("renderPayload suppresses mentions and link embeds", () => {
  expect(renderPayload("hi")).toEqual({ content: "hi", allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds })
})
test("renderer never sends an empty body", async () => {
  const sends: string[] = []
  const r = new Renderer({
    send: async (c) => { sends.push(c); return "m1" },
    edit: async () => {},
    now: () => 0, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "" })
  await r.finalize()
  expect(sends).toEqual([])
})
test("renderer deletes messages when the body shrinks to empty", async () => {
  const sends: string[] = []
  const deletes: string[] = []
  let n = 0
  const r = new Renderer({
    send: async (c) => { sends.push(c); return "m" + (++n) },
    edit: async () => {},
    delete: async (id) => { deletes.push(id) },
    now: () => 0, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hello" })
  await r.finalize()
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "" })
  await r.finalize()
  expect(sends).toEqual(["hello"])
  expect(deletes).toEqual(["m1"])
})
test("keeps code fences balanced across chunks", () => {
  const text = "```ts\n" + "x\n".repeat(2000) + "```"
  const chunks = chunkMessage(text, 1900)
  for (const c of chunks) {
    expect((c.match(/```/g) ?? []).length % 2).toBe(0)
    expect(/`{4,}/.test(c)).toBe(false)
  }
})
test("never emits a fence longer than three backticks", () => {
  const text = "```ts\n" + "const x = 1\n".repeat(400) + "```"
  const chunks = chunkMessage(text, 1900)
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(1900)
    expect(/`{4,}/.test(c)).toBe(false)
  }
})
test("reopens a split code block with its language", () => {
  const text = "```bash\n" + "echo hi\n".repeat(400) + "```"
  const chunks = chunkMessage(text, 1900)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks[1]!.startsWith("```bash\n")).toBe(true)
})
test("preserves every code line across chunk boundaries", () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
  const chunks = chunkMessage("```ts\n" + body + "\n```", 1900)
  const joined = chunks.join("\n")
  for (let i = 0; i < 400; i++) expect(joined).toContain(`line ${i}`)
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
test("normalizes longer fences and preserves the body", () => {
  const text = "````\n" + "a\n".repeat(1200) + "```\n" + "b\n".repeat(1200) + "````"
  const chunks = chunkMessage(text, 1900)
  for (const c of chunks) expect(/`{4,}/.test(c)).toBe(false)
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

test("renderer appends the footer as a final -# line", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {}, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hello" })
  r.setFooter("$0.0123 · 1.2k in / 3.4k out")
  await r.finalize()
  expect(sends).toEqual(["hello\n\n-# $0.0123 · 1.2k in / 3.4k out"])
})

test("renderer footers can be replaced and cleared", async () => {
  const edits: string[] = []
  const r = new Renderer({ initialMessageId: "m1", send: async () => "m1", edit: async (_id, c) => { edits.push(c) }, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hi" })
  r.setFooter("a")
  await r.finalize()
  r.setFooter("b")
  await r.finalize()
  r.setFooter("")
  await r.finalize()
  expect(edits).toEqual(["hi\n\n-# a", "hi\n\n-# b", "hi"])
})

test("elapsedMs measures from the first push to finalize", async () => {
  let t = 100
  const r = new Renderer({ send: async () => "m1", edit: async () => {}, now: () => t, intervalMs: 1000 })
  expect(r.elapsedMs()).toBe(0)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hi" })
  t = 350
  expect(r.elapsedMs()).toBe(250)
  await r.finalize()
  t = 9999
  expect(r.elapsedMs()).toBe(250)
})

test("renderer seeds every persisted chunk id and reports id changes", async () => {
  const edits: { id: string; content: string }[] = []
  const sends: string[] = []
  const reported: string[][] = []
  const body = "a".repeat(1800) + "b".repeat(1800) + "c".repeat(1800)
  const r = new Renderer({
    initialMessageIds: ["m1", "m2", "m3", "m4"],
    send: async (c) => { sends.push(c); return "n" },
    edit: async (id, content) => { edits.push({ id, content }) },
    delete: async () => {},
    now: () => 0, intervalMs: 1, onMessageIds: (ids) => reported.push([...ids]),
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: body })
  await r.finalize()
  expect(sends).toEqual([])
  expect(edits.map((e) => e.id)).toEqual(["m1", "m2", "m3"])
  expect(reported[reported.length - 1]).toEqual(["m1", "m2", "m3"])
})

test("renderer renders tool lines with a title truncated to 120 chars", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p1", name: "bash", status: "running", title: "npm test" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p2", name: "edit", status: "completed", title: "x".repeat(200) })
  await r.finalize()
  expect(sends).toEqual([`> 🔄 \`bash\` · npm test\n> ✅ \`edit\` · ${"x".repeat(119)}…`])
})

test("renderer tool lines without a title omit the separator", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p1", name: "bash", status: "running" })
  await r.finalize()
  expect(sends).toEqual(["> 🔄 `bash`"])
})

test("renderer interleaves text and tool segments in arrival order", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p1", text: "before" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "p2", name: "bash", status: "completed", title: "npm test" })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p3", text: "after" })
  await r.finalize()
  expect(sends).toEqual(["before\n\n> ✅ `bash` · npm test\n\nafter"])
})

test("renderer keeps a tool segment in place when its status updates", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "running", title: "npm test" })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p1", text: "mid" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "completed", title: "npm test" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t2", name: "edit", status: "completed", title: "src/x.ts" })
  await r.finalize()
  expect(sends).toEqual(["> ✅ `bash` · npm test\n\nmid\n\n> ✅ `edit` · src/x.ts"])
})

test("renderer upserts duplicate part ids instead of duplicating lines", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "pending", title: "npm test" })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "completed", title: "npm test" })
  await r.finalize()
  expect(sends).toEqual(["> ✅ `bash` · npm test"])
})

test("renderer seeds the prompt as the first segment", async () => {
  const sends: string[] = []
  const r = new Renderer({ prompt: "  fix   the bug ", send: async (c) => { sends.push(c); return "m1" },
    edit: async () => {}, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "on it" })
  await r.finalize()
  expect(sends).toEqual(["> **you** · fix the bug\n\non it"])
})

test("renderer clamps a long prompt", async () => {
  const sends: string[] = []
  const r = new Renderer({ prompt: "x".repeat(400), send: async (c) => { sends.push(c); return "m1" },
    edit: async () => {}, now: () => 0, intervalMs: 1000 })
  await r.finalize()
  expect(sends).toEqual([`> **you** · ${"x".repeat(299)}…`])
})

test("renderer ignores a blank prompt", async () => {
  const sends: string[] = []
  const r = new Renderer({ prompt: "   ", send: async (c) => { sends.push(c); return "m1" },
    edit: async () => {}, now: () => 0, intervalMs: 1000 })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "only" })
  await r.finalize()
  expect(sends).toEqual(["only"])
})

test("renderer renders an agent question inline with its controls on the message", async () => {
  const sends: Array<{ content: string; components: any[] }> = []
  const edits: Array<{ id: string; content: string; components: any[] }> = []
  const r = new Renderer({
    send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return "m1" },
    edit: async (id, c, components) => { edits.push({ id, content: c, components: components ?? [] }) },
    now: () => 0, intervalMs: 1000,
  })
  const controls = [{ type: 1, components: [{ type: 2, custom_id: "celly:answer:q1:0" }] }]
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "Approaches: A." })
  r.upsertQuestion("q1", "**❓ The agent asked**\nWhich DB?", controls)
  await r.finalize()
  expect(sends).toHaveLength(1)
  expect(sends[0]!.content).toBe("Approaches: A.\n\n**❓ The agent asked**\nWhich DB?")
  expect(sends[0]!.components).toEqual(controls)
})

test("renderer clears question controls once answered without dropping the block", async () => {
  const sends: Array<{ content: string; components: any[] }> = []
  const edits: Array<{ id: string; content: string; components: any[] }> = []
  const r = new Renderer({
    send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return `m${sends.length}` },
    edit: async (id, c, components) => { edits.push({ id, content: c, components: components ?? [] }) },
    now: () => 0, intervalMs: 1000,
  })
  r.upsertQuestion("q1", "**❓ The agent asked**\nWhich DB?", [{ type: 1 }])
  await r.finalize()
  r.upsertQuestion("q1", "**❓ The agent asked**\nWhich DB?\n**Answer:** sqlite", null)
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "B. Extract it." })
  await r.flush()
  const last = edits.at(-1)!
  expect(last.content).toContain("**Answer:** sqlite")
  expect(last.content).toContain("B. Extract it.")
  expect(last.components).toEqual([])
})

test("renderer attaches question controls to the last chunk of a long body", async () => {
  const sends: Array<{ content: string; components: any[] }> = []
  const r = new Renderer({
    send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return `m${sends.length}` },
    edit: async () => {},
    now: () => 0, intervalMs: 1000,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a".repeat(2600) })
  r.upsertQuestion("q1", "Q", [{ type: 1 }])
  await r.finalize()
  expect(sends.length).toBeGreaterThan(1)
  expect(sends.slice(0, -1).every((s) => s.components.length === 0)).toBe(true)
  expect(sends.at(-1)!.components).toEqual([{ type: 1 }])
})

test("renderer keeps run controls on the last chunk until finalize removes them", async () => {
  const sends: Array<{ content: string; components: any[] }> = []
  const edits: Array<{ id: string; content: string; components: any[] }> = []
  const controls = [{ type: 1, components: [{ type: 2, custom_id: "celly:abort:t1", label: "Stop" }] }]
  const r = new Renderer({
    send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return "m1" },
    edit: async (id, c, components) => { edits.push({ id, content: c, components: components ?? [] }) },
    now: () => 0, intervalMs: 1000, controls,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "working" })
  await r.flush()
  expect(sends[0]!.components).toEqual(controls)
  await r.finalize()
  expect(edits.at(-1)!.components).toEqual([])
})

test("renderer re-attaches run controls to a new last chunk", async () => {
  const sends: Array<{ content: string; components: any[] }> = []
  const controls = [{ type: 1, components: [{ type: 2, custom_id: "celly:abort:t1" }] }]
  const r = new Renderer({
    send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return `m${sends.length}` },
    edit: async () => {},
    now: () => 0, intervalMs: 1000, controls,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "a".repeat(2600) })
  await r.flush()
  expect(sends.length).toBeGreaterThan(1)
  expect(sends.slice(0, -1).every((s) => s.components.length === 0)).toBe(true)
  expect(sends.at(-1)!.components).toEqual(controls)
})

test("renderer lists question controls before run controls and caps rows", async () => {
  const sends: Array<{ content: string; components: any[] }> = []
  const question = [{ type: 1, custom_id: "q" }]
  const stop = [{ type: 1, custom_id: "celly:abort:t1" }]
  const r = new Renderer({
    send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return `m${sends.length}` },
    edit: async () => {}, now: () => 0, intervalMs: 1000, controls: stop,
  })
  r.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hi" })
  r.upsertQuestion("q1", "Q", question)
  await r.flush()
  expect(sends.at(-1)!.components).toEqual([...question, ...stop])

  const many = Array.from({ length: 5 }, (_, i) => ({ type: 1, custom_id: `q${i}` }))
  const r2 = new Renderer({
    send: async (c, components) => { sends.push({ content: c, components: components ?? [] }); return `n${sends.length}` },
    edit: async () => {}, now: () => 0, intervalMs: 1000, controls: stop,
  })
  r2.push({ kind: "text", sessionId: "s", messageId: "m", partId: "p", text: "hi" })
  r2.upsertQuestion("q1", "Q", many)
  await r2.flush()
  expect(sends.at(-1)!.components).toEqual(many)
})

test("renderer renders notices with a tone glyph", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "notice", sessionId: "s", partId: "n1", text: "boom", tone: "error" })
  await r.finalize()
  expect(sends).toEqual(["> ❌ **Error** — boom"])
})

test("renderer flattens multiline notices", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "notice", sessionId: "s", partId: "n1", text: "line one\nline two", tone: "warn" })
  await r.finalize()
  expect(sends).toEqual(["> ⚠️ **Warning** — line one line two"])
})

test("toolGlyph maps every opencode status", () => {
  expect(toolGlyph("pending")).toBe("⏳")
  expect(toolGlyph("running")).toBe("🔄")
  expect(toolGlyph("completed")).toBe("✅")
  expect(toolGlyph("error")).toBe("❌")
  expect(toolGlyph("mystery")).toBe("•")
})

test("formatPrompt clamps exactly at the boundary", () => {
  expect(formatPrompt("x".repeat(300))).toBe(`> **you** · ${"x".repeat(300)}`)
  expect(formatPrompt("x".repeat(301))).toBe(`> **you** · ${"x".repeat(299)}…`)
})

test("renderer clamps and flattens a long info notice", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "notice", sessionId: "s", partId: "n1", text: "word\n".repeat(400), tone: "info" })
  await r.finalize()
  expect(sends[0]!.startsWith("> ℹ️ **Note** — ")).toBe(true)
  expect(sends[0]!.endsWith("…")).toBe(true)
  expect(sends[0]!.length).toBeLessThanOrEqual("> ℹ️ **Note** — ".length + 500)
})

test("renderer renders a blank notice without a dangling separator", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "notice", sessionId: "s", partId: "n1", text: "   ", tone: "warn" })
  await r.finalize()
  expect(sends).toEqual(["> ⚠️ **Warning**"])
})

test("renderer flattens multiline tool titles", async () => {
  const sends: string[] = []
  const r = new Renderer({ send: async (c) => { sends.push(c); return "m1" }, edit: async () => {},
    now: () => 0, intervalMs: 1000 })
  r.push({ kind: "tool", sessionId: "s", messageId: "m", partId: "t1", name: "bash", status: "completed", title: "line one\nline two" })
  await r.finalize()
  expect(sends).toEqual(["> ✅ `bash` · line one line two"])
})
