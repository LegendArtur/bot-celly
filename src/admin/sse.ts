import type { ServerResponse } from "node:http"

export function encodeFrame(html: string): string {
  return `${html.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`
}

export interface SseHub {
  add(res: ServerResponse): void
  broadcast(html: string): void
  clientCount(): number
  closeAll(): void
}

export function createSseHub(opts: { heartbeatMs?: number } = {}): SseHub {
  const clients = new Set<ServerResponse>()
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(": ping\n\n") } catch { clients.delete(res) }
    }
  }, opts.heartbeatMs ?? 15_000)
  if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref()
  return {
    add(res) {
      res.on("error", () => clients.delete(res))
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      })
      res.write(": connected\n\n")
      clients.add(res)
      res.on("close", () => clients.delete(res))
    },
    broadcast(html) {
      const frame = encodeFrame(html)
      for (const res of clients) {
        try { res.write(frame) } catch { clients.delete(res) }
      }
    },
    clientCount() { return clients.size },
    closeAll() {
      clearInterval(heartbeat)
      for (const res of clients) { try { res.end() } catch {} }
      clients.clear()
    },
  }
}
