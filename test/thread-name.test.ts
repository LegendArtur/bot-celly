import { expect, test } from "vitest"
import {
  composeThreadName, normalizeTitle, parseNameMarker, statusPrefix, stripNameMarker,
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
