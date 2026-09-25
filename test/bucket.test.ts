import { expect, test } from "vitest"
import { ChannelBuckets, retryAfterMs, TokenBucket } from "../src/bucket.ts"
import { channelIdForBucket } from "../src/helpers.ts"

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

test("pause holds queued sends for the retry_after window", async () => {
  const clock = fakeClock()
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 100, now: clock.now, sleep: clock.sleep })
  await bucket.schedule(async () => {})
  bucket.pause(1000)
  const at: number[] = []
  await bucket.schedule(async () => { at.push(clock.state.now) })
  expect(at).toEqual([1000])
  expect(clock.state.sleeps).toEqual([1000])
})

test("a later, longer pause wins over an earlier shorter one", async () => {
  const clock = fakeClock()
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 100, now: clock.now, sleep: clock.sleep })
  bucket.pause(1000)
  bucket.pause(500)
  const at: number[] = []
  await bucket.schedule(async () => { at.push(clock.state.now) })
  expect(at).toEqual([1000])
})

test("retryAfterMs reads 429 retry_after in ms or seconds and ignores other errors", () => {
  expect(retryAfterMs({ status: 429, retryAfter: 250 }, 1200)).toBe(250)
  expect(retryAfterMs({ status: 429, rawError: { retry_after: 2 } }, 1200)).toBe(2000)
  expect(retryAfterMs({ status: 429 }, 1200)).toBe(1200)
  expect(retryAfterMs(new Error("boom"), 1200)).toBeUndefined()
})

test("two threads in one channel share a single bucket key", () => {
  const buckets = new ChannelBuckets(() => new TokenBucket({ capacity: 1, refillPerSecond: 1, now: () => 0, sleep: async () => {} }))
  const threadA = { threadId: "t1", channelId: "chan" }
  const threadB = { threadId: "t2", channelId: "chan" }
  const threadC = { threadId: "t3", channelId: "other" }
  expect(channelIdForBucket(threadA)).toBe("chan")
  expect(buckets.for(channelIdForBucket(threadA))).toBe(buckets.for(channelIdForBucket(threadB)))
  expect(buckets.for(channelIdForBucket(threadA))).not.toBe(buckets.for(channelIdForBucket(threadC)))
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
