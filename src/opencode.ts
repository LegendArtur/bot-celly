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

export const CELY_CONFIG_DIR = "$HOME/.config/cely"
export const CELY_CONFIG_PATH = "$HOME/.config/cely/opencode.json"
export const CELY_ENV_PATH = "$HOME/.config/cely/opencode.env"

export interface CelyPolicy {
  $schema: string
  permission: {
    "*": "allow"
    bash: Record<string, "allow" | "deny">
    external_directory: "deny"
    question: "deny"
  }
}

export function celyPolicy(): CelyPolicy {
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      "*": "allow",
      bash: {
        "*": "allow",
        "git push*": "deny",
        "git clean -fdx*": "deny",
        "npm publish*": "deny",
        "pnpm publish*": "deny",
        "yarn publish*": "deny",
      },
      external_directory: "deny",
      question: "deny",
    },
  }
}

export function buildCelyConfigJson(): string {
  return JSON.stringify(celyPolicy(), null, 2) + "\n"
}

export function buildOpencodeEnv(password: string): string {
  return `OPENCODE_SERVER_PASSWORD=${password}\nOPENCODE_CONFIG=${CELY_CONFIG_PATH}\n`
}

export const BOOTSTRAP_SCRIPT = `set -e; mkdir -p ${CELY_CONFIG_DIR}; mv /tmp/cely-opencode.json ${CELY_CONFIG_PATH}; mv /tmp/cely-opencode.env ${CELY_ENV_PATH}; chmod 600 ${CELY_ENV_PATH}`
export const BOOTSTRAP_VERIFY = `test -s ${CELY_CONFIG_PATH} && test -s ${CELY_ENV_PATH} && grep -q '"permission"' ${CELY_CONFIG_PATH} && grep -q 'OPENCODE_SERVER_PASSWORD=' ${CELY_ENV_PATH}`

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
