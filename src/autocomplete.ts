export const SUGGESTION_LIMIT = 25

export interface SuggestionCacheDeps {
  ttlMs: number
  load(): Promise<string[]>
  now(): number
}

export interface SuggestionCache {
  suggest(query: string): Promise<string[]>
}

export function createSuggestionCache(deps: SuggestionCacheDeps): SuggestionCache {
  let values: string[] | null = null
  let loadedAt = 0
  let inflight = false
  const refresh = (): void => {
    if (inflight) return
    inflight = true
    void deps.load()
      .then((next) => {
        values = (Array.isArray(next) ? next : [])
          .map((value) => String(value).slice(0, 100))
          .filter((value) => value.length > 0)
        loadedAt = deps.now()
      })
      .catch(() => {})
      .finally(() => { inflight = false })
  }
  return {
    async suggest(query: string): Promise<string[]> {
      if (values === null) { refresh(); return [] }
      if (deps.now() - loadedAt >= deps.ttlMs) refresh()
      const q = query.trim().toLowerCase()
      const matches = q ? values.filter((value) => value.toLowerCase().includes(q)) : values
      const seen = new Set<string>()
      const out: string[] = []
      for (const value of matches) {
        if (seen.has(value)) continue
        seen.add(value)
        out.push(value)
        if (out.length >= SUGGESTION_LIMIT) break
      }
      return out
    },
  }
}
