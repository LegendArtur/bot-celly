// test/db.test.ts
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"
import { freshDb, projectFixture } from "./helpers/fixtures.ts"
import { withTempDir } from "./helpers/tmp.ts"

const proj = projectFixture({ channelId: "c1", guildId: "g1", directory: "C:\\p\\demo" })

test("inserts, reads, and enforces unique name/port", () => {
  const db = freshDb()
  db.projects.insertProvisioning(proj)
  expect(db.projects.getByChannel("c1")?.sandboxName).toBe("celly-demo")
  expect(db.projects.getByName("demo")?.channelId).toBe("c1")
  expect(() => db.projects.insertProvisioning({ ...proj, channelId: "c2" })).toThrow()
})
test("updates status and sandbox path", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.projects.setReady("c1", "C:\\Users\\artur\\projects\\demo")
  expect(db.projects.getByChannel("c1")).toMatchObject({ status: "ready", sandboxPath: "C:\\Users\\artur\\projects\\demo" })
})
test("threads store render state and filter by activity", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.setRenderState("t1", "running"); db.threads.setLiveMessage("t1", "m1")
  expect(db.threads.get("t1")).toMatchObject({ renderState: "running", liveMessageId: "m1" })
  expect(db.threads.recent(10).map((t) => t.threadId)).toEqual(["t1"])
})
test("persists the ordered live message ids and falls back to the single id", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  const row = { threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
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
  const db = freshDb(); db.projects.insertProvisioning(proj)
  const row = { threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 }
  db.threads.upsert(row)
  db.threads.upsert({ ...row, sessionId: "s2", lastActiveAt: 9 })
  expect(db.threads.get("t1")).toMatchObject({ sessionId: "s2", lastActiveAt: 9 })
})
test("updates per-thread model and agent overrides", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.setModel("t1", "anthropic/claude")
  db.threads.setAgent("t1", "build")
  expect(db.threads.get("t1")).toMatchObject({ model: "anthropic/claude", agent: "build" })
  db.threads.setModel("t1", null)
  expect(db.threads.get("t1")?.model).toBeNull()
})
test("updates the per-thread thinking depth", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.setVariant("t1", "high")
  expect(db.threads.get("t1")?.variant).toBe("high")
  db.threads.setVariant("t1", null)
  expect(db.threads.get("t1")?.variant).toBeNull()
})
test("stores the origin message id and the archive notice timestamp", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  expect(db.threads.get("t1")?.originMessageId).toBeNull()
  expect(db.threads.get("t1")?.archiveNoticeAt).toBeNull()
  db.threads.setOriginMessage("t1", "m1")
  db.threads.setArchiveNotice("t1", 123)
  expect(db.threads.get("t1")).toMatchObject({ originMessageId: "m1", archiveNoticeAt: 123 })
})

test("prune rolls the thread's usage into channel totals and deletes the row", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.addUsage("t1", { cost: 0.5, tokensIn: 10, tokensOut: 2, cacheRead: 3, cacheWrite: 4 })
  expect(db.threads.prune("t1")).toBe(true)
  expect(db.threads.get("t1")).toBeUndefined()
  expect(db.usage.channel("c1")).toEqual({ cost: 0.5, tokensIn: 10, tokensOut: 2, cacheRead: 3, cacheWrite: 4 })
  expect(db.usage.totals()).toMatchObject({ cost: 0.5, tokensIn: 10, tokensOut: 2, cacheRead: 3, cacheWrite: 4 })
})

test("prune on an unknown thread is a no-op", () => {
  const db = freshDb()
  expect(db.threads.prune("nope")).toBe(false)
})

test("setWorktree stores and clears the thread worktree path", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.setWorktree("t1", "/sandbox/celly-demo/workspace/.celly/worktrees/t1")
  expect(db.threads.get("t1")?.worktreePath).toBe("/sandbox/celly-demo/workspace/.celly/worktrees/t1")
  db.threads.setWorktree("t1", null)
  expect(db.threads.get("t1")?.worktreePath).toBeNull()
})
test("migrate is idempotent", () => { const db = freshDb(); db.migrate(); expect(db.projects.list()).toEqual([]) })
test("v2 migration repairs a pre-cascade threads table", async () => {
  await withTempDir("celly-db-", (dir) => {
    const file = join(dir, "bot.db")
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
  })
})
test("removing a project cascades to its threads", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.projects.remove("c1")
  expect(db.projects.getByChannel("c1")).toBeUndefined()
  expect(db.threads.get("t1")).toBeUndefined()
})
test("v4 adds an index on threads.channel_id", async () => {
  await withTempDir("celly-db-index-", (dir) => {
    const file = join(dir, "bot.db")
    const db = openDb(file)
    db.migrate()
    db.close()
    const raw = new DatabaseSync(file)
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='threads'").all() as any[]).map((r) => r.name)
    expect(names).toContain("idx_threads_channel")
    raw.close()
  })
})

test("touch and idleSince expose per-project activity", () => {
  const db = freshDb()
  db.projects.insertProvisioning(proj)
  db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "demo2", sandboxName: "celly-demo-2", hostPort: 4301 })
  expect(db.projects.getByChannel("c1")?.lastActiveAt).toBe(0)
  expect(db.projects.idleSince(0).map((p) => p.channelId).sort()).toEqual(["c1", "c2"])
  db.projects.touch("c2", 500)
  db.projects.touch("c1", 100)
  expect(db.projects.getByChannel("c2")?.lastActiveAt).toBe(500)
  expect(db.projects.getByChannel("c1")?.lastActiveAt).toBe(100)
  expect(db.projects.idleSince(200).map((p) => p.channelId)).toEqual(["c1"])
  expect(db.projects.idleSince(99)).toEqual([])
})

