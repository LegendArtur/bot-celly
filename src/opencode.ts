import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Project } from "./types.ts"
export type OpencodeClient = ReturnType<typeof createOpencodeClient>

export function createClient(baseUrl: string, password: string): OpencodeClient {
  const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
  return createOpencodeClient({ baseUrl, headers: { Authorization: auth } })
}
export function resolveClient(p: Project): OpencodeClient {
  return createClient(`http://127.0.0.1:${p.hostPort}`, p.serverPassword)
}
export function buildServeArgs(): string[] {
  const payload = "set -a; . ~/.config/cely/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0"
  return ["bash", "-lc", payload]
}
export async function waitForHealth(client: { baseUrl: string }, timeoutMs: number, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${client.baseUrl}/global/health`)
      if (res.ok) { const body: any = await res.json(); if (body?.healthy) return; last = JSON.stringify(body) }
      else last = `HTTP ${res.status}`
    } catch (e) { last = (e as Error).message }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`opencode health check timed out: ${last}`)
}
