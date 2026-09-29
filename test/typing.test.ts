import { afterEach, expect, test, vi } from "vitest"
import { createTypingIndicators } from "../src/typing.ts"

afterEach(() => vi.useRealTimers())

test("start sends immediately and every 8s, and is idempotent", async () => {
  vi.useFakeTimers()
  const calls: string[] = []
  const typing = createTypingIndicators({
    bucketFor: () => "bucket",
    sendTyping: async (id, bucket) => { calls.push(`${id}:${bucket}`) },
  })
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(["t1:bucket"])
  await vi.advanceTimersByTimeAsync(8000)
  expect(calls).toEqual(["t1:bucket", "t1:bucket"])
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(8000)
  expect(calls).toHaveLength(3)
  typing.stop("t1")
})

test("stop clears the interval and allows a restart", async () => {
  vi.useFakeTimers()
  let calls = 0
  const typing = createTypingIndicators({ bucketFor: () => "b", sendTyping: async () => { calls++ } })
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(0)
  typing.stop("t1")
  await vi.advanceTimersByTimeAsync(16000)
  expect(calls).toBe(1)
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(2)
  typing.stop("t1")
})

test("send failures are swallowed", async () => {
  vi.useFakeTimers()
  const typing = createTypingIndicators({ bucketFor: () => "b", sendTyping: async () => { throw new Error("boom") } })
  typing.start("t1")
  await vi.advanceTimersByTimeAsync(8001)
  typing.stop("t1")
})
