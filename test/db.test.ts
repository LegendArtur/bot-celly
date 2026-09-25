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
test("upsert updates the session id on conflict", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const row = { threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 }
  db.threads.upsert(row)
  db.threads.upsert({ ...row, sessionId: "s2", lastActiveAt: 9 })
  expect(db.threads.get("t1")).toMatchObject({ sessionId: "s2", lastActiveAt: 9 })
})
test("updates per-thread model and agent overrides", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.setModel("t1", "anthropic/claude")
  db.threads.setAgent("t1", "build")
  expect(db.threads.get("t1")).toMatchObject({ model: "anthropic/claude", agent: "build" })
  db.threads.setModel("t1", null)
  expect(db.threads.get("t1")?.model).toBeNull()
})
test("migrate is idempotent", () => { const db = fresh(); db.migrate(); expect(db.projects.list()).toEqual([]) })
test("removing a project cascades to its threads", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.projects.remove("c1")
  expect(db.projects.getByChannel("c1")).toBeUndefined()
  expect(db.threads.get("t1")).toBeUndefined()
})
