import { expect, test } from "vitest"
import { redact } from "../src/log.ts"

test("redacts known secrets anywhere in a string", () => {
  expect(redact("auth=abc123 end", ["abc123"])).toBe("auth=[redacted] end")
})
test("redacts basic-auth headers and bearer tokens", () => {
  expect(redact("Authorization: Bearer xyz", [])).toBe("Authorization: [redacted]")
  expect(redact("authorization: Basic b3BlbmNvZGU6cHc=", [])).toBe("authorization: [redacted]")
})
test("leaves normal text alone", () => {
  expect(redact("hello world", ["secret"])).toBe("hello world")
})
