import type { Project } from "./types.ts"
import type { OpencodeClient } from "./opencode.ts"
import { createValueCache } from "./list-cache.js"
import type { ValueCache } from "./list-cache.js"

export interface ListDeps {
  projectFor(channelId: string): Project | undefined
  ensureReady(channelId: string): Promise<unknown>
  clientFor(project: Project): OpencodeClient
  modelVariants(model: unknown): string[] | undefined
  log: { warn(message: string, fields?: Record<string, unknown>): void }
}

export interface ProjectLists {
  listSessions(channelId: string): Promise<{ id: string; title: string }[]>
  listModels(channelId: string): Promise<{ id: string; name: string }[]>
  listAgents(channelId: string): Promise<{ id: string; name: string }[]>
  warmLists(channelId: string): void
}

export function createProjectLists(deps: ListDeps): ProjectLists {
  const listSessions = async (channelId: string): Promise<{ id: string; title: string }[]> => {
    const project = deps.projectFor(channelId)
    if (!project) return []
    await deps.ensureReady(channelId).catch(() => {})
    try {
      const sdk = deps.clientFor(project)
      const res: any = await sdk.session.list()
      const data = res?.data ?? res
      const list = Array.isArray(data) ? data : []
      return list.map((s: any) => ({ id: String(s.id), title: String(s.title ?? s.id) }))
    } catch (err) {
      deps.log.warn("list sessions failed", { channelId, error: String(err) })
      return []
    }
  }

  const listCaches = new Map<string, ValueCache<any>>()
  const listCacheFor = <T>(key: string, load: () => Promise<T[]>): ValueCache<T> => {
    const existing = listCaches.get(key)
    if (existing) return existing
    const cache = createValueCache<T>({ ttlMs: 60_000, load, now: () => Date.now() })
    listCaches.set(key, cache)
    return cache
  }

  const loadModels = async (channelId: string): Promise<{ id: string; name: string; variants?: string[] }[]> => {
    const project = deps.projectFor(channelId)
    if (!project) return []
    try {
      const sdk = deps.clientFor(project)
      const res: any = await sdk.config.providers()
      const data = res?.data ?? res
      const providers = Array.isArray(data?.providers) ? data.providers : []
      const out: { id: string; name: string; variants?: string[] }[] = []
      for (const p of providers) {
        const providerId = typeof p?.id === "string" && p.id ? p.id : undefined
        if (!providerId) continue
        const models = p?.models && typeof p.models === "object" ? p.models : {}
        for (const [mid, model] of Object.entries(models)) {
          const id = `${providerId}/${mid}`
          const name = (model as any)?.name
          out.push({ id, name: typeof name === "string" && name ? name : `${p?.name ?? providerId}/${mid}`, variants: deps.modelVariants(model) })
        }
      }
      return out
    } catch (err) {
      deps.log.warn("list models failed", { channelId, error: String(err) })
      return []
    }
  }

  const loadAgents = async (channelId: string): Promise<{ id: string; name: string }[]> => {
    const project = deps.projectFor(channelId)
    if (!project) return []
    try {
      const sdk = deps.clientFor(project)
      const res: any = await sdk.app.agents()
      const data = res?.data ?? res
      const list = Array.isArray(data) ? data : []
      return list.filter((a: any) => a?.mode !== "subagent").map((a: any) => ({ id: String(a.name), name: a.description ? `${a.name} — ${a.description}` : String(a.name) }))
    } catch (err) {
      deps.log.warn("list agents failed", { channelId, error: String(err) })
      return []
    }
  }

  return {
    listSessions,
    listModels: (channelId) => listCacheFor(`models:${channelId}`, () => loadModels(channelId)).get(),
    listAgents: (channelId) => listCacheFor(`agents:${channelId}`, () => loadAgents(channelId)).get(),
    warmLists: (channelId) => {
      listCacheFor(`models:${channelId}`, () => loadModels(channelId)).refresh()
      listCacheFor(`agents:${channelId}`, () => loadAgents(channelId)).refresh()
    },
  }
}
