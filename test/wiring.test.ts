import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { ChannelType } from "discord.js"
import { buildPromptText, createSubscriptionGate, findCategoryId, isMainModule, modelVariants, projectForChannel, sanitizeChannelName, seedThreadDefaults, sessionIdFrom, touchAfterWake, uniqueChannelName } from "../src/index.ts"

test("findCategoryId prefers the configured category", () => {
  expect(findCategoryId({ channels: { cache: new Map() } }, "configured")).toBe("configured")
})

test("findCategoryId finds an existing Forge category", () => {
  const cache = new Map([
    ["c1", { id: "c1", name: "Forge", type: ChannelType.GuildCategory }],
    ["c2", { id: "c2", name: "Other", type: ChannelType.GuildCategory }],
    ["c3", { id: "c3", name: "Forge", type: ChannelType.GuildText }],
  ])
  expect(findCategoryId({ channels: { cache } } as any, undefined)).toBe("c1")
})

test("findCategoryId returns undefined when absent", () => {
  const cache = new Map([["c2", { id: "c2", name: "Other", type: ChannelType.GuildCategory }]])
  expect(findCategoryId({ channels: { cache } } as any, undefined)).toBeUndefined()
})

test("sessionIdFrom reads the SDK fields response and bare id", () => {
  expect(sessionIdFrom({ data: { id: "s1" }, request: {}, response: {} })).toBe("s1")
  expect(sessionIdFrom({ data: { id: "s1" } })).toBe("s1")
  expect(sessionIdFrom({ id: "s2" })).toBe("s2")
  expect(sessionIdFrom({ data: {} })).toBeUndefined()
  expect(sessionIdFrom(undefined)).toBeUndefined()
})

test("projectForChannel matches the channel or its parent", () => {
  const projects = [{ channelId: "p1" }, { channelId: "p2" }]
  expect(projectForChannel(projects, "p1")).toEqual({ channelId: "p1" })
  expect(projectForChannel(projects, "thread", "p2")).toEqual({ channelId: "p2" })
  expect(projectForChannel(projects, "thread", "nope")).toBeUndefined()
  expect(projectForChannel(projects, "unknown")).toBeUndefined()
})

test("buildPromptText announces in-sandbox attachment paths and drops blanks", () => {
  expect(buildPromptText("hello", ["/sandbox/.celly/inbox/a.txt"])).toBe("hello\n\n[attachment] /sandbox/.celly/inbox/a.txt")
  expect(buildPromptText("   ", [])).toBe("")
  expect(buildPromptText("", ["/x"])).toBe("[attachment] /x")
})

test("sanitizeChannelName strips control characters and limits the length", () => {
  expect(sanitizeChannelName("My  Web\nApp")).toBe("My-Web-App")
  expect(sanitizeChannelName("weird!!!name")).toBe("weird-name")
  expect(sanitizeChannelName("   ")).toBe("project")
  expect(sanitizeChannelName("\u0000\u0007")).toBe("project")
  expect(sanitizeChannelName("x".repeat(200)).length).toBeLessThanOrEqual(90)
})

test("isMainModule compares resolved file paths", () => {
  const self = fileURLToPath(import.meta.url)
  expect(isMainModule(import.meta.url, self)).toBe(true)
  expect(isMainModule(import.meta.url, `${self}.nope`)).toBe(false)
  expect(isMainModule(import.meta.url, undefined)).toBe(false)
})

test("uniqueChannelName appends a numeric suffix on collision", () => {
  expect(uniqueChannelName("demo", new Set())).toBe("demo")
  expect(uniqueChannelName("demo", new Set(["demo"]))).toBe("demo-2")
  expect(uniqueChannelName("demo", new Set(["demo", "demo-2"]))).toBe("demo-3")
  const long = "y".repeat(120)
  const base = sanitizeChannelName(long)
  expect(uniqueChannelName(base, new Set([base])).length).toBeLessThanOrEqual(90)
})

