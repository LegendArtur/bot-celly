// test/db.test.ts
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"

function fresh() { const db = openDb(":memory:"); db.migrate(); return db }
const proj = { channelId: "c1", guildId: "g1", name: "demo", directory: "C:\\p\\demo",
  sandboxPath: null, sandboxName: "cely-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 }

test("inserts, reads, and enforces unique name/port", () => {
  const db = fresh()
  db.projects.insertProvisioning(proj)
  expect(db.projects.getByChannel("c1")?.sandboxName).toBe("cely-demo")
  expect(db.projects.getByName("demo")?.channelId).toBe("c1")
  expect(() => db.projects.insertProvisioning({ ...proj, channelId: "c2" })).toThrow()
})
test("updates status and sandbox path", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.projects.setReady("c1", "C:\\Users\\artur\\projects\\demo")
  expect(db.projects.getByChannel("c1")).toMatchObject({ status: "ready", sandboxPath: "C:\\Users\\artur\\projects\\demo" })
})
test("threads store render state and filter by activity", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.setRenderState("t1", "running"); db.threads.setLiveMessage("t1", "m1")
  expect(db.threads.get("t1")).toMatchObject({ renderState: "running", liveMessageId: "m1" })
  expect(db.threads.recent(10).map((t) => t.threadId)).toEqual(["t1"])
})
test("migrate is idempotent", () => { const db = fresh(); db.migrate(); expect(db.projects.list()).toEqual([]) })
