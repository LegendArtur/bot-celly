// test/events.test.ts
import { readFileSync } from "node:fs"
import { expect, test, vi } from "vitest"
import type { QuestionInfo } from "@opencode-ai/sdk/v2"
import { EventRouter, INITIAL_BACKOFF, MAX_BACKOFF, nextBackoff, normalizeEvent, partToEvent, trimSseBuffer } from "../src/events.ts"
import { startTestServer } from "./helpers/http.ts"

test("normalizes a text part", () => {
  expect(normalizeEvent({ type: "message.part.updated", properties: { part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "hi" } } }))
    .toEqual({ kind: "text", sessionId: "s1", messageId: "m1", partId: "p1", text: "hi" })
})
test("normalizes tool state", () => {
  const e = normalizeEvent({ type: "message.part.updated", properties: { part: { id: "p2", messageID: "m1", sessionID: "s1", type: "tool", tool: "bash", state: { status: "running" } } } })
  expect(e).toMatchObject({ kind: "tool", name: "bash", status: "running" })
})
test("normalizes idle and error", () => {
  expect(normalizeEvent({ type: "session.idle", properties: { sessionID: "s1" } })).toEqual({ kind: "idle", sessionId: "s1" })
  expect(normalizeEvent({ type: "session.error", properties: { sessionID: "s1", error: "boom" } })).toMatchObject({ kind: "error", message: "boom" })
})
test("normalizes a permission request", () => {
  expect(normalizeEvent({ type: "permission.updated", properties: { sessionID: "s1", id: "perm1", tool: "bash", patterns: ["git push *"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "perm1", source: "v1", tool: "bash", patterns: ["git push *"] })
})
test("ignores unknown events", () => {
  expect(normalizeEvent({ type: "server.connected", properties: {} })).toBeNull()
})

test("unwraps the global event envelope", () => {
  expect(normalizeEvent({ payload: { type: "session.idle", properties: { sessionID: "s1" } } }))
    .toEqual({ kind: "idle", sessionId: "s1" })
})

test("normalizes the SDK permission shape (type/pattern)", () => {
  expect(normalizeEvent({ type: "permission.updated", properties: { id: "perm1", sessionID: "s1", type: "bash", pattern: ["git push *"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "perm1", source: "v1", tool: "bash", patterns: ["git push *"] })
})

test("extracts the message from an SDK error object", () => {
  expect(normalizeEvent({ type: "session.error", properties: { sessionID: "s1", error: { name: "UnknownError", data: { message: "boom" } } } }))
    .toMatchObject({ kind: "error", message: "boom" })
})

test("exponential backoff starts at 1s, doubles, and caps at 30s", () => {
  expect(INITIAL_BACKOFF).toBe(1000)
  expect(MAX_BACKOFF).toBe(30000)
  expect(nextBackoff(INITIAL_BACKOFF)).toBe(2000)
  expect(nextBackoff(2000)).toBe(4000)
  expect(nextBackoff(4000)).toBe(8000)
  expect(nextBackoff(8000)).toBe(16000)
  expect(nextBackoff(16000)).toBe(30000)
  expect(nextBackoff(30000)).toBe(30000)
  expect(nextBackoff(MAX_BACKOFF * 4)).toBe(30000)
})

test("backoff resets to 1s after a successful connection", () => {
  expect(nextBackoff(16000, true)).toBe(1000)
  expect(nextBackoff(30000, true)).toBe(1000)
})

const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("waitFor timed out")
}

test("partToEvent maps a bare text or tool part and ignores others", () => {
  expect(partToEvent("s1", "m1", { id: "p1", type: "text", text: "hi" }))
    .toEqual({ kind: "text", sessionId: "s1", messageId: "m1", partId: "p1", text: "hi" })
  expect(partToEvent("s1", "m1", { id: "p2", type: "tool", tool: "bash", state: { status: "running" } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p2", name: "bash", status: "running" })
  expect(partToEvent("s1", "m1", { id: "p3", type: "step" })).toBeNull()
})

test("normalizes a step-finish part into a usage event", () => {
  expect(normalizeEvent({ type: "message.part.updated", properties: { part: {
    id: "p4", messageID: "m1", sessionID: "s1", type: "step-finish", reason: "stop",
    cost: 0.0123, tokens: { input: 1200, output: 3400, reasoning: 0, cache: { read: 10, write: 20 } },
  } } })).toEqual({ kind: "usage", sessionId: "s1", messageId: "m1", cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 10, cacheWrite: 20 })
})

test("partToEvent defaults missing step-finish token fields to zero", () => {
  expect(partToEvent("s1", "m1", { id: "p5", type: "step-finish", cost: 1 }))
    .toEqual({ kind: "usage", sessionId: "s1", messageId: "m1", cost: 1, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })
})

test("ignores message.updated usage so step-finish stays the single source", () => {
  expect(normalizeEvent({ type: "message.updated", properties: { info: {
    id: "m2", sessionID: "s1", role: "assistant", cost: 0.5,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 3, write: 4 } },
  } } })).toBeNull()
  expect(normalizeEvent({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant" } } })).toBeNull()
  expect(normalizeEvent({ type: "message.updated", properties: { info: {
    id: "m3", sessionID: "s1", role: "user", cost: 0,
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } } })).toBeNull()
})

test("dispatches the recorded usage fixtures over SSE", async () => {
  const fixture = readFileSync(new URL("./fixtures/opencode-usage-events.jsonl", import.meta.url), "utf8").trim().split("\n")
  const events: Array<{ threadId: string; e: any }> = []
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    for (const line of fixture) res.write(`data: ${line}\n\n`)
    res.end()
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId.startsWith("ses_u") ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 2)
    ac.abort()
    await done
    expect(events).toEqual([
      { threadId: "t1", e: { kind: "usage", sessionId: "ses_u1", messageId: "msg_u1", cost: 0.01, tokensIn: 1000, tokensOut: 200, cacheRead: 100, cacheWrite: 50 } },
      { threadId: "t1", e: { kind: "usage", sessionId: "ses_u2", messageId: "msg_u2", cost: 0.0023, tokensIn: 200, tokensOut: 300, cacheRead: 0, cacheWrite: 0 } },
    ])
  } finally {
    await server.close()
  }
})

test("the event stream sends the opencode basic auth header", async () => {
  let auth: string | undefined
  const server = await startTestServer((req, res) => {
    auth = req.headers.authorization
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.end()
  })
  try {
    const router = new EventRouter({ route: () => undefined, onEvent: () => {}, onResync: async () => {}, knownSessions: () => [] })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => auth !== undefined)
    ac.abort()
    await done
    expect(auth).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
  } finally {
    await server.close()
  }
})

test("routes SSE frames by session and resyncs known sessions on reconnect", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const resyncs: Array<{ threadId: string; sessionId: string }> = []
  let connections = 0
  const server = await startTestServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) {
      res.write(`data: ${JSON.stringify({ payload: { id: "e1", type: "message.part.updated", properties: { part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "hi" } } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ payload: { id: "e2", type: "session.idle", properties: { sessionID: "s1" } } })}\n\n`)
      res.write("data: not-json\n\n")
      res.write(`data: ${JSON.stringify({ payload: { id: "e3", type: "session.idle", properties: { sessionID: "unknown" } } })}\n\n`)
      res.end()
    }
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async (threadId, sessionId) => { resyncs.push({ threadId, sessionId }) },
      knownSessions: () => [{ threadId: "t1", sessionId: "s1" }],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 2 && resyncs.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([
      { threadId: "t1", e: { kind: "text", sessionId: "s1", messageId: "m1", partId: "p1", text: "hi" } },
      { threadId: "t1", e: { kind: "idle", sessionId: "s1" } },
    ])
    expect(resyncs).toEqual([{ threadId: "t1", sessionId: "s1" }])
    expect(connections).toBeGreaterThanOrEqual(2)
  } finally {
    await server.close()
  }
})

test("drops user message parts so the prompt is not echoed back", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  let connections = 0
  const server = await startTestServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) {
      res.write(`data: ${JSON.stringify({ payload: { type: "message.updated", properties: { info: { id: "mu", sessionID: "s1", role: "user" } } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ payload: { type: "message.part.updated", properties: { part: { id: "pu", messageID: "mu", sessionID: "s1", type: "text", text: "the prompt" } } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ payload: { type: "message.updated", properties: { info: { id: "ma", sessionID: "s1", role: "assistant" } } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ payload: { type: "message.part.updated", properties: { part: { id: "pa", messageID: "ma", sessionID: "s1", type: "text", text: "the answer" } } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\n\n`)
      res.end()
    }
  })
  try {
    const router = new EventRouter({
      route: () => "t1",
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 2)
    ac.abort()
    await done
    expect(events.map((x) => x.e)).toEqual([
      { kind: "text", sessionId: "s1", messageId: "ma", partId: "pa", text: "the answer" },
      { kind: "idle", sessionId: "s1" },
    ])
  } finally {
    await server.close()
  }
})

