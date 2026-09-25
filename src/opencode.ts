import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Project } from "./types.ts"
export type OpencodeClient = ReturnType<typeof createOpencodeClient> & { baseUrl: string; auth: string }

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
}
export function createClient(baseUrl: string, password: string): OpencodeClient {
  const auth = basicAuth(password)
  return Object.assign(createOpencodeClient({ baseUrl, headers: { Authorization: auth } }), { baseUrl, auth })
}
export function resolveClient(p: Project): OpencodeClient {
  return createClient(`http://127.0.0.1:${p.hostPort}`, p.serverPassword)
}
export function buildServeArgs(): string[] {
  const payload = "set -a; . ~/.config/cely/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0"
  return ["bash", "-lc", payload]
}
export async function waitForHealth(client: { baseUrl: string; auth?: string }, timeoutMs: number, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    try {
      const res = await fetch(`${client.baseUrl}/global/health`, {
        headers: client.auth ? { Authorization: client.auth } : undefined,
        signal: AbortSignal.timeout(remaining),
      })
      if (res.ok) { const body: any = await res.json(); if (body?.healthy) return; last = JSON.stringify(body) }
      else last = `HTTP ${res.status}`
    } catch (e) { last = (e as Error).message }
    const rest = deadline - Date.now()
    if (rest <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, rest)))
  }
  throw new Error(`opencode health check timed out: ${last}`)
}
