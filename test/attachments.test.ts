import { join } from "node:path"
import { expect, test } from "vitest"
import { attachmentDestination, isTextLikeAttachment, shouldIngestAttachment } from "../src/attachments.ts"

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
