import { expect, test } from "vitest"
import {
  composeThreadName, isManualRename, normalizeTitle, parseNameMarker, statusPrefix, stripNameMarker,
} from "../src/thread-name.ts"

test("statusPrefix maps every status to an emoji + label", () => {
  expect(statusPrefix("working")).toBe("🟢 working")
  expect(statusPrefix("blocked")).toBe("⛔ blocked")
  expect(statusPrefix("idle")).toBe("⏸️ idle")
  expect(statusPrefix("error")).toBe("❌ error")
  expect(statusPrefix("stopping")).toBe("⏹️ stopping")
})

test("composeThreadName joins prefix and title, and tolerates a missing title", () => {
  expect(composeThreadName("working", "Fix auth redirect loop")).toBe("🟢 working · Fix auth redirect loop")
  expect(composeThreadName("idle", null)).toBe("⏸️ idle")
  expect(composeThreadName("idle", "   ")).toBe("⏸️ idle")
})

test("composeThreadName never exceeds Discord's 100 character limit", () => {
  const name = composeThreadName("working", "x".repeat(200))
  expect(name.length).toBeLessThanOrEqual(100)
})

test("normalizeTitle strips wrapping quotes/markdown, trailing punctuation, caps words", () => {
  expect(normalizeTitle('  "Fix the auth redirect loop"  ')).toBe("Fix the auth redirect loop")
  expect(normalizeTitle("`Ship smart thread names`")).toBe("Ship smart thread names")
  expect(normalizeTitle("Fix login.")).toBe("Fix login")
  expect(normalizeTitle("one two three four five six seven eight nine ten eleven"))
    .toBe("one two three four five six seven eight nine ten")
  expect(normalizeTitle("")).toBeNull()
  expect(normalizeTitle("   ")).toBeNull()
})

test("parseNameMarker extracts the first marker line only when complete", () => {
  expect(parseNameMarker("hello\n:::celly-name Fix auth redirect loop\nmore")).toBe("Fix auth redirect loop")
  expect(parseNameMarker(":::celly-name Fix auth redirect loop")).toBe("Fix auth redirect loop")
  expect(parseNameMarker("no marker here")).toBeNull()
})

test("stripNameMarker removes marker lines including a trailing partial one", () => {
  expect(stripNameMarker("hello\n:::celly-name Fix auth\nworld")).toBe("hello\nworld")
  expect(stripNameMarker("hello\n:::celly-name Fix auth")).toBe("hello\n")
})

test("isManualRename ignores our own writes, archived threads, and unknown threads", () => {
  const base = { oldName: "a", newName: "b", archived: false, known: true, manual: false, lastThreadName: "a" }
  expect(isManualRename(base)).toBe(true)
  expect(isManualRename({ ...base, newName: "a" })).toBe(false)
  expect(isManualRename({ ...base, newName: "b", lastThreadName: "b" })).toBe(false)
  expect(isManualRename({ ...base, archived: true })).toBe(false)
  expect(isManualRename({ ...base, known: false })).toBe(false)
  expect(isManualRename({ ...base, manual: true })).toBe(false)
})

import { vi } from "vitest"
import { ThreadNamer } from "../src/thread-name.ts"

function namerDeps(overrides: Partial<ConstructorParameters<typeof ThreadNamer>[0]> = {}) {
  const titles: Record<string, string | null> = {}
  const locked = new Set<string>()
  const renames: { threadId: string; name: string }[] = []
  return {
    renames, titles, locked,
    deps: {
      enabled: () => true,
      rename: async (threadId: string, name: string) => { renames.push({ threadId, name }) },
      getTitle: (threadId: string) => titles[threadId] ?? "seed",
      isLocked: (threadId: string) => locked.has(threadId),
      setLockedTitle: (threadId: string, title: string) => { titles[threadId] = title; locked.add(threadId) },
      now: () => Date.now(),
      log: () => {},
      settleMs: 20,
      bucketCapacity: 2,
      refillMs: 300,
      ...overrides,
    },
  }
}

