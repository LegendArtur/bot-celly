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
})
