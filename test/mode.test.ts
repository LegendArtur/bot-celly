// test/mode.test.ts
import { expect, test } from "vitest"
import { APPROVAL_MODES, approvalModeFor, isApprovalMode, PLAN_READ_ONLY_TOOLS } from "../src/mode.ts"

function settings(entries: Record<string, string>) {
  return { get: (key: string) => entries[key] }
}

test("approvalModeFor prefers the channel override, then the global setting, then buttons", () => {
  expect(approvalModeFor(settings({ "approval_mode:c1": "plan", approval_mode: "auto" }), "c1")).toBe("plan")
  expect(approvalModeFor(settings({ approval_mode: "auto" }), "c1")).toBe("auto")
  expect(approvalModeFor(settings({}), "c1")).toBe("buttons")
  expect(approvalModeFor(settings({ approval_mode: "bogus" }), "c1")).toBe("buttons")
  expect(approvalModeFor(settings({}), undefined)).toBe("buttons")
  expect(APPROVAL_MODES).toEqual(["auto", "buttons", "plan"])
})

test("isApprovalMode narrows only the three known modes", () => {
  expect(isApprovalMode("auto")).toBe(true)
  expect(isApprovalMode("buttons")).toBe(true)
  expect(isApprovalMode("plan")).toBe(true)
  expect(isApprovalMode("yolo")).toBe(false)
  expect(isApprovalMode(undefined)).toBe(false)
})

test("PLAN_READ_ONLY_TOOLS is the read-only allow list", () => {
  expect([...PLAN_READ_ONLY_TOOLS].sort()).toEqual(["find", "glob", "grep", "list", "read"])
})
