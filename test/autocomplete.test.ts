// test/autocomplete.test.ts
import { expect, test, vi } from "vitest"
import { createSuggestionCache } from "../src/autocomplete.ts"

test("cold cache returns [] while a background load runs", async () => {
  let resolveLoad!: (value: string[]) => void
  const load = vi.fn(() => new Promise<string[]>((resolve) => { resolveLoad = resolve }))
  const cache = createSuggestionCache({ ttlMs: 1000, load, now: () => 0 })
  await expect(cache.suggest("a")).resolves.toEqual([])
  await expect(cache.suggest("b")).resolves.toEqual([])
  expect(load).toHaveBeenCalledTimes(1)
  resolveLoad(["alpha", "beta"])
  await new Promise((resolve) => setTimeout(resolve, 0))
  await expect(cache.suggest("al")).resolves.toEqual(["alpha"])
})

test("filters case-insensitively, dedupes, and caps at 25", async () => {
  const values = Array.from({ length: 40 }, (_, i) => `model-${i}`)
  const cache = createSuggestionCache({ ttlMs: 1000, load: async () => values, now: () => 0 })
  await cache.suggest("")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await cache.suggest("model")).toHaveLength(25)
  expect(await cache.suggest("MODEL-3")).toEqual([
    "model-3", "model-30", "model-31", "model-32", "model-33", "model-34",
    "model-35", "model-36", "model-37", "model-38", "model-39",
  ])

  const dupes = createSuggestionCache({ ttlMs: 1000, load: async () => ["a", "a", "b"], now: () => 0 })
  await dupes.suggest("")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await dupes.suggest("")).toEqual(["a", "b"])
})

test("serves stale values while revalidating after the ttl", async () => {
  let t = 0
  let calls = 0
  const loads = [["old"], ["new"]]
  const load = vi.fn(async () => loads[Math.min(calls++, loads.length - 1)]!)
  const cache = createSuggestionCache({ ttlMs: 100, load, now: () => t })
  await cache.suggest("")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await cache.suggest("")).toEqual(["old"])
  t = 200
  expect(await cache.suggest("")).toEqual(["old"])
  expect(load).toHaveBeenCalledTimes(2)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await cache.suggest("")).toEqual(["new"])
})

test("a failed load leaves the cache cold and retries on the next suggest", async () => {
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce(["alpha"])
  const cache = createSuggestionCache({ ttlMs: 1000, load, now: () => 0 })
  await expect(cache.suggest("")).resolves.toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 0))
  await expect(cache.suggest("a")).resolves.toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(load).toHaveBeenCalledTimes(2)
  await expect(cache.suggest("a")).resolves.toEqual(["alpha"])
})
