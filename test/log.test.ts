import { expect, test, vi } from "vitest"
import { createLogger, redact } from "../src/log.ts"

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
test("redacts structured authorization fields", () => {
  const out = redact(JSON.stringify({ authorization: "Bearer xyz" }), [])
  expect(out).not.toContain("xyz")
  expect(JSON.parse(out)).toEqual({ authorization: "[redacted]" })
})
test("redacts structured password fields", () => {
  const out = redact(JSON.stringify({ password: "hunter2" }), [])
  expect(out).not.toContain("hunter2")
  expect(JSON.parse(out)).toEqual({ password: "[redacted]" })
})
test("redacts token and secret keys case-insensitively", () => {
  const out = redact(JSON.stringify({ Token: "abc", SECRET: "def" }), [])
  expect(JSON.parse(out)).toEqual({ Token: "[redacted]", SECRET: "[redacted]" })
})
test("keeps JSON valid when redacting auth inside a message", () => {
  const out = redact(JSON.stringify({ msg: "Authorization: Bearer xyz" }), [])
  expect(() => JSON.parse(out)).not.toThrow()
  expect(out).not.toContain("xyz")
})
test("redacts escaped secrets in JSON output", () => {
  const out = redact(JSON.stringify({ note: 'say "hi"' }), ['say "hi"'])
  expect(out).not.toContain("hi")
})
test("logger redacts structured secret fields", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const log = createLogger({ level: "info", secrets: ["topsecret"] })
  log.info("login", { authorization: "Bearer xyz", password: "hunter2", token: "topsecret" })
  const line = info.mock.calls[0]?.[0] as string
  expect(line).not.toContain("xyz")
  expect(line).not.toContain("hunter2")
  expect(line).not.toContain("topsecret")
  const parsed = JSON.parse(line)
  expect(parsed.authorization).toBe("[redacted]")
  expect(parsed.password).toBe("[redacted]")
  expect(parsed.token).toBe("[redacted]")
  info.mockRestore()
})
test("logger does not throw on a circular field object", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const log = createLogger({ level: "info" })
  const circular: Record<string, unknown> = { name: "loop" }
  circular.self = circular
  expect(() => log.info("circular", circular)).not.toThrow()
  const line = info.mock.calls[0]?.[0] as string
  expect(() => JSON.parse(line)).not.toThrow()
  expect(line).toContain("[circular]")
  info.mockRestore()
})
test("secrets added after logger construction are still redacted", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const secrets = ["first"]
  const log = createLogger({ level: "info", secrets })
  secrets.push("project-password")
  log.info("later", { note: "project-password" })
  const line = info.mock.calls[0]?.[0] as string
  expect(line).not.toContain("project-password")
  expect(line).toContain("[redacted]")
  info.mockRestore()
})
test("logger does not throw on a BigInt field", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const log = createLogger({ level: "info" })
  expect(() => log.info("big", { count: 10n })).not.toThrow()
  const line = info.mock.calls[0]?.[0] as string
  const parsed = JSON.parse(line)
  expect(parsed.count).toBe("10")
  info.mockRestore()
})
