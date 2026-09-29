import { expect, test } from "vitest"
import { createProjectLists } from "../src/lists.ts"
import { projectFixture, silentLogger } from "./helpers/fixtures.ts"

const base = {
  projectFor: (channelId: string) => (channelId === "c" ? projectFixture() : undefined),
  ensureReady: async () => {},
  modelVariants: () => undefined,
  log: silentLogger,
}

test("listSessions maps ids and titles", async () => {
  const lists = createProjectLists({ ...base, clientFor: () => ({ session: { list: async () => ({ data: [{ id: "s1", title: "one" }, { id: "s2" }] }) } }) as any })
  expect(await lists.listSessions("c")).toEqual([{ id: "s1", title: "one" }, { id: "s2", title: "s2" }])
})

test("listSessions returns [] when the channel is not a project", async () => {
  let called = false
  const lists = createProjectLists({ ...base, clientFor: () => { called = true; return {} as any } })
  expect(await lists.listSessions("nope")).toEqual([])
  expect(called).toBe(false)
})

test("listModels flattens providers and caches the result", async () => {
  let loads = 0
  const lists = createProjectLists({ ...base, clientFor: () => ({ config: { providers: async () => { loads++; return { data: { providers: [{ id: "anthropic", name: "Anthropic", models: { claude: { name: "Claude" } } }] } } } } }) as any })
  expect(await lists.listModels("c")).toEqual([{ id: "anthropic/claude", name: "Claude" }])
  expect(await lists.listModels("c")).toHaveLength(1)
  expect(loads).toBe(1)
})

test("listAgents drops subagents", async () => {
  const lists = createProjectLists({ ...base, clientFor: () => ({ app: { agents: async () => ({ data: [{ name: "build", description: "Build things" }, { name: "hidden", mode: "subagent" }] }) } }) as any })
  expect(await lists.listAgents("c")).toEqual([{ id: "build", name: "build — Build things" }])
})

test("listSessions and listAgents log and return [] when the server call fails", async () => {
  const warnings: string[] = []
  const lists = createProjectLists({ ...base,
    clientFor: () => ({ session: { list: async () => { throw new Error("down") } }, app: { agents: async () => { throw new Error("down") } } }) as any,
    log: { warn: (message) => { warnings.push(message) } } })
  expect(await lists.listSessions("c")).toEqual([])
  expect(await lists.listAgents("c")).toEqual([])
  expect(warnings).toEqual(["list sessions failed", "list agents failed"])
})
