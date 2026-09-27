import { createOpencodeClient } from "@opencode-ai/sdk"
import { createOpencodeClient as createV2SdkClient } from "@opencode-ai/sdk/v2/client"
import type { Project } from "./types.ts"
export type OpencodeClient = ReturnType<typeof createOpencodeClient> & { baseUrl: string; auth: string }

export function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
}
export function createClient(baseUrl: string, password: string): OpencodeClient {
  const auth = basicAuth(password)
  return Object.assign(createOpencodeClient({ baseUrl, headers: { Authorization: auth }, throwOnError: true }), { baseUrl, auth })
}
export function resolveBaseUrl(p: { hostPort: number }): string {
  return `http://127.0.0.1:${p.hostPort}`
}
export function resolveClient(p: Project): OpencodeClient {
  return createClient(resolveBaseUrl(p), p.serverPassword)
}
export type OpencodeV2Client = ReturnType<typeof createV2SdkClient> & { baseUrl: string; auth: string }
export function createV2Client(baseUrl: string, password: string): OpencodeV2Client {
  const auth = basicAuth(password)
  const client = createV2SdkClient({ baseUrl, headers: { Authorization: auth }, throwOnError: true })
  // The generated client exposes `auth` as a getter (the Auth sub-client) and no
  // `baseUrl`, so Object.assign would throw on the getter. Define own data
  // properties that shadow the prototype getter, matching the v1 client shape.
  Object.defineProperty(client, "baseUrl", { value: baseUrl, enumerable: true })
  Object.defineProperty(client, "auth", { value: auth, enumerable: true })
  return client as OpencodeV2Client
}
export function resolveV2Client(p: Project): OpencodeV2Client {
  return createV2Client(resolveBaseUrl(p), p.serverPassword)
}
export const AUTH_ENV_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
}

export const OPENCODE_AUTH_PATH = "$HOME/.local/share/opencode/auth.json"

export function buildServeArgs(): string[] {
  const unsets = Object.entries(AUTH_ENV_BY_PROVIDER)
    .map(([id, env]) => `grep -q "\\"${id}\\"" "$auth" && unset ${env}`)
    .join("; ")
  const payload = `set -a; . ~/.config/celly/opencode.env; set +a; auth="${OPENCODE_AUTH_PATH}"; if [ -f "$auth" ]; then ${unsets}; fi; exec opencode serve --port 4096 --hostname 0.0.0.0`
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
    question: "allow"
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
      question: "allow",
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
 * server actually enforces it. Any mismatch fails the caller closed.
 */

/** opencode normalizes permission keys (drops spaces and `*`) when reporting config. */
export function normalizePermissionPattern(pattern: string): string {
  return pattern.replace(/\s+/g, "").replace(/\*/g, "")
}

/**
 * The server normalizes the permission map it returns (`"git push*"` becomes
 * `"git push"`, `"*"` becomes `""`), so assert the security-relevant rules
 * semantically: `external_directory` stays denied, the share policy stays
 * disabled, and every bash deny pattern survives as a deny (never weakened to
 * allow). Server-added defaults and extra keys are allowed. `question` is not
 * asserted because the v1 config surface reports it as deny regardless of the
 * PATCH.
 */
export function assertCellyPermissionPolicy(permission: any): void {
  if (permission?.external_directory !== "deny") {
    throw new Error(`celly permission policy was not enforced by the server: external_directory=${JSON.stringify(permission?.external_directory)}`)
  }
  const bash = permission?.bash
  if (!bash || typeof bash !== "object") {
    throw new Error("celly permission policy was not enforced by the server: bash rules missing")
  }
  const rules = new Map<string, string>()
  for (const [key, value] of Object.entries(bash)) rules.set(normalizePermissionPattern(key), String(value))
  for (const pattern of bashDenyPatterns()) {
    const actual = rules.get(normalizePermissionPattern(pattern))
    if (actual !== "deny") {
      throw new Error(`celly permission policy was not enforced by the server: "${pattern}" is ${actual ?? "missing"}`)
    }
  }
}

/**
 * The v1 config surface reports `question` as `deny` no matter what is PATCHed;
 * the v2 global config surface round-trips it. Merge the allow into the current
 * v2 config and PATCH it. Best-effort: any failure returns false so boot does
 * not depend on a surface that may not exist in a future server.
 */
export async function enableQuestionPermissionV2(v2: OpencodeV2Client): Promise<boolean> {
  try {
    const current = unwrapConfigResponse(await v2.global.config.get())
    const merged = { ...current, permission: { ...(current?.permission ?? {}), question: "allow" } }
    await v2.global.config.update({ config: merged } as any)
    return true
  } catch {
    return false
  }
}

export async function applyAndAssertCellyPolicy(client: PolicyClient, v2?: OpencodeV2Client): Promise<void> {
  const policy = cellyPolicy()
  await client.config.update({ body: policy } as any)
  const current = unwrapConfigResponse(await client.config.get())
  assertCellyPermissionPolicy(current?.permission)
  if (current?.share !== "disabled") {
    throw new Error(`celly share policy was not enforced by the server: got ${JSON.stringify(current?.share)}`)
  }
  if (v2) await enableQuestionPermissionV2(v2)
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

/**
 * One hung connection (a stale sandboxd port-forwarder) must not consume the
 * whole health budget, otherwise a single aborted fetch makes a perfectly
 * healthy server look dead. Bound each attempt and retry until the deadline.
 */
export const HEALTH_ATTEMPT_TIMEOUT_MS = 3000

export interface HealthWaitOptions {
  intervalMs?: number
  attemptTimeoutMs?: number
}

export async function waitForHealth(
  client: { baseUrl: string; auth?: string },
  timeoutMs: number,
  options: HealthWaitOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 500
  const attemptTimeoutMs = options.attemptTimeoutMs ?? HEALTH_ATTEMPT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const attempt = Math.max(1, Math.min(remaining, attemptTimeoutMs))
    try {
      const res = await fetch(`${client.baseUrl}/global/health`, {
        headers: client.auth ? { Authorization: client.auth } : undefined,
        signal: AbortSignal.timeout(attempt),
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
