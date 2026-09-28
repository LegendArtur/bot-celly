import { expect, test } from "vitest"
import { escapeHtml, formatClock, formatCost, formatRelative, formatTokens, formatUptime, renderNotice } from "../src/admin/views.ts"

test("escapeHtml neutralizes markup in every attribute context", () => {
  expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;")
})

test("formatCost renders sub-cent and empty values", () => {
  expect(formatCost(0)).toBe("$0.00")
  expect(formatCost(4.2)).toBe("$4.20")
  expect(formatCost(0.004)).toBe("<$0.01")
})

test("formatTokens abbreviates thousands and millions", () => {
  expect(formatTokens(0)).toBe("0")
  expect(formatTokens(640)).toBe("640")
  expect(formatTokens(12_300)).toBe("12k")
  expect(formatTokens(1_240_000)).toBe("1.2M")
})

test("formatRelative reports coarse recency", () => {
  const now = 1_000_000_000
  expect(formatRelative(now, now - 10_000)).toBe("just now")
  expect(formatRelative(now, now - 12 * 60_000)).toBe("12m ago")
  expect(formatRelative(now, now - 3 * 3_600_000)).toBe("3h ago")
  expect(formatRelative(now, 0)).toBe("never")
})

test("formatClock is zero padded HH:MM", () => {
  const ts = new Date(2026, 0, 1, 9, 5).getTime()
  expect(formatClock(ts)).toBe("09:05")
})

test("formatUptime reports hours and minutes", () => {
  expect(formatUptime(90_000)).toBe("1m")
  expect(formatUptime(3 * 3_600_000 + 42 * 60_000)).toBe("3h 42m")
})

test("renderNotice escapes text and toggles the error class", () => {
  expect(renderNotice("", "info")).toBe("")
  expect(renderNotice("<x>", "error")).toBe(`<div class="notice error">&lt;x&gt;</div>`)
})
