import { expect, test } from "vitest"
import { ChannelBuckets, TokenBucket } from "../src/bucket.ts"

function fakeClock() {
  const state = { now: 0, sleeps: [] as number[] }
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => { state.sleeps.push(ms); state.now += ms },
  }
}

test("a full bucket passes the first capacity sends immediately and delays the rest", async () => {
  const clock = fakeClock()
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: clock.now, sleep: clock.sleep })
  const at: number[] = []
  const run = (i: number) => bucket.schedule(async () => { at.push(clock.state.now); return i })
  const results = await Promise.all([run(1), run(2), run(3)])
  expect(results).toEqual([1, 2, 3])
  expect(at).toEqual([0, 0, 1000])
  expect(clock.state.sleeps).toEqual([1000])
})

test("the refill rate governs the wait for the next token", async () => {
  const clock = fakeClock()
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 2, now: clock.now, sleep: clock.sleep })
  await bucket.schedule(async () => {})
  await bucket.schedule(async () => {})
  expect(clock.state.sleeps).toEqual([500])
})

test("scheduled work runs strictly in submission order", async () => {
  const clock = fakeClock()
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, now: clock.now, sleep: clock.sleep })
  const order: string[] = []
  await Promise.all([
    bucket.schedule(async () => { order.push("a") }),
    bucket.schedule(async () => { order.push("b") }),
    bucket.schedule(async () => { order.push("c") }),
  ])
  expect(order).toEqual(["a", "b", "c"])
})

test("ChannelBuckets shares one bucket per channel", () => {
  const buckets = new ChannelBuckets(() => new TokenBucket({ capacity: 1, refillPerSecond: 1, now: () => 0, sleep: async () => {} }))
  expect(buckets.for("a")).toBe(buckets.for("a"))
  expect(buckets.for("a")).not.toBe(buckets.for("b"))
})

test("ChannelBuckets evicts channels idle beyond the threshold", () => {
  let t = 0
  const buckets = new ChannelBuckets(
    () => new TokenBucket({ capacity: 1, refillPerSecond: 1, now: () => t, sleep: async () => {} }),
    { idleMs: 1000, now: () => t },
  )
  const a = buckets.for("a")
  t = 500
  buckets.for("b")
  expect(buckets.size()).toBe(2)
  t = 1200
  buckets.for("b")
  expect(buckets.size()).toBe(1)
  expect(buckets.for("a")).not.toBe(a)
  expect(buckets.size()).toBe(2)
})
