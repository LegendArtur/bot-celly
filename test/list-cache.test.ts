import { expect, test, vi } from "vitest"
import { createValueCache } from "../src/list-cache.ts"

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test("cold get awaits the load and returns its values", async () => {
  const load = vi.fn(async () => ["a", "b"])
  const cache = createValueCache<string>({ ttlMs: 1000, load, now: () => 0 })
  await expect(cache.get()).resolves.toEqual(["a", "b"])
  expect(load).toHaveBeenCalledTimes(1)
})

test("fresh get returns the cached copy without reloading", async () => {
  let t = 0
  const load = vi.fn(async () => ["a", "b"])
  const cache = createValueCache<string>({ ttlMs: 1000, load, now: () => t })
  await cache.get()
  t = 999
  await expect(cache.get()).resolves.toEqual(["a", "b"])
  expect(load).toHaveBeenCalledTimes(1)
})

test("get returns a defensive copy callers cannot mutate", async () => {
  const cache = createValueCache<string>({ ttlMs: 1000, load: async () => ["a", "b"], now: () => 0 })
  const first = await cache.get()
  first.push("c")
  expect(await cache.get()).toEqual(["a", "b"])
})

test("stale get returns the previous value and refreshes in the background", async () => {
  let t = 0
  const loads = [["old"], ["new"]]
  let calls = 0
  const load = vi.fn(async () => loads[Math.min(calls++, loads.length - 1)]!)
  const cache = createValueCache<string>({ ttlMs: 100, load, now: () => t })
  await cache.get()
  t = 100
  await expect(cache.get()).resolves.toEqual(["old"])
  expect(load).toHaveBeenCalledTimes(2)
  await flush()
  await expect(cache.get()).resolves.toEqual(["new"])
})

test("a failing load yields [] and retries on the next get", async () => {
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce(["a"])
  const cache = createValueCache<string>({ ttlMs: 1000, load, now: () => 0 })
  await expect(cache.get()).resolves.toEqual([])
  await expect(cache.get()).resolves.toEqual(["a"])
  expect(load).toHaveBeenCalledTimes(2)
})

test("concurrent cold gets share one load", async () => {
  let release!: (value: string[]) => void
  const load = vi.fn(() => new Promise<string[]>((resolve) => { release = resolve }))
  const cache = createValueCache<string>({ ttlMs: 1000, load, now: () => 0 })
  const first = cache.get()
  const second = cache.get()
  release(["a"])
  await expect(first).resolves.toEqual(["a"])
  await expect(second).resolves.toEqual(["a"])
  expect(load).toHaveBeenCalledTimes(1)
})

test("refresh starts one background load and swallows errors", async () => {
  let calls = 0
  const load = vi.fn(async () => {
    calls++
    if (calls === 1) throw new Error("boom")
    return ["a"]
  })
  const cache = createValueCache<string>({ ttlMs: 1000, load, now: () => 0 })
  expect(() => cache.refresh()).not.toThrow()
  cache.refresh()
  expect(load).toHaveBeenCalledTimes(1)
  await flush()
  expect(await cache.get()).toEqual(["a"])
})
