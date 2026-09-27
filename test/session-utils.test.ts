// test/session-utils.test.ts
import { expect, test } from "vitest"
import { createSessionOps } from "../src/session-utils.ts"

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
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1", directory: "/w" }), clientFor: () => client })
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
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client })
  expect(await ops.undo("t1")).toBe("nothing")
  expect(calls).toEqual([["messages", { path: { id: "s1" } }]])
})

test("undo rejects an unknown thread", async () => {
  const ops = createSessionOps({ targetFor: () => undefined, clientFor: () => fakeClient() })
  await expect(ops.undo("t9")).rejects.toThrow("unknown thread t9")
})

test("redo unreverts with the exact payload", async () => {
  const calls: any[] = []
  const client = fakeClient({ session: { unrevert: async (args: any) => { calls.push(args); return {} } } })
  const ops = createSessionOps({ targetFor: () => ({ sessionId: "s1" }), clientFor: () => client })
  expect(await ops.redo("t1")).toBe("redone")
  expect(calls).toEqual([{ path: { id: "s1" } }])
})
