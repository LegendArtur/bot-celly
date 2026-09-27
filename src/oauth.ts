import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk"
import { setTimeout as delay } from "node:timers/promises"

export interface OAuthClient {
  provider: {
    auth(options?: unknown): Promise<unknown>
    oauth: {
      authorize(options: { path: { id: string }; body: { method: number } }): Promise<unknown>
      callback(options: { path: { id: string }; body: { method: number; code?: string } }): Promise<unknown>
    }
  }
}

export interface OAuthDeps {
  client: OAuthClient
  log(msg: string, fields?: Record<string, unknown>): void
}

export interface ProviderLogin {
  providerId: string
  method: number
  url: string
  flow: "auto" | "code"
  instructions: string
}

function unwrap(response: unknown): any {
  return (response as any)?.data ?? response
}

/** The v1 SDK type omits `prompts`, but the live 1.18.32 server returns it. */
type AuthMethod = ProviderAuthMethod & { prompts?: unknown[] }

/**
 * Prefer a code/device-style OAuth method over the browser one. The browser
 * flow opens a localhost callback inside the sandbox that a Discord user's
 * browser cannot reach; the headless/device methods return a code the user
 * pastes back through `/login-code`.
 */
export function selectOAuthMethod(methods: ProviderAuthMethod[] | undefined): number {
  const list = methods ?? []
  const preferred = list.findIndex((m) => m?.type === "oauth" && /headless|device|code|manual|token/i.test(m.label ?? ""))
  if (preferred >= 0) return preferred
  return list.findIndex((m) => m?.type === "oauth")
}

/** Provider ids that expose at least one `oauth` method, sorted. */
export function listOAuthProviders(methods: Record<string, ProviderAuthMethod[]> | undefined): string[] {
  return Object.entries(methods ?? {})
    .filter(([, list]) => (list ?? []).some((m) => m?.type === "oauth"))
    .map(([id]) => id)
    .sort()
}

export async function startProviderLogin(deps: OAuthDeps, providerId: string): Promise<ProviderLogin> {
  const methods = unwrap(await deps.client.provider.auth()) as Record<string, ProviderAuthMethod[]> | undefined
  const method = selectOAuthMethod(methods?.[providerId])
  if (method < 0) {
    const available = listOAuthProviders(methods)
    const suffix = available.length ? `; oauth providers: ${available.slice(0, 8).join(", ")}` : "; no providers expose OAuth"
    throw new Error(`no oauth method for ${providerId}${suffix}`)
  }
  const selected = (methods?.[providerId]?.[method]) as AuthMethod | undefined
  if (Array.isArray(selected?.prompts) && selected.prompts.length > 0) {
    throw new Error(`provider ${providerId} OAuth needs extra setup steps; use /attach and run \`opencode auth login\``)
  }
  const authorization = unwrap(await deps.client.provider.oauth.authorize({ path: { id: providerId }, body: { method } })) as ProviderAuthAuthorization
  if (!authorization?.url) throw new Error(`provider ${providerId} returned no authorization URL`)
  const flow: ProviderLogin["flow"] = authorization.method === "auto" ? "auto" : "code"
  deps.log("provider login started", { providerId, flow })
  return { providerId, method, url: authorization.url, flow, instructions: authorization.instructions ?? "" }
}

export async function finishProviderLogin(deps: OAuthDeps, providerId: string, code: string): Promise<void> {
  const methods = unwrap(await deps.client.provider.auth()) as Record<string, ProviderAuthMethod[]> | undefined
  const method = selectOAuthMethod(methods?.[providerId])
  if (method < 0) throw new Error(`no oauth method for ${providerId}`)
  const ok = unwrap(await deps.client.provider.oauth.callback({ path: { id: providerId }, body: { method, code } }))
  if (ok !== true) throw new Error(`oauth callback for ${providerId} failed`)
  deps.log("provider login completed", { providerId })
}

export function isSafeProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)
}

export async function waitForSandboxAuth(
  exec: (script: string) => Promise<{ code: number }>,
  providerId: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<boolean> {
  if (!isSafeProviderId(providerId)) return false
  const script = `test -f ~/.local/share/opencode/auth.json && grep -q "\\"${providerId}\\"" ~/.local/share/opencode/auth.json`
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const { code } = await exec(script)
    if (code === 0) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await delay(Math.min(opts.intervalMs, remaining))
  }
}
