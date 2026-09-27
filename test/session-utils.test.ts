// test/session-utils.test.ts
import { expect, test } from "vitest"
import { createSessionOps, formatContextUsage, formatDiff, formatTokens } from "../src/session-utils.ts"

function fakeClient(over: any = {}) {
  return {
    session: {
      messages: async () => ({ data: [] }),
      revert: async () => ({}),
      unrevert: async () => ({}),
      ...over.session,
    },
  } as any
}

test("undo reverts to the last user message with the exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({
    session: {
      messages: async (args: any) => { calls.push(["messages", args]); return { data: [
        { info: { id: "m1", role: "user" } },
        { info: { id: "m2", role: "assistant" } },
        { info: { id: "m3", role: "user" } },
      ] } },
      revert: async (args: any) => { calls.push(["revert", args]); return {} },
    },
  })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client, threadModel: () => null, modelLimit: async () => undefined })
  expect(await ops.undo("t1")).toBe("reverted")
  expect(calls).toEqual([
    ["messages", { path: { id: "s1" }, query: { directory: "/w" } }],
    ["revert", { path: { id: "s1" }, query: { directory: "/w" }, body: { messageID: "m3" } }],
  ])
})

test("undo without a directory omits the query and reports nothing to undo", async () => {
  const calls: any[] = []
  const client = fakeClient({
    session: {
      messages: async (args: any) => { calls.push(["messages", args]); return { data: [{ info: { id: "m1", role: "assistant" } }] } },
      revert: async (args: any) => { calls.push(["revert", args]); return {} },
    },
  })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client, threadModel: () => null, modelLimit: async () => undefined })
  expect(await ops.undo("t1")).toBe("nothing")
  expect(calls).toEqual([["messages", { path: { id: "s1" } }]])
})

test("undo rejects an unknown thread", async () => {
  const ops = createSessionOps({ targetFor: () => undefined, clientFor: () => fakeClient(), threadModel: () => null, modelLimit: async () => undefined })
  await expect(ops.undo("t9")).rejects.toThrow("unknown thread t9")
})

test("redo unreverts with the exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { unrevert: async (args: any) => { calls.push(args); return {} } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client, threadModel: () => null, modelLimit: async () => undefined })
  expect(await ops.redo("t1")).toBe("redone")
  expect(calls).toEqual([{ path: { id: "s1" } }])
})

const FIXTURE_DIFF = [
  { file: "src/a.ts", before: "a", after: "b", additions: 2, deletions: 1 },
  { file: "src/new.ts", before: "", after: "b", additions: 5, deletions: 0 },
  { file: "src/gone.ts", before: "a", after: "", additions: 0, deletions: 9 },
]

test("formatDiff renders status, adds, deletes, and totals", () => {
  expect(formatDiff(FIXTURE_DIFF)).toBe([
    "M src/a.ts (+2/-1)",
    "A src/new.ts (+5/-0)",
    "D src/gone.ts (+0/-9)",
    "total: +7/-10 across 3 files",
  ].join("\n"))
})

test("formatDiff caps at 10 files and keeps whole-list totals", () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ file: `src/f${i}.ts`, before: "a", after: "b", additions: 1, deletions: 1 }))
  const lines = formatDiff(files).split("\n")
  expect(lines).toHaveLength(12)
  expect(lines[10]).toBe("… and 2 more")
  expect(lines[11]).toBe("total: +12/-12 across 12 files")
})

test("formatDiff reports no changes for an empty list", () => {
  expect(formatDiff([])).toBe("no changes")
})

test("diff calls the session diff endpoint and returns the files", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { diff: async (args: any) => { calls.push(args); return { data: FIXTURE_DIFF } } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client, threadModel: () => null, modelLimit: async () => undefined })
  expect(await ops.diff("t1")).toEqual(FIXTURE_DIFF)
  expect(calls).toEqual([{ path: { id: "s1" }, query: { directory: "/w" } }])
})