test("isolates a throwing onResync and keeps the stream alive", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const events: Array<{ threadId: string; e: any }> = []
  let connections = 0
  let resyncAttempts = 0
  const server = await startTestServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) res.end()
    else res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\n\n`)
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => { resyncAttempts++; throw new Error("resync boom") },
      knownSessions: () => [{ threadId: "t1", sessionId: "s1" }],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => resyncAttempts >= 1 && events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
    expect(resyncAttempts).toBe(1)
    expect(connections).toBe(2)
  } finally {
    await server.close()
    warn.mockRestore()
  }
})

test("trimSseBuffer drops complete frames but keeps a trailing partial frame", () => {
  expect(trimSseBuffer("data: a\n\ndata: b\n\n", 1)).toBe("")
  expect(trimSseBuffer("data: old\n\ndata: partial", 1)).toBe("data: partial")
  expect(trimSseBuffer("data: old\r\n\r\ndata: partial", 1)).toBe("data: partial")
  expect(trimSseBuffer("small", 100)).toBe("small")
})

test("routes SSE stream warnings through the injected logger instead of the console", async () => {
  const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = []
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const events: Array<{ threadId: string; e: any }> = []
  let connections = 0
  let knownCalls = 0
  const server = await startTestServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) res.end()
    else res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\n\n`)
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => { knownCalls++; throw new Error("known boom") },
      log: { warn: (msg, fields) => warnings.push({ msg, fields }) },
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => knownCalls >= 1 && events.length >= 1)
    ac.abort()
    await done
    expect(warnings.some((w) => w.msg.includes("known"))).toBe(true)
    expect(warnings[0]?.fields?.error).toContain("known boom")
    expect(consoleWarn).not.toHaveBeenCalled()
  } finally {
    await server.close()
    consoleWarn.mockRestore()
  }
})

