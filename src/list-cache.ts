export interface ValueCacheDeps<T> {
  ttlMs: number
  load(): Promise<T[]>
  now(): number
}

export interface ValueCache<T> {
  get(): Promise<T[]>
  refresh(): void
}

export function createValueCache<T>(deps: ValueCacheDeps<T>): ValueCache<T> {
  let values: T[] | null = null
  let loadedAt = 0
  let inflight: Promise<void> | null = null

  const snapshot = (): T[] | null => (values === null ? null : [...values])

  const start = (): Promise<void> => {
    const p = deps.load()
      .then((next) => {
        values = Array.isArray(next) ? next : []
        loadedAt = deps.now()
      })
      .catch(() => {})
      .finally(() => { inflight = null })
    inflight = p
    return p
  }

  const kick = (): void => {
    if (inflight) return
    void start()
  }

  return {
    async get(): Promise<T[]> {
      if (values === null) {
        await (inflight ?? start())
        return snapshot() ?? []
      }
      if (deps.now() - loadedAt >= deps.ttlMs) kick()
      return snapshot() ?? []
    },
    refresh(): void {
      kick()
    },
  }
}
