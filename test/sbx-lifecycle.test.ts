// test/sbx-lifecycle.test.ts
import { expect, test } from "vitest"
import { allocatePort, Sbx, SbxError } from "../src/sbx.ts"

class FakeRunner {
  calls: string[][] = []
  constructor(private responses: Record<string, { code?: number; stdout?: string; stderr?: string }[]>) {}
  private next(args: string[]) {
    const key = args.slice(0, 2).join(" ")
    const q = this.responses[key]; return q?.shift() ?? { code: 0, stdout: "[]", stderr: "" }
  }
  async run(args: string[]) { this.calls.push(args); const r = this.next(args); return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" } }
  spawnStream(args: string[]) { this.calls.push(args); return { on() {}, kill() {}, stdout: { on() {} }, stderr: { on() {} } } as any }
}

test("create builds an argv-only command with publish", async () => {
  const r = new FakeRunner({})
  const sbx = new Sbx(r as any)
  await sbx.create({ name: "celly-demo", directory: "C:\\p\\demo", hostPort: 4300, cpus: 2, memory: "4g" })
  expect(r.calls[0]).toEqual(["create", "opencode", "C:\\p\\demo", "--name", "celly-demo", "--publish", "4300:4096", "--cpus", "2", "--memory", "4g"])
})

test("create throws on non-zero exit", async () => {
  const r = new FakeRunner({ "create opencode": [{ code: 1, stderr: "boom" }] })
  await expect(new Sbx(r as any).create({ name: "celly-demo", directory: "C:\\p", hostPort: 4300, cpus: 2, memory: "4g" }))
    .rejects.toThrow(/boom/)
})

test("create rejects an out-of-range or non-integer host port before spawning", async () => {
  const r = new FakeRunner({})
  for (const hostPort of [0, 70000, 4300.5, Number.NaN]) {
    await expect(new Sbx(r as any).create({ name: "celly-demo", directory: "C:\\p", hostPort, cpus: 2, memory: "4g" }))
      .rejects.toThrow(SbxError)
  }
  expect(r.calls).toEqual([])
})

test("create rejects a negative or fractional cpu count", async () => {
  const r = new FakeRunner({})
  await expect(new Sbx(r as any).create({ name: "celly-demo", directory: "C:\\p", hostPort: 4300, cpus: -1, memory: "4g" }))
    .rejects.toThrow(SbxError)
  await expect(new Sbx(r as any).create({ name: "celly-demo", directory: "C:\\p", hostPort: 4300, cpus: 1.5, memory: "4g" }))
    .rejects.toThrow(SbxError)
  expect(r.calls).toEqual([])
})

test("list wraps malformed JSON stdout in SbxError", async () => {
  const r = new FakeRunner({ "ls --json": [{ code: 0, stdout: "not json" }] })
  await expect(new Sbx(r as any).list()).rejects.toThrow(SbxError)
})

test("allocatePort skips used and busy ports", async () => {
  const used = new Set([4300])
  const port = await allocatePort({ start: 4300, end: 4302, used, isFree: async (p) => p !== 4301 })
  expect(port).toBe(4302)
})
test("allocatePort throws when the pool is exhausted", async () => {
  await expect(allocatePort({ start: 4300, end: 4300, used: new Set([4300]), isFree: async () => true })).rejects.toThrow(/exhausted/)
})
