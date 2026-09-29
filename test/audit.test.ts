// test/audit.test.ts
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createAuditLog } from "../src/audit.ts"
import { withTempDir } from "./helpers/tmp.ts"

test("creates the audit file with mode 0600", async () => {
  await withTempDir("celly-audit-", (dir) => {
    const file = join(dir, "audit.jsonl")
    createAuditLog({ file })
    expect(readFileSync(file, "utf8")).toBe("")
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

test("appends one JSON object per line with the injected clock", async () => {
  await withTempDir("celly-audit-", (dir) => {
    const file = join(dir, "audit.jsonl")
    const audit = createAuditLog({ file, clock: () => Date.parse("2026-01-02T03:04:05.000Z") })
    audit.append({ kind: "permission", channelId: "c1", threadId: "t1", actorId: "u1", detail: "bash git push", decision: "reject" })
    audit.append({ kind: "mode", threadId: "c1", actorId: "u2", detail: "approval_mode:c1", decision: "buttons" })
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { ts: "2026-01-02T03:04:05.000Z", channelId: "c1", threadId: "t1", actorId: "u1", kind: "permission", detail: "bash git push", decision: "reject" },
      { ts: "2026-01-02T03:04:05.000Z", channelId: "c1", threadId: "c1", actorId: "u2", kind: "mode", detail: "approval_mode:c1", decision: "buttons" },
    ])
  })
})

test("tail returns the last N entries oldest-first and ignores malformed lines", async () => {
  await withTempDir("celly-audit-", (dir) => {
    const file = join(dir, "audit.jsonl")
    const audit = createAuditLog({ file, clock: () => 0 })
    audit.append({ kind: "shell", channelId: "c1", threadId: "c1", actorId: "u1", detail: "echo one", decision: "run" })
    audit.append({ kind: "shell", channelId: "c1", threadId: "c1", actorId: "u1", detail: "echo two", decision: "run" })
    const raw = readFileSync(file, "utf8")
    rmSync(file)
    writeFileSync(file, `not json\n${raw}`)
    expect(audit.tail(1).map((e) => e.detail)).toEqual(["echo two"])
    expect(audit.tail(10).map((e) => e.detail)).toEqual(["echo one", "echo two"])
    expect(audit.tail(0)).toEqual([])
  })
})

test("tail on a missing file returns an empty list", async () => {
  await withTempDir("celly-audit-", (dir) => {
    const audit = createAuditLog({ file: join(dir, "audit.jsonl") })
    rmSync(join(dir, "audit.jsonl"))
    expect(audit.tail(5)).toEqual([])
  })
})

test("reports init and append failures through the injected error logger", async () => {
  await withTempDir("celly-audit-", (dir) => {
    const file = join(dir, "audit.jsonl")
    mkdirSync(file)
    const errors: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const audit = createAuditLog({ file, error: (msg, fields) => errors.push({ msg, fields }) })
    audit.append({ kind: "shell", channelId: "c1", threadId: "c1", actorId: "u1", detail: "x", decision: "run" })
    expect(errors.map((e) => e.msg)).toEqual(["audit log init failed", "audit append failed"])
    expect(errors.every((e) => typeof e.fields?.error === "string")).toBe(true)
  })
})

test("append never throws when the file is unwritable", async () => {
  await withTempDir("celly-audit-", (dir) => {
    const file = join(dir, "audit.jsonl")
    const audit = createAuditLog({ file })
    rmSync(file)
    mkdirSync(file)
    expect(() => audit.append({ kind: "shell", channelId: "c1", threadId: "c1", actorId: "u1", detail: "x", decision: "run" })).not.toThrow()
  })
})
