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
  const payload = "set -a; . ~/.config/celly/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0"
  return ["bash", "-lc", payload]
}

export const CELLY_CONFIG_DIR = "$HOME/.config/celly"
export const CELLY_CONFIG_PATH = "$HOME/.config/celly/opencode.json"
export const CELLY_ENV_PATH = "$HOME/.config/celly/opencode.env"

export interface CellyPolicy {
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
  "cat */.config/celly/*": "deny",
}
for (const utility of ENV_INSPECT_UTILITIES) {
  BASH_DENY[`${utility} *opencode.env*`] = "deny"
  BASH_DENY[`${utility} */.config/celly/*`] = "deny"
}
BASH_DENY["*opencode.env*"] = "deny"
BASH_DENY["*/.config/celly/*"] = "deny"

/** The same deny patterns that are baked into the sandbox config, normalized. */
export function bashDenyPatterns(): string[] {
  return Object.entries(BASH_DENY).filter(([key, value]) => key !== "*" && value === "deny").map(([key]) => key)
}

export function cellyPolicy(): CellyPolicy {
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

export function buildCellyConfigJson(): string {
  return JSON.stringify(cellyPolicy(), null, 2) + "\n"
}

export function buildOpencodeEnv(password: string): string {
  // OPENCODE_CONFIG_CONTENT is preferred when the pinned opencode supports it so
  // an untrusted project opencode.json/.opencode cannot loosen the policy. It is
  // single-quoted for safe `set -a; . opencode.env` sourcing; the celly policy
  // contains no single quotes. The API-layer PATCH+assert below is the backstop.
  const content = JSON.stringify(cellyPolicy())
  return `OPENCODE_SERVER_PASSWORD=${password}\nOPENCODE_CONFIG=${CELLY_CONFIG_PATH}\nOPENCODE_CONFIG_CONTENT='${content}'\n`
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
 * Runtime enforcement of the celly policy. The bootstrap config is loaded below
 * a project-level `opencode.json`, so a project can weaken it. After the server
 * is healthy we PATCH the policy and then GET /config to assert the running
 * server actually reports `cellyPolicy()`. Any mismatch fails the caller closed.
 */
export async function applyAndAssertCellyPolicy(client: PolicyClient): Promise<void> {
  const policy = cellyPolicy()
  await client.config.update({ body: policy } as any)
  const current = unwrapConfigResponse(await client.config.get())
  if (!isDeepStrictEqual(current?.permission, policy.permission)) {
    throw new Error(`celly permission policy was not enforced by the server: got ${JSON.stringify(current?.permission)}`)
  }
  if (current?.share !== "disabled") {
    throw new Error(`celly share policy was not enforced by the server: got ${JSON.stringify(current?.share)}`)
  }
}

export const BOOTSTRAP_PREPARE = `set -e; mkdir -p ${CELLY_CONFIG_DIR}; chmod 700 ${CELLY_CONFIG_DIR}`
export const BOOTSTRAP_VERIFY = `test -s ${CELLY_CONFIG_PATH} && test -s ${CELLY_ENV_PATH} && grep -q '"permission"' ${CELLY_CONFIG_PATH} && grep -q 'OPENCODE_SERVER_PASSWORD=' ${CELLY_ENV_PATH}`

/**
 * The config/env files are written by the sandbox user itself (via `sbx exec -i
 * bash -s`, content on stdin). `sbx cp` creates root-owned 0755 files and the
 * agent cannot chmod them, and staging in the sandbox /tmp then moving is
 * denied (EPERM). `umask 077` makes both files 0600, and the password never
 * touches a host command line.
 */
export function buildBootstrapInstallScript(password: string): string {
  return [
    "set -e",
    "umask 077",
    `cat > "$HOME/.config/celly/opencode.json" <<'CELLY_CONFIG'`,
    buildCellyConfigJson().replace(/\n$/, ""),
    "CELLY_CONFIG",
    `cat > "$HOME/.config/celly/opencode.env" <<'CELLY_ENV'`,
    buildOpencodeEnv(password).replace(/\n$/, ""),
    "CELLY_ENV",
  ].join("\n") + "\n"
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
