// test/usage.test.ts
import { expect, test } from "vitest"
import { formatCost, formatTokens, formatUsageFooter, formatUsageSummary, resolveBudget } from "../src/usage.ts"

test("formats token counts compactly", () => {
  expect(formatTokens(0)).toBe("0")
  expect(formatTokens(999)).toBe("999")
  expect(formatTokens(1000)).toBe("1k")
  expect(formatTokens(1200)).toBe("1.2k")
  expect(formatTokens(1_200_000)).toBe("1.2M")
})

test("formats cost to four decimal places", () => {
  expect(formatCost(0)).toBe("$0.0000")
  expect(formatCost(0.01234)).toBe("$0.0123")
  expect(formatCost(1.5)).toBe("$1.5000")
})

test("builds the usage footer", () => {
  expect(formatUsageFooter({ cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 0, cacheWrite: 0 }))
    .toBe("$0.0123 · 1.2k in / 3.4k out")
  expect(formatUsageSummary("session", { cost: 0.0123, tokensIn: 1200, tokensOut: 3400, cacheRead: 0, cacheWrite: 0 }))
    .toBe("session: $0.0123 · 1.2k in / 3.4k out")
})

test("resolveBudget prefers a finite non-negative channel override", () => {
  const store = new Map<string, string>([["budget_usd:c1", "2.5"]])
  const settings = { get: (k: string) => store.get(k) }
  expect(resolveBudget(settings, "c1", 1)).toBe(2.5)
  expect(resolveBudget(settings, "c2", 1)).toBe(1)
  store.set("budget_usd:c2", "bogus")
  expect(resolveBudget(settings, "c2", 1)).toBe(1)
  store.set("budget_usd:c2", "-1")
  expect(resolveBudget(settings, "c2", 1)).toBe(1)
})
