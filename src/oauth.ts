import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk"

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

export function selectOAuthMethod(methods: ProviderAuthMethod[] | undefined): number {
  return (methods ?? []).findIndex((m) => m?.type === "oauth")
}

export async function startProviderLogin(deps: OAuthDeps, providerId: string): Promise<ProviderLogin> {
  const methods = unwrap(await deps.client.provider.auth()) as Record<string, ProviderAuthMethod[]> | undefined
  const method = selectOAuthMethod(methods?.[providerId])
  if (method < 0) throw new Error(`no oauth method for ${providerId}`)
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
