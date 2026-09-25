import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { attachmentDestination, attachmentSandboxPath, downloadAttachment, ensureSafeInbox, isTextLikeAttachment, shouldIngestAttachment } from "../src/attachments.ts"

test("detects text-like attachments by content type or extension", () => {
  expect(isTextLikeAttachment({ name: "notes", size: 10, contentType: "text/plain" })).toBe(true)
  expect(isTextLikeAttachment({ name: "data.json", size: 10, contentType: null })).toBe(true)
  expect(isTextLikeAttachment({ name: "script.ts", size: 10 })).toBe(true)
  expect(isTextLikeAttachment({ name: "photo.png", size: 10, contentType: "image/png" })).toBe(false)
  expect(isTextLikeAttachment({ name: "archive.zip", size: 10 })).toBe(false)
})

test("ingests only within the size cap", () => {
  const text = { name: "notes.txt", size: 100, contentType: "text/plain" }
  expect(shouldIngestAttachment(text, 100)).toBe(true)
  expect(shouldIngestAttachment({ ...text, size: 101 }, 100)).toBe(false)
  expect(shouldIngestAttachment({ ...text, size: 0 }, 100)).toBe(false)
  expect(shouldIngestAttachment({ name: "photo.png", size: 10, contentType: "image/png" }, 100)).toBe(false)
})

test("attachment destinations live under the project inbox", () => {
  const dir = "C:\\projects\\demo"
  const dest = attachmentDestination(dir, "notes.txt", "abc-123")
  expect(dest).toBe(join(dir, ".cely", "inbox", "abc-123-notes.txt"))
})

test("attachment destinations reject traversal and reserved names", () => {
  expect(() => attachmentDestination("C:\\projects\\demo", "../evil.txt", "id")).toThrow()
  expect(() => attachmentDestination("C:\\projects\\demo", "CON", "id")).toThrow()
})

test("attachment destinations use the basename of backslash names", () => {
  expect(attachmentDestination("/srv/projects/demo", "..\\..\\evil.txt", "id")).toBe("/srv/projects/demo/.cely/inbox/id-evil.txt")
})

test("attachment sandbox paths use the resolved in-sandbox root", () => {
  const host = "C:\\projects\\demo"
  const dest = attachmentDestination(host, "notes.txt", "abc")
  expect(attachmentSandboxPath(host, "/sandbox/workspace", dest)).toBe("/sandbox/workspace/.cely/inbox/abc-notes.txt")
  expect(attachmentSandboxPath(host, null, dest)).toBe("C:/projects/demo/.cely/inbox/abc-notes.txt")
})

test("ensureSafeInbox creates and returns a real inbox under the project", () => {
  const root = mkdtempSync(join(tmpdir(), "cely-inbox-"))
  try {
    const inbox = ensureSafeInbox(root)
    expect(inbox).toBe(join(root, ".cely", "inbox"))
    expect(existsSync(inbox)).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("ensureSafeInbox rejects a symlinked inbox", () => {
  const root = mkdtempSync(join(tmpdir(), "cely-inbox-"))
  const outside = mkdtempSync(join(tmpdir(), "cely-out-"))
  try {
    mkdirSync(join(root, ".cely"))
    symlinkSync(outside, join(root, ".cely", "inbox"))
    expect(() => ensureSafeInbox(root)).toThrow(/symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("ensureSafeInbox rejects a symlinked .cely directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cely-inbox-"))
  const outside = mkdtempSync(join(tmpdir(), "cely-out-"))
  try {
    symlinkSync(outside, join(root, ".cely"))
    expect(() => ensureSafeInbox(root)).toThrow(/symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

async function attachmentServer(handler: (res: import("node:http").ServerResponse) => void) {
  const server = createServer((_, res) => handler(res))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { url: `http://127.0.0.1:${(server.address() as any).port}/file`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

test("downloadAttachment skips a non-ok response", async () => {
  const s = await attachmentServer((res) => res.writeHead(404).end())
  try { expect(await downloadAttachment(s.url, 1024)).toBeNull() }
  finally { await s.close() }
})

test("downloadAttachment skips a body over the byte cap", async () => {
  const s = await attachmentServer((res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(500)) })
  try { expect(await downloadAttachment(s.url, 100)).toBeNull() }
  finally { await s.close() }
})

test("downloadAttachment skips a declared oversize body", async () => {
  const s = await attachmentServer((res) => { res.writeHead(200, { "content-length": "500" }); res.end("x".repeat(500)) })
  try { expect(await downloadAttachment(s.url, 100)).toBeNull() }
  finally { await s.close() }
})

test("downloadAttachment buffers a body within the cap", async () => {
  const s = await attachmentServer((res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("hello") })
  try {
    const body = await downloadAttachment(s.url, 100)
    expect(body?.toString()).toBe("hello")
  } finally { await s.close() }
})
