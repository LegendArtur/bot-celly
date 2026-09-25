import { expect, test } from "vitest"
import { isAuthorized, rolesOf, shouldHandleMessage } from "../src/discord.ts"

const perm = (admin = false, manage = false) => ({ has: (bit: bigint) => (admin && bit === 8n) || (manage && bit === 32n) })
test("owner always allowed", () => expect(isAuthorized({ id: "o", roles: [], permissions: perm() }, "o", {})).toBe(true))
test("block role wins over access role", () => {
  expect(isAuthorized({ id: "u", roles: ["access", "block"], permissions: perm() }, "owner", { accessRoleId: "access", blockRoleId: "block" })).toBe(false)
})
test("block role denies even the guild owner", () => {
  expect(isAuthorized({ id: "owner", roles: ["block"], permissions: perm(true, true) }, "owner", { blockRoleId: "block" })).toBe(false)
})
test("Administrator and ManageGuild grant access", () => {
  expect(isAuthorized({ id: "u", roles: [], permissions: perm(true) }, "owner", {})).toBe(true)
  expect(isAuthorized({ id: "u", roles: [], permissions: perm(false, true) }, "owner", {})).toBe(true)
})
test("access role allowed, stranger denied", () => {
  expect(isAuthorized({ id: "u", roles: ["access"], permissions: perm() }, "owner", { accessRoleId: "access" })).toBe(true)
  expect(isAuthorized({ id: "u", roles: [], permissions: perm() }, "owner", { accessRoleId: "access" })).toBe(false)
})
test("rolesOf maps the role cache to ids", () => {
  const member = { roles: { cache: new Map([["a", { id: "a" }], ["b", { id: "b" }]]) } }
  expect(rolesOf(member).sort()).toEqual(["a", "b"])
})

const message = (over: Record<string, unknown> = {}) => ({
  author: { bot: false },
  webhookId: null,
  system: false,
  channel: { id: "project" },
  ...over,
}) as any

test("router ignores bots, webhooks, and system messages", () => {
  expect(shouldHandleMessage(message({ author: { bot: true } }), "project")).toBe(false)
  expect(shouldHandleMessage(message({ webhookId: "w" }), "project")).toBe(false)
  expect(shouldHandleMessage(message({ system: true }), "project")).toBe(false)
})
test("router accepts the project channel and its threads only", () => {
  expect(shouldHandleMessage(message(), "project")).toBe(true)
  expect(shouldHandleMessage(message({ channel: { id: "thread", parentId: "project" } }), "project")).toBe(true)
  expect(shouldHandleMessage(message({ channel: { id: "other" } }), "project")).toBe(false)
  expect(shouldHandleMessage(message(), undefined)).toBe(false)
})

test("router accepts a known archived thread even when parentId is null", () => {
  const archived = message({ channel: { id: "thread", parentId: null, isThread: () => true } })
  expect(shouldHandleMessage(archived, "project")).toBe(false)
  expect(shouldHandleMessage(archived, "project", true)).toBe(true)
})
