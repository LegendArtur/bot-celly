// test/events.test.ts
import { createServer } from "node:http"
import { expect, test, vi } from "vitest"
import { EventRouter, INITIAL_BACKOFF, MAX_BACKOFF, nextBackoff, normalizeEvent } from "../src/events.ts"

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
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "perm1", tool: "bash", patterns: ["git push *"] })
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
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "perm1", tool: "bash", patterns: ["git push *"] })
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

test("routes SSE frames by session and resyncs known sessions on reconnect", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const resyncs: Array<{ threadId: string; sessionId: string }> = []
  let connections = 0
  const server = createServer((_req, res) => {
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
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async (threadId, sessionId) => { resyncs.push({ threadId, sessionId }) },
      knownSessions: () => [{ threadId: "t1", sessionId: "s1" }],
    })
    const ac = new AbortController()
    const done = router.subscribe(`http://127.0.0.1:${port}`, "pw", ac.signal)
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
    server.close()
    server.closeAllConnections()
  }
})

test("isolates a throwing onResync and keeps the stream alive", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const events: Array<{ threadId: string; e: any }> = []
  let connections = 0
  let resyncAttempts = 0
  const server = createServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) res.end()
    else res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\n\n`)
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => { resyncAttempts++; throw new Error("resync boom") },
      knownSessions: () => [{ threadId: "t1", sessionId: "s1" }],
    })
    const ac = new AbortController()
    const done = router.subscribe(`http://127.0.0.1:${port}`, "pw", ac.signal)
    await waitFor(() => resyncAttempts >= 1 && events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
    expect(resyncAttempts).toBe(1)
    expect(connections).toBe(2)
  } finally {
    server.close()
    server.closeAllConnections()
    warn.mockRestore()
  }
})

test("parses CRLF-terminated frames", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "s1" } } })}\r\n\r\n`)
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(`http://127.0.0.1:${port}`, "pw", ac.signal)
    await waitFor(() => events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test("joins multi-line data with a newline", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    res.write('data: {"payload":{"type":"session.idle",\ndata: "properties":{"sessionID":"s1"}}}\n\n')
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const router = new EventRouter({
      route: (sessionId) => (sessionId === "s1" ? "t1" : undefined),
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
    })
    const ac = new AbortController()
    const done = router.subscribe(`http://127.0.0.1:${port}`, "pw", ac.signal)
    await waitFor(() => events.length >= 1)
    ac.abort()
    await done
    expect(events).toEqual([{ threadId: "t1", e: { kind: "idle", sessionId: "s1" } }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
