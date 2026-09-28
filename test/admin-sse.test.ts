import { createServer } from "node:http"
import { expect, test } from "vitest"
import { createSseHub, encodeFrame } from "../src/admin/sse.ts"

test("encodeFrame prefixes every line and terminates the event", () => {
  expect(encodeFrame("a\nb")).toBe("data: a\ndata: b\n\n")
  expect(encodeFrame("<x>")).toBe("data: <x>\n\n")
})

test("a client error prunes the client without crashing the hub", async () => {
  const hub = createSseHub({ heartbeatMs: 10_000 })
  const handlers = new Map<string, () => void>()
  const fake = {
    writeHead: () => fake,
    write: () => true,
    end: () => {},
    on: (event: string, cb: () => void) => { handlers.set(event, cb); return fake },
  }
  hub.add(fake as any)
  expect(hub.clientCount()).toBe(1)
  handlers.get("error")?.()
  await new Promise((r) => setImmediate(r))
  expect(hub.clientCount()).toBe(0)
  hub.closeAll()
})

test("the hub streams frames to connected clients and drops closed ones", async () => {
  const hub = createSseHub({ heartbeatMs: 10_000 })
  const server = createServer((req, res) => { hub.add(res) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as any).port
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal })
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  await reader.read()
  expect(hub.clientCount()).toBe(1)
  hub.broadcast(`<hx-partial hx-target="#projects">hi</hx-partial>`)
  let text = ""
  while (!text.includes("#projects")) {
    const chunk = await reader.read()
    text += decoder.decode(chunk.value, { stream: true })
  }
  expect(text).toContain(`hx-target="#projects"`)
  controller.abort()
  await new Promise((r) => setTimeout(r, 20))
  expect(hub.clientCount()).toBe(0)
  hub.closeAll()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
