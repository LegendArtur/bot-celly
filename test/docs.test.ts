// test/docs.test.ts
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

test("commands reference and README list /attach and /session-id", () => {
  const commands = read("../docs-site/reference/commands.mdx")
  const readme = read("../README.md")
  for (const doc of [commands, readme]) {
    expect(doc).toContain("`/attach`")
    expect(doc).toContain("`/session-id`")
  }
})

test("terminal attach guide documents the exact attach command and ATTACH_AUTO_THREAD", () => {
  const guide = read("../docs-site/guides/terminal-attach.mdx")
  expect(guide).toContain("ATTACH_AUTO_THREAD")
  expect(guide).toContain("sbx exec -it")
  expect(guide).toContain("exec opencode attach http://127.0.0.1:4096 -s")
})

test("configuration docs and .env.example list ATTACH_AUTO_THREAD", () => {
  expect(read("../docs-site/guides/configuration.mdx")).toContain("ATTACH_AUTO_THREAD")
  expect(read("../.env.example")).toContain("ATTACH_AUTO_THREAD")
})

test("the terminal attach guide states the web UI is not published", () => {
  expect(read("../docs-site/guides/terminal-attach.mdx")).toContain("intentionally not published")
})