test("the project subscription gate starts at most one subscription and can resubscribe", () => {
  const gate = createSubscriptionGate()
  expect(gate.claim("c1")).toBe(true)
  expect(gate.claim("c1")).toBe(false)
  expect(gate.has("c1")).toBe(true)
  expect(gate.claim("c2")).toBe(true)
  gate.release("c1")
  expect(gate.has("c1")).toBe(false)
  expect(gate.claim("c1")).toBe(true)
})

test("index wires log rotation, backups, tasks, and the admin server into boot", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  expect(source).toContain("maxBytes: cfg.logMaxBytes")
  expect(source).toContain("maxFiles: cfg.logMaxFiles")
  expect(source).toContain("createBackupScheduler({")
  expect(source).toContain("createTaskRunner({")
  expect(source).toContain("createAdminServer({")
  expect(source).toContain("auditTail: (limit) => auditLog.tail(limit)")
  expect(source).toContain("taskRunner.stop()")
  expect(source).toContain("backups?.stop()")
  expect(source).toContain("admin?.close()")
})

test("index warms the model and agent caches in the boot subscribe path", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  expect(source).toContain("warmLists(project.channelId)")
  const lists = readFileSync(new URL("../src/lists.ts", import.meta.url), "utf8")
  expect(lists).toContain("`models:${channelId}`")
  expect(lists).toContain("`agents:${channelId}`")
})

test("index only wires the idle sweeper when IDLE_STOP_MINUTES is positive", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  expect(source).toContain("if (cfg.idleStopMinutes > 0) {")
  expect(source).toContain("createIdleSweeper({")
  expect(source).toContain("idleSweeper.start()")
  expect(source).toContain("idle auto-stop disabled")
})

test("touchAfterWake records activity after ensureReady, and not if the wake fails", async () => {
  const calls: string[] = []
  await touchAfterWake(
    { ensureReady: async (channelId: string) => { calls.push(`ready:${channelId}`) } },
    { projects: { touch: (channelId: string, at: number) => { calls.push(`touch:${channelId}:${typeof at}`) } } },
    "c1",
  )
  expect(calls).toEqual(["ready:c1", "touch:c1:number"])

  calls.length = 0
  await expect(touchAfterWake(
    { ensureReady: async () => { throw new Error("boom") } },
    { projects: { touch: (channelId: string) => { calls.push(`touch:${channelId}`) } } },
    "c1",
  )).rejects.toThrow("boom")
  expect(calls).toEqual([])
})

test("modelVariants lists the variant keys and tolerates malformed shapes", () => {
  expect(modelVariants({ variants: { high: {}, max: {} } })).toEqual(["high", "max"])
  expect(modelVariants({ variants: {} })).toEqual([])
  expect(modelVariants({})).toEqual([])
  expect(modelVariants({ variants: "nope" })).toEqual([])
  expect(modelVariants({ variants: null })).toEqual([])
})

test("seedThreadDefaults prefers the channel default then the global default", () => {
  const settings: Record<string, string> = {
    default_model: "global/model",
    default_agent: "global-agent",
    default_variant: "global-high",
    "default_model:c1": "channel/model",
    "default_agent:c1": "channel-agent",
    "default_variant:c1": "channel-max",
  }
  expect(seedThreadDefaults((key) => settings[key], "c1")).toEqual({ model: "channel/model", agent: "channel-agent", variant: "channel-max" })
  expect(seedThreadDefaults((key) => settings[key], "c2")).toEqual({ model: "global/model", agent: "global-agent", variant: "global-high" })
  expect(seedThreadDefaults(() => undefined, "c1")).toEqual({ model: null, agent: null, variant: null })
})

test("seedThreadDefaults ignores an emptied channel variant and falls back to the global default", () => {
  const settings: Record<string, string> = { default_variant: "global-high", "default_variant:c1": "" }
  expect(seedThreadDefaults((key) => settings[key], "c1").variant).toBe("global-high")
})