test("share returns the session share url with the exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { share: async (args: any) => { calls.push(args); return { data: { id: "s1", share: { url: "https://opncd.ai/s/abc" } } } } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client, threadModel: () => null, modelLimit: async () => undefined })
  expect(await ops.share("t1")).toBe("https://opncd.ai/s/abc")
  expect(calls).toEqual([{ path: { id: "s1" } }])
})

test("share throws when the session has no url", async () => {
  const client = fakeClient({ session: { share: async () => ({ data: { id: "s1" } }) } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client, threadModel: () => null, modelLimit: async () => undefined })
  await expect(ops.share("t1")).rejects.toThrow("session share returned no url")
})

test("unshare posts the unshare endpoint", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { unshare: async (args: any) => { calls.push(args); return {} } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client, threadModel: () => null, modelLimit: async () => undefined })
  await expect(ops.unshare("t1")).resolves.toBeUndefined()
  expect(calls).toEqual([{ path: { id: "s1" }, query: { directory: "/w" } }])
})

test("compact summarizes with the thread model and exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { summarize: async (args: any) => { calls.push(args); return { data: true } } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client, threadModel: () => "anthropic/claude", modelLimit: async () => undefined })
  expect(await ops.compact("t1")).toBe("compacted")
  expect(calls).toEqual([{ path: { id: "s1" }, query: { directory: "/w" }, body: { providerID: "anthropic", modelID: "claude" } }])
})

test("compact without a model throws the spec error", async () => {
  const client = fakeClient()
  for (const model of [null, undefined, "claude", "anthropic/", ""]) {
    const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client, threadModel: () => model, modelLimit: async () => undefined })
    await expect(ops.compact("t1")).rejects.toThrow("set a model with /model first")
  }
})

test("formatTokens renders plain, k, and m values", () => {
  expect(formatTokens(950)).toBe("950")
  expect(formatTokens(6000)).toBe("6k")
  expect(formatTokens(12500)).toBe("12.5k")
  expect(formatTokens(1250000)).toBe("1.3m")
})

test("formatContextUsage renders a 20-cell bar", () => {
  expect(formatContextUsage(50000, 100000)).toBe("50k/100k (50%)\n[██████████░░░░░░░░░░]")
  expect(formatContextUsage(1550, 200000)).toBe("1.6k/200k (1%)\n[░░░░░░░░░░░░░░░░░░░░]")
})

test("formatContextUsage clamps a full bar", () => {
  expect(formatContextUsage(200000, 100000)).toBe("200k/100k (200%)\n[████████████████████]")
})

test("contextUsage sums the last assistant tokens and reads the model limit", async () => {
  const limits: Array<[string, string]> = []
  const client = fakeClient({ session: { messages: async () => ({ data: [
    { info: { id: "m1", role: "user" } },
    { info: { id: "m2", role: "assistant", tokens: { input: 1000, output: 200, cache: { read: 300, write: 50 } } } },
    { info: { id: "m3", role: "assistant", tokens: { input: 4000, output: 500, cache: { read: 100, write: 0 } } } },
  ] }) } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client,
    threadModel: () => "anthropic/claude",
    modelLimit: async (threadId, model) => { limits.push([threadId, model]); return 200000 } })
  expect(await ops.contextUsage("t1")).toEqual({ used: 4600, limit: 200000 })
  expect(limits).toEqual([["t1", "anthropic/claude"]])
})

test("contextUsage reports no-usage and no-limit", async () => {
  const noUsage = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => fakeClient(),
    threadModel: () => "anthropic/claude", modelLimit: async () => 200000 })
  expect(await noUsage.contextUsage("t1")).toBe("no-usage")

  const withUsage = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => fakeClient({ session: {
    messages: async () => ({ data: [{ info: { id: "m2", role: "assistant", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } }] }),
  } }), threadModel: () => "anthropic/claude", modelLimit: async () => undefined })
  expect(await withUsage.contextUsage("t1")).toBe("no-limit")

  const noModel = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => fakeClient({ session: {
    messages: async () => ({ data: [{ info: { id: "m2", role: "assistant", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } }] }),
  } }), threadModel: () => null, modelLimit: async () => 200000 })
  expect(await noModel.contextUsage("t1")).toBe("no-limit")
})
