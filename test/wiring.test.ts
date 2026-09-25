import { expect, test } from "vitest"
import { ChannelType } from "discord.js"
import { buildPromptText, findCategoryId, projectForChannel, sessionIdFrom } from "../src/index.ts"

test("findCategoryId prefers the configured category", () => {
  expect(findCategoryId({ channels: { cache: new Map() } }, "configured")).toBe("configured")
})

test("findCategoryId finds an existing Eregion category", () => {
  const cache = new Map([
    ["c1", { id: "c1", name: "Eregion", type: ChannelType.GuildCategory }],
    ["c2", { id: "c2", name: "Other", type: ChannelType.GuildCategory }],
    ["c3", { id: "c3", name: "Eregion", type: ChannelType.GuildText }],
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
  expect(buildPromptText("hello", ["/sandbox/.cely/inbox/a.txt"])).toBe("hello\n\n[attachment] /sandbox/.cely/inbox/a.txt")
  expect(buildPromptText("   ", [])).toBe("")
  expect(buildPromptText("", ["/x"])).toBe("[attachment] /x")
})
