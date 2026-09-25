import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import { attachmentDestination, attachmentSandboxPath, downloadAttachment, ensureSafeInbox, ingestAttachments, isTextLikeAttachment, shouldIngestAttachment, writeAttachmentFile } from "../src/attachments.ts"

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
  expect(dest).toBe(join(dir, ".celly", "inbox", "abc-123-notes.txt"))
})

test("attachment destinations reject traversal and reserved names", () => {
  expect(() => attachmentDestination("C:\\projects\\demo", "../evil.txt", "id")).toThrow()
  expect(() => attachmentDestination("C:\\projects\\demo", "CON", "id")).toThrow()
})

test("attachment destinations use the basename of backslash names", () => {
  expect(attachmentDestination("/srv/projects/demo", "..\\..\\evil.txt", "id")).toBe("/srv/projects/demo/.celly/inbox/id-evil.txt")
})

test("attachment sandbox paths use the resolved in-sandbox root", () => {
  const host = "C:\\projects\\demo"
  const dest = attachmentDestination(host, "notes.txt", "abc")
  expect(attachmentSandboxPath(host, "/sandbox/workspace", dest)).toBe("/sandbox/workspace/.celly/inbox/abc-notes.txt")
  expect(attachmentSandboxPath(host, null, dest)).toBe("C:/projects/demo/.celly/inbox/abc-notes.txt")
})

test("ensureSafeInbox creates and returns a real inbox under the project", () => {
  const root = mkdtempSync(join(tmpdir(), "celly-inbox-"))
  try {
    const inbox = ensureSafeInbox(root)
    expect(inbox).toBe(join(root, ".celly", "inbox"))
    expect(existsSync(inbox)).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("ensureSafeInbox rejects a symlinked inbox", () => {
  const root = mkdtempSync(join(tmpdir(), "celly-inbox-"))
  const outside = mkdtempSync(join(tmpdir(), "celly-out-"))
  try {
    mkdirSync(join(root, ".celly"))
    symlinkSync(outside, join(root, ".celly", "inbox"))
    expect(() => ensureSafeInbox(root)).toThrow(/symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("ensureSafeInbox rejects a symlinked .celly directory", () => {
  const root = mkdtempSync(join(tmpdir(), "celly-inbox-"))
  const outside = mkdtempSync(join(tmpdir(), "celly-out-"))
  try {
    symlinkSync(outside, join(root, ".celly"))
    expect(() => ensureSafeInbox(root)).toThrow(/symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("ingestAttachments writes through the resolved inbox real path", async () => {
  const realRoot = mkdtempSync(join(tmpdir(), "celly-real-"))
  const linkRoot = join(tmpdir(), `celly-link-${process.pid}-${Date.now()}`)
  symlinkSync(realRoot, linkRoot, "dir")
  const destinations: string[] = []
  try {
    const out = await ingestAttachments({
      projectDirectory: linkRoot, sandboxPath: "/sandbox/ws", maxBytes: 100,
      attachments: [{ name: "a.txt", size: 5, contentType: "text/plain", url: "http://x/ok" }],
      download: async () => Buffer.from("hello"),
      write: async (destination) => { destinations.push(destination) },
      newId: () => "id",
    })
    const realInbox = realpathSync(join(realRoot, ".celly", "inbox"))
    expect(destinations).toEqual([join(realInbox, "id-a.txt")])
    expect(out[0]!.hostPath).toBe(join(realInbox, "id-a.txt"))
    expect(out[0]!.sandboxPath).toBe("/sandbox/ws/.celly/inbox/id-a.txt")
  } finally {
    rmSync(linkRoot, { force: true })
    rmSync(realRoot, { recursive: true, force: true })
  }
})

test("writeAttachmentFile refuses to follow a symlinked destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "celly-write-"))
  const outside = mkdtempSync(join(tmpdir(), "celly-write-out-"))
  try {
    const target = join(outside, "secret.txt")
    writeFileSync(target, "original")
    const destination = join(root, "link.txt")
    symlinkSync(target, destination)
    await expect(writeAttachmentFile(destination, Buffer.from("pwned"))).rejects.toThrow()
    expect(readFileSync(target, "utf8")).toBe("original")
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

test("ingestAttachments writes within-cap bodies, skips non-ok and oversize, and records sandbox paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "celly-ingest-"))
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/ok")) return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
    if (url.endsWith("/notok")) return new Response("nope", { status: 404 })
    if (url.endsWith("/big")) return new Response("x".repeat(500), { status: 200, headers: { "content-length": "500" } })
    return new Response("", { status: 500 })
  })
  try {
    const warnings: string[] = []
    const out = await ingestAttachments({
      projectDirectory: root, sandboxPath: "/sandbox/ws", maxBytes: 100,
      attachments: [
        { name: "a.txt", size: 5, contentType: "text/plain", url: "http://x/ok" },
        { name: "b.txt", size: 5, contentType: "text/plain", url: "http://x/notok" },
        { name: "c.txt", size: 5, contentType: "text/plain", url: "http://x/big" },
        { name: "photo.png", size: 5, contentType: "image/png", url: "http://x/ignored" },
      ],
      newId: () => "id",
      warn: (m) => { warnings.push(m) },
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.sandboxPath).toBe("/sandbox/ws/.celly/inbox/id-a.txt")
    expect(readFileSync(join(root, ".celly", "inbox", "id-a.txt"), "utf8")).toBe("hello")
    expect(warnings).toEqual([])
  } finally {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
  }
})

test("ingestAttachments warns and skips when the inbox is a symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "celly-ingest-"))
  const outside = mkdtempSync(join(tmpdir(), "celly-ingest-out-"))
  mkdirSync(join(root, ".celly"))
  symlinkSync(outside, join(root, ".celly", "inbox"))
  vi.stubGlobal("fetch", async () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }))
  try {
    const warnings: string[] = []
    const out = await ingestAttachments({
      projectDirectory: root, sandboxPath: "/sandbox/ws", maxBytes: 100,
      attachments: [{ name: "a.txt", size: 5, contentType: "text/plain", url: "http://x/ok" }],
      warn: (m) => { warnings.push(m) },
    })
    expect(out).toEqual([])
    expect(warnings).toContain("attachment ingest failed")
  } finally {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