test("a v4 database upgrades with a zeroed projects.last_active_at", async () => {
  await withTempDir("celly-db-idle-", (dir) => {
    const file = join(dir, "bot.db")
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE projects (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL, sandbox_path TEXT, sandbox_name TEXT NOT NULL UNIQUE,
        host_port INTEGER NOT NULL UNIQUE, server_password TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL, title TEXT, model TEXT, agent TEXT, worktree_path TEXT,
        live_message_id TEXT, render_state TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, live_message_ids TEXT);
      PRAGMA user_version = 4;
      INSERT INTO projects (channel_id,guild_id,name,directory,sandbox_path,sandbox_name,host_port,server_password,status,created_at)
        VALUES ('c1','g','demo','C:\\p',NULL,'celly-demo',4300,'pw','ready',1);
    `)
    legacy.close()

    const db = openDb(file)
    db.migrate()
    expect(db.projects.getByChannel("c1")?.lastActiveAt).toBe(0)
    db.projects.touch("c1", 42)
    expect(db.projects.idleSince(42).map((p) => p.channelId)).toEqual(["c1"])
    expect(db.projects.idleSince(41)).toEqual([])
    db.close()
  })
})

test("scheduled_tasks CRUD round-trips and filters due tasks", () => {
  const db = freshDb()
  const id = db.tasks.add({ channelId: "c1", prompt: "standup", everyMinutes: 60, nextRunAt: 1000, createdAt: 1 })
  expect(id).toBeGreaterThan(0)
  expect(db.tasks.list()).toMatchObject([{ id, channelId: "c1", prompt: "standup", everyMinutes: 60, nextRunAt: 1000, enabled: true, createdAt: 1 }])
  expect(db.tasks.due(999)).toEqual([])
  expect(db.tasks.due(1000).map((t) => t.id)).toEqual([id])
  db.tasks.setEnabled(id, false)
  expect(db.tasks.due(2000)).toEqual([])
  db.tasks.setEnabled(id, true)
  db.tasks.markRun(id, 5000)
  expect(db.tasks.due(4000)).toEqual([])
  expect(db.tasks.due(5000).map((t) => t.id)).toEqual([id])
  expect(db.tasks.remove(id)).toBe(true)
  expect(db.tasks.remove(id)).toBe(false)
  expect(db.tasks.list()).toEqual([])
})

test("the appended migration adds scheduled_tasks to an older database", async () => {
  await withTempDir("celly-db-tasks-", (dir) => {
    const file = join(dir, "bot.db")
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE projects (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL, sandbox_path TEXT, sandbox_name TEXT NOT NULL UNIQUE,
        host_port INTEGER NOT NULL UNIQUE, server_password TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL, title TEXT, model TEXT, agent TEXT, worktree_path TEXT,
        live_message_id TEXT, render_state TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, live_message_ids TEXT);
      PRAGMA user_version = 4;
    `)
    legacy.close()
    const db = openDb(file)
    db.migrate()
    const id = db.tasks.add({ channelId: "c1", prompt: "p", everyMinutes: 1, nextRunAt: 0, createdAt: 0 })
    expect(db.tasks.list().map((t) => t.id)).toEqual([id])
    db.close()
  })
})

test("addUsage accumulates per-thread totals", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  expect(db.usage.thread("t1")).toEqual({ cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })
  db.threads.addUsage("t1", { cost: 0.5, tokensIn: 10, tokensOut: 2, cacheRead: 3, cacheWrite: 4 })
  db.threads.addUsage("t1", { cost: 0.25, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  expect(db.usage.thread("t1")).toEqual({ cost: 0.75, tokensIn: 11, tokensOut: 3, cacheRead: 3, cacheWrite: 4 })
})

test("usage aggregates per channel and across all threads", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.addUsage("t1", { cost: 0.1, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "other", sandboxName: "celly-other", hostPort: 4301 })
  db.threads.upsert({ threadId: "t2", channelId: "c2", sessionId: "s2", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.addUsage("t2", { cost: 0.2, tokensIn: 2, tokensOut: 2, cacheRead: 0, cacheWrite: 0 })
  expect(db.usage.channel("c1")).toEqual({ cost: 0.1, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 })
  expect(db.usage.channel("c2").tokensIn).toBe(2)
  const totals = db.usage.totals()
  expect(totals.cost).toBeCloseTo(0.3)
  expect(totals.tokensIn).toBe(3)
  expect(totals.tokensOut).toBe(3)
})

test("thread upsert preserves accumulated usage", () => {
  const db = freshDb(); db.projects.insertProvisioning(proj)
  const row = { threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 }
  db.threads.upsert(row)
  db.threads.addUsage("t1", { cost: 0.4, tokensIn: 4, tokensOut: 4, cacheRead: 0, cacheWrite: 0 })
  db.threads.upsert({ ...row, sessionId: "s2", lastActiveAt: 9 })
  expect(db.usage.thread("t1").cost).toBe(0.4)
  expect(db.usage.thread("t1").tokensIn).toBe(4)
})
