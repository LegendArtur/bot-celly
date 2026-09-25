// test/db.test.ts
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"

function fresh() { const db = openDb(":memory:"); db.migrate(); return db }
const proj = { channelId: "c1", guildId: "g1", name: "demo", directory: "C:\\p\\demo",
  sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 }

test("inserts, reads, and enforces unique name/port", () => {
  const db = fresh()
  db.projects.insertProvisioning(proj)
  expect(db.projects.getByChannel("c1")?.sandboxName).toBe("celly-demo")
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
test("persists the ordered live message ids and falls back to the single id", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const row = { threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 }
  db.threads.upsert(row)
  expect(db.threads.liveMessageIds("t1")).toEqual([])
  db.threads.setLiveMessage("t1", "m2")
  expect(db.threads.liveMessageIds("t1")).toEqual(["m2"])
  db.threads.setLiveMessages("t1", ["m1", "m2"])
  expect(db.threads.liveMessageIds("t1")).toEqual(["m1", "m2"])
  db.threads.setLiveMessages("t1", [])
  expect(db.threads.liveMessageIds("t1")).toEqual(["m2"])
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
test("v2 migration repairs a pre-cascade threads table", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-db-"))
  const file = join(dir, "bot.db")
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL, sandbox_path TEXT, sandbox_name TEXT NOT NULL UNIQUE,
        host_port INTEGER NOT NULL UNIQUE, server_password TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES projects(channel_id),
        session_id TEXT NOT NULL, title TEXT, model TEXT, agent TEXT, worktree_path TEXT,
        live_message_id TEXT, render_state TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
      INSERT INTO projects (channel_id,guild_id,name,directory,sandbox_path,sandbox_name,host_port,server_password,status,created_at)
        VALUES ('c1','g','demo','C:\\p',NULL,'celly-demo',4300,'pw','ready',1);
      INSERT INTO threads (thread_id,channel_id,session_id,title,model,agent,worktree_path,live_message_id,render_state,created_at,last_active_at)
        VALUES ('t1','c1','s1',NULL,NULL,NULL,NULL,NULL,'idle',1,1);
    `)
    const before = legacy.prepare("PRAGMA foreign_key_list(threads)").all() as any[]
    expect(before.some((r) => r.on_delete === "NO ACTION")).toBe(true)
    legacy.close()

    const db = openDb(file)
    db.migrate()
    expect(db.threads.get("t1")?.sessionId).toBe("s1")
    expect(db.threads.liveMessageIds("t1")).toEqual([])
    db.projects.remove("c1")
    expect(db.threads.get("t1")).toBeUndefined()
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test("removing a project cascades to its threads", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.projects.remove("c1")
  expect(db.projects.getByChannel("c1")).toBeUndefined()
  expect(db.threads.get("t1")).toBeUndefined()
})
