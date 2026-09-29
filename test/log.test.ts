import { expect, test, vi } from "vitest"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createLogger, formatLogLine, redact } from "../src/log.ts"
import { withTempDir } from "./helpers/tmp.ts"

test("formatLogLine renders local time, padded level, message, and key=value fields", () => {
  const line = formatLogLine({
    ts: new Date(2026, 8, 27, 20, 49, 57),
    level: "warn",
    msg: "provider login not detected",
    fields: { sandboxName: "celly-komorebi", providerId: "openai" },
  }, { color: false })
  expect(line).toBe("20:49:57  WARN   provider login not detected  sandboxName=celly-komorebi providerId=openai")
})
test("formatLogLine pads every level to the same message column", () => {
  const info = formatLogLine({ ts: new Date(2026, 8, 27, 20, 49, 57), level: "info", msg: "ready" }, { color: false })
  const error = formatLogLine({ ts: new Date(2026, 8, 27, 20, 49, 57), level: "error", msg: "boom" }, { color: false })
  expect(info).toBe("20:49:57  INFO   ready")
  expect(error).toBe("20:49:57  ERROR  boom")
})
test("formatLogLine quotes values with whitespace and renders arrays and objects", () => {
  const line = formatLogLine({
    ts: new Date(2026, 8, 27, 20, 49, 57),
    level: "info",
    msg: "m",
    fields: { note: "hello world", tags: ["a", "b"], meta: { n: 1 }, empty: [], nil: null, missing: undefined },
  }, { color: false })
  expect(line).toBe('20:49:57  INFO   m  note="hello world" tags=a,b meta={"n":1} empty=[] nil=null')
})
test("formatLogLine renders the error field last and indents its stack", () => {
  const line = formatLogLine({
    ts: new Date(2026, 8, 27, 20, 49, 57),
    level: "error",
    msg: "failed",
    fields: { error: "first\nsecond", channelId: "c1" },
  }, { color: false })
  expect(line).toBe("20:49:57  ERROR  failed  channelId=c1 error=first\n    second")
})
test("formatLogLine colors timestamp, level, and error field only when color is on", () => {
  const record = { ts: new Date(2026, 8, 27, 20, 49, 57), level: "error" as const, msg: "boom", fields: { error: "nope" } }
  const colored = formatLogLine(record, { color: true })
  expect(colored).toContain("\x1b[90m20:49:57\x1b[0m")
  expect(colored).toContain("\x1b[31mERROR\x1b[0m")
  expect(colored).toContain("\x1b[31merror=nope\x1b[0m")
  const plain = formatLogLine(record, { color: false })
  expect(plain).not.toContain("\x1b[")
})
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
test("removing a secret from the array stops redacting it", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const secrets = ["first", "second"]
  const log = createLogger({ level: "info", secrets })
  secrets.splice(secrets.indexOf("second"), 1)
  log.info("later", { note: "second" })
  const line = info.mock.calls[0]?.[0] as string
  expect(line).toContain("second")
  info.mockRestore()
})
test("logger pretty mode writes a human line to the console and JSON to the file", async () => {
  await withTempDir("celly-log-pretty-", (dir) => {
    const file = join(dir, "bot.log")
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const log = createLogger({ level: "info", file, pretty: true, color: false })
      log.info("admin server listening", { port: 4560 })
      expect(info.mock.calls[0]?.[0]).toMatch(/^\d{2}:\d{2}:\d{2}  INFO   admin server listening  port=4560$/)
      expect(readFileSync(file, "utf8")).toContain('"msg":"admin server listening"')
    } finally {
      info.mockRestore()
    }
  })
})
test("logger pretty mode still redacts secrets", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const log = createLogger({ level: "info", pretty: true, color: false, secrets: ["topsecret"] })
  log.info("login", { token: "topsecret", note: "topsecret" })
  const line = info.mock.calls[0]?.[0] as string
  expect(line).toMatch(/^\d{2}:\d{2}:\d{2}  INFO   login  /)
  expect(line).not.toContain("topsecret")
  expect(line).toContain("[redacted]")
  info.mockRestore()
})

test("truncate clears an existing log file at construction", async () => {
  await withTempDir("celly-log-", (dir) => {
    const file = join(dir, "bot.log")
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      writeFileSync(file, "old line\n")
      const log = createLogger({ level: "info", file, truncate: true })
      log.info("first")
      const contents = readFileSync(file, "utf8")
      expect(contents).not.toContain("old line")
      expect(contents).toContain("first")
    } finally {
      info.mockRestore()
    }
  })
})

test("logger rotates the file once appends pass maxBytes", async () => {
  await withTempDir("celly-log-rotate-", (dir) => {
    const file = join(dir, "bot.log")
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const log = createLogger({ level: "info", file, maxBytes: 200, maxFiles: 2 })
      for (let i = 0; i < 12; i++) log.info("line", { i })
      expect(existsSync(`${file}.1`)).toBe(true)
      expect(readFileSync(`${file}.1`, "utf8")).toContain('"msg":"line"')
    } finally {
      info.mockRestore()
    }
  })
})
