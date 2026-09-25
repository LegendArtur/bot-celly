import { isDeepStrictEqual } from "node:util"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Project } from "./types.ts"
export type OpencodeClient = ReturnType<typeof createOpencodeClient> & { baseUrl: string; auth: string }

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
}
export function createClient(baseUrl: string, password: string): OpencodeClient {
  const auth = basicAuth(password)
  return Object.assign(createOpencodeClient({ baseUrl, headers: { Authorization: auth }, throwOnError: true }), { baseUrl, auth })
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
  share: "disabled"
  permission: {
    "*": "allow"
    bash: Record<string, "allow" | "deny">
    external_directory: "deny"
    question: "deny"
  }
}

export const ENV_INSPECT_UTILITIES = ["awk", "base64", "cat", "cp", "grep", "head", "less", "od", "sed", "strings", "tail", "xxd"] as const

export const BASH_DENY: Record<string, "allow" | "deny"> = {
  "*": "allow",
  "git push*": "deny",
  "git clean -fdx*": "deny",
  "npm publish*": "deny",
  "pnpm publish*": "deny",
  "yarn publish*": "deny",
  "printenv*": "deny",
  "env": "deny",
  "cat *opencode.env*": "deny",
  "cat */.config/cely/*": "deny",
}
for (const utility of ENV_INSPECT_UTILITIES) {
  BASH_DENY[`${utility} *opencode.env*`] = "deny"
  BASH_DENY[`${utility} */.config/cely/*`] = "deny"
}
BASH_DENY["*opencode.env*"] = "deny"
BASH_DENY["*/.config/cely/*"] = "deny"

/** The same deny patterns that are baked into the sandbox config, normalized. */
export function bashDenyPatterns(): string[] {
  return Object.entries(BASH_DENY).filter(([key, value]) => key !== "*" && value === "deny").map(([key]) => key)
}

export function celyPolicy(): CelyPolicy {
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    permission: {
      "*": "allow",
      bash: { ...BASH_DENY },
      external_directory: "deny",
      question: "deny",
    },
  }
}

export function buildCelyConfigJson(): string {
  return JSON.stringify(celyPolicy(), null, 2) + "\n"
}

export function buildOpencodeEnv(password: string): string {
  // OPENCODE_CONFIG_CONTENT is preferred when the pinned opencode supports it so
  // an untrusted project opencode.json/.opencode cannot loosen the policy. It is
  // single-quoted for safe `set -a; . opencode.env` sourcing; the cely policy
  // contains no single quotes. The API-layer PATCH+assert below is the backstop.
  const content = JSON.stringify(celyPolicy())
  return `OPENCODE_SERVER_PASSWORD=${password}\nOPENCODE_CONFIG=${CELY_CONFIG_PATH}\nOPENCODE_CONFIG_CONTENT='${content}'\n`
}

export interface PolicyClient {
  config: {
    update(options?: unknown): Promise<unknown>
    get(options?: unknown): Promise<unknown>
  }
}
export function unwrapConfigResponse(response: unknown): any {
  return (response as any)?.data ?? response
}

/**
 * Runtime enforcement of the cely policy. The bootstrap config is loaded below
 * a project-level `opencode.json`, so a project can weaken it. After the server
 * is healthy we PATCH the policy and then GET /config to assert the running
 * server actually reports `celyPolicy()`. Any mismatch fails the caller closed.
 */
export async function applyAndAssertCelyPolicy(client: PolicyClient): Promise<void> {
  const policy = celyPolicy()
  await client.config.update({ body: policy } as any)
  const current = unwrapConfigResponse(await client.config.get())
  if (!isDeepStrictEqual(current?.permission, policy.permission)) {
    throw new Error(`cely permission policy was not enforced by the server: got ${JSON.stringify(current?.permission)}`)
  }
  if (current?.share !== "disabled") {
    throw new Error(`cely share policy was not enforced by the server: got ${JSON.stringify(current?.share)}`)
  }
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