test("isolates a throwing knownSessions and keeps the stream alive", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const events: Array<{ threadId: string; e: any }> = []
  let connections = 0
  let knownCalls = 0
  const server = await startTestServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) res.end()
    else res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\n\n`)
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => { knownCalls++; throw new Error("known boom") },
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => knownCalls >= 1 && events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
    expect(connections).toBe(2)
  } finally {
    await server.close()
    warn.mockRestore()
  }
})

test("dispatches a frame that arrives right before the stream closes", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\n\n`)
    res.end()
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
  } finally {
    await server.close()
  }
})

test("parses CRLF-terminated frames", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\r\n\r\n`)
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
  } finally {
    await server.close()
  }
})

test("joins multi-line data with a newline", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.write('data: {"payload":{"type":"session.idle",\ndata: "properties":{"sessionID":"s1"}}}\n\n')
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
  } finally {
    await server.close()
  }
})

test("asks onUnknownSession for an unknown session and routes the event to the created thread", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const looked: string[] = []
  let connections = 0
  const server = await startTestServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) {
      res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "terminal-1" } } })}\n\n`)
      res.end()
    }
  })
  try {
    const router = new EventRouter({
      route: () => undefined,
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
      onUnknownSession: async (sessionId) => { looked.push(sessionId); return `auto:${sessionId}` },
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 1)
    ac.abort()
    await done
    expect(looked).toEqual(["terminal-1"])
    expect(events).toEqual([{ threadId: "auto:terminal-1", e: { kind: "idle", sessionId: "terminal-1" } }])
  } finally {
    await server.close()
  }
})

