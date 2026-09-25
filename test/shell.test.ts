import { expect, test } from "vitest"
import { runShell } from "../src/shell.ts"

test("passes the command as a single argv element and chunks output", async () => {
  const calls: string[][] = []
  const sbx: any = { exec: async (name: string, args: string[]) => { calls.push([name, ...args]); return { code: 0, stdout: "ok", stderr: "" } } }
  const chunks = await runShell({ sbx, project: { sandboxName: "cely-demo", directory: "C:\\p" } as any }, "echo 'a b'")
  expect(calls[0]).toEqual(["cely-demo", "bash", "-lc", "echo 'a b'"])
  expect(chunks).toEqual(["ok"])
})
test("caps output at 3 chunks plus a notice", async () => {
  const sbx: any = { exec: async () => ({ code: 0, stdout: "x".repeat(9000), stderr: "" }) }
  const chunks = await runShell({ sbx, project: { sandboxName: "c", directory: "C:\\p" } as any }, "yes")
  expect(chunks.length).toBe(4)
  expect(chunks[3]).toMatch(/truncated/)
  expect(chunks[3]).toContain("exit 0")
})
test("closes an open code fence before the truncation notice", async () => {
  const text = "`".repeat(500) + "\n" + "a\n".repeat(3000)
  const sbx: any = { exec: async () => ({ code: 0, stdout: text, stderr: "" }) }
  const chunks = await runShell({ sbx, project: { sandboxName: "c", directory: "C:\\p" } as any }, "cmd")
  expect(chunks.length).toBe(4)
  const head = chunks.slice(0, 3).join("\n")
  const markers = head.split("\n").filter((l) => /^ {0,3}`{3,}/.test(l))
  expect(markers.length % 2).toBe(0)
})

test("surfaces a non-zero exit code alongside output", async () => {
  const sbx: any = { exec: async () => ({ code: 3, stdout: "boom", stderr: "" }) }
  const chunks = await runShell({ sbx, project: { sandboxName: "c", directory: "C:\\p" } as any }, "false")
  const joined = chunks.join("\n")
  expect(joined).toContain("boom")
  expect(joined).toContain("exit 3")
})
test("includes stderr in the output", async () => {
  const sbx: any = { exec: async () => ({ code: 0, stdout: "out", stderr: "warn" }) }
  const chunks = await runShell({ sbx, project: { sandboxName: "c", directory: "C:\\p" } as any }, "cmd")
  const joined = chunks.join("\n")
  expect(joined).toContain("out")
  expect(joined).toContain("warn")
})