test("namer coalesces bursts and applies the last state after settle", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "working")
    namer.setStatus("t1", "blocked")
    namer.setStatus("t1", "idle")
    await vi.advanceTimersByTimeAsync(25)
    expect(renames).toEqual([{ threadId: "t1", name: "⏸️ idle · seed" }])
  } finally { vi.useRealTimers() }
})

test("namer locks the title on the first marker and ignores later ones", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames, titles } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.noteFinalText("t1", "intro\n:::celly-name Fix auth redirect loop\n")
    namer.noteFinalText("t1", "again\n:::celly-name Something else entirely\n")
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(25)
    expect(titles.t1).toBe("Fix auth redirect loop")
    expect(renames.at(-1)).toEqual({ threadId: "t1", name: "🟢 working · Fix auth redirect loop" })
  } finally { vi.useRealTimers() }
})

test("namer throttles to the token bucket and eventually applies", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames } = namerDeps({ settleMs: 5, refillMs: 100 })
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(10)   // token 1
    namer.setStatus("t1", "blocked")
    await vi.advanceTimersByTimeAsync(10)   // token 2
    namer.setStatus("t1", "idle")
    await vi.advanceTimersByTimeAsync(10)   // no token yet
    expect(renames).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(150)  // refill
    expect(renames).toHaveLength(3)
  } finally { vi.useRealTimers() }
})

test("namer keeps the desired state when a rename fails, and retries", async () => {
  vi.useFakeTimers()
  try {
    let fail = true
    const calls = { n: 0 }
    const { deps } = namerDeps({
      settleMs: 5, refillMs: 50,
      rename: async () => { calls.n++; if (fail) throw new Error("boom") },
    })
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(10)
    expect(calls.n).toBe(1)
    fail = false
    await vi.advanceTimersByTimeAsync(100)
    expect(calls.n).toBeGreaterThan(1)
  } finally { vi.useRealTimers() }
})

test("namer stops after a manual rename and when disabled", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.onManualRename("t1")
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(25)
    expect(renames).toHaveLength(0)

    const off = namerDeps({ enabled: () => false })
    const namer2 = new ThreadNamer(off.deps)
    namer2.setStatus("t2", "working")
    await vi.advanceTimersByTimeAsync(25)
    expect(off.renames).toHaveLength(0)
  } finally { vi.useRealTimers() }
})

test("namer does not rename again when the composed name is unchanged", async () => {
  vi.useFakeTimers()
  try {
    const { deps, renames } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "idle")
    await vi.advanceTimersByTimeAsync(25)
    namer.setStatus("t1", "idle")
    await vi.advanceTimersByTimeAsync(25)
    expect(renames).toHaveLength(1)
  } finally { vi.useRealTimers() }
})

test("namer serializes flushes so a setStatus during a rename cannot double-rename", async () => {
  vi.useFakeTimers()
  try {
    let resolveRename: (() => void) | null = null
    const calls: string[] = []
    const { deps } = namerDeps({
      settleMs: 5,
      rename: (_threadId: string, name: string) => {
        calls.push(name)
        return new Promise<void>((resolve) => { resolveRename = resolve })
      },
    })
    const namer = new ThreadNamer(deps)
    namer.setStatus("t1", "working")
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(1)
    namer.setStatus("t1", "blocked")
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(1)
    resolveRename?.()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(2)
    expect(calls.at(-1)).toBe("⛔ blocked · seed")
  } finally { vi.useRealTimers() }
})

test("namer ignores markers after a manual rename", async () => {
  vi.useFakeTimers()
  try {
    const { deps, titles, locked, renames } = namerDeps()
    const namer = new ThreadNamer(deps)
    namer.onManualRename("t1")
    namer.noteFinalText("t1", "intro\n:::celly-name Fix auth redirect loop\n")
    await vi.advanceTimersByTimeAsync(25)
    expect(titles.t1).toBeUndefined()
    expect(locked.has("t1")).toBe(false)
    expect(renames).toHaveLength(0)
  } finally { vi.useRealTimers() }
})