test("does not dispatch an event when the subscription aborts while resolving an unknown session", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const ac = new AbortController()
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "terminal-1" } } })}\n\n`)
    res.end()
  })
  try {
    const router = new EventRouter({
      route: () => undefined,
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
      onUnknownSession: async (sessionId) => { ac.abort(); return `auto:${sessionId}` },
    })
    await router.subscribe(server.url, "pw", ac.signal)
    expect(events).toEqual([])
  } finally {
    await server.close()
  }
})

test("dispatches the recorded opencode event fixture over SSE", async () => {
  const fixture = readFileSync(new URL("./fixtures/opencode-events.jsonl", import.meta.url), "utf8").trim().split("\n")
  const events: Array<{ threadId: string; e: any }> = []
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    for (const line of fixture) res.write(`data: ${line}\n\n`)
    res.end()
  })
  try {
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "ses_1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(server.url, "pw", ac.signal)
    await waitFor(() => events.length >= 2)
    ac.abort()
    await done
    expect(events).toEqual([
      { threadId: "t1", e: { kind: "text", sessionId: "ses_1", messageId: "msg_1", partId: "prt_1", text: "hi" } },
      { threadId: "t1", e: { kind: "idle", sessionId: "ses_1" } },
    ])
  } finally {
    await server.close()
  }
})

test("normalizes v2 permission asks from both event spellings", () => {
  expect(normalizeEvent({ type: "permission.asked", properties: { id: "req1", sessionID: "s1", permission: "bash", patterns: ["npm test"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "req1", source: "v2", tool: "bash", patterns: ["npm test"] })
  expect(normalizeEvent({ type: "permission.v2.asked", properties: { id: "req2", sessionID: "s1", action: "edit", resources: ["src/a.ts"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "req2", source: "v2", tool: "edit", patterns: ["src/a.ts"] })
})

test("normalizes question.asked and question.v2.asked into question info", () => {
  const questions = [{ question: "Which database?", header: "Database", options: [{ label: "sqlite", description: "single file" }], custom: true }]
  expect(normalizeEvent({ type: "question.asked", properties: { id: "q1", sessionID: "s1", questions } })).toEqual({
    kind: "question", sessionId: "s1", requestId: "q1", source: "v1",
    questions: [{ question: "Which database?", header: "Database", options: [{ label: "sqlite", description: "single file" }], custom: true }],
  })
  expect(normalizeEvent({ type: "question.v2.asked", properties: { id: "q2", sessionID: "s1", questions } }))
    .toMatchObject({ kind: "question", sessionId: "s1", requestId: "q2", source: "v2" })
})

test("drops malformed questions and options and keeps flags", () => {
  const e = normalizeEvent({ type: "question.asked", properties: { id: "q1", sessionID: "s1", questions: [
    null,
    { header: "no question" },
    { question: "ok", options: [{ label: 7 }, { description: "no label" }, { label: "yes" }], multiple: true, custom: false },
  ] } })
  const expected: QuestionInfo = { question: "ok", header: "", options: [{ label: "yes", description: "" }], multiple: true, custom: false }
  expect(e).toEqual({ kind: "question", sessionId: "s1", requestId: "q1", source: "v1", questions: [expected] })
})

test("normalizes question.replied and question.rejected from both protocol versions", () => {
  expect(normalizeEvent({ type: "question.replied", properties: { sessionID: "s1", requestID: "q1" } }))
    .toEqual({ kind: "question-replied", sessionId: "s1", requestId: "q1" })
  expect(normalizeEvent({ type: "question.v2.replied", properties: { sessionID: "s1", requestID: "q2" } }))
    .toEqual({ kind: "question-replied", sessionId: "s1", requestId: "q2" })
  expect(normalizeEvent({ type: "question.rejected", properties: { sessionID: "s1", requestID: "q3" } }))
    .toEqual({ kind: "question-rejected", sessionId: "s1", requestId: "q3" })
  expect(normalizeEvent({ type: "question.v2.rejected", properties: { sessionID: "s1", requestID: "q4" } }))
    .toEqual({ kind: "question-rejected", sessionId: "s1", requestId: "q4" })
  expect(normalizeEvent({ type: "question.replied", properties: { sessionID: "s1" } })).toBeNull()
})

test("normalizes permission.replied from both protocol versions", () => {
  expect(normalizeEvent({ type: "permission.replied", properties: { sessionID: "s1", requestID: "r2", reply: "once" } }))
    .toEqual({ kind: "permission-replied", sessionId: "s1", requestId: "r2" })
  expect(normalizeEvent({ type: "permission.replied", properties: { sessionID: "s1", permissionID: "p1", response: "reject" } }))
    .toEqual({ kind: "permission-replied", sessionId: "s1", requestId: "p1" })
})

test("normalizes tool titles from running and completed states", () => {
  expect(normalizeEvent({ type: "message.part.updated", properties: { part: { id: "p2", messageID: "m1", sessionID: "s1", type: "tool", tool: "bash", state: { status: "running", title: "npm test" } } } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p2", name: "bash", status: "running", title: "npm test" })
  expect(partToEvent("s1", "m1", { id: "p3", type: "tool", tool: "edit", state: { status: "completed", title: "wrote src/a.ts" } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p3", name: "edit", status: "completed", title: "wrote src/a.ts" })
})

test("omits the tool title when the state has none", () => {
  expect(partToEvent("s1", "m1", { id: "p4", type: "tool", tool: "bash", state: { status: "running" } }))
    .toEqual({ kind: "tool", sessionId: "s1", messageId: "m1", partId: "p4", name: "bash", status: "running" })
})
