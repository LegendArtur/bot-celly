import { expect, test } from "vitest"
import { createTaskRunner } from "../src/tasks.ts"
import { freshDb, projectFixture, threadRow } from "./helpers/fixtures.ts"

function setup() {
  const db = freshDb()
  db.projects.insertProvisioning(projectFixture({ channelId: "c1" }))
  return db
}

test("tick prompts the most recent thread for each due task and advances next_run_at", async () => {
  const db = setup()
  db.threads.upsert(threadRow({ threadId: "t-old", channelId: "c1", sessionId: "s-t-old", title: null, lastActiveAt: 10 }))
  db.threads.upsert(threadRow({ threadId: "t-new", channelId: "c1", sessionId: "s-t-new", title: null, lastActiveAt: 20 }))
  const id = db.tasks.add({ channelId: "c1", prompt: "standup", everyMinutes: 60, nextRunAt: 1_000, createdAt: 1 })
  const prompts: Array<[string, string, string]> = []
  const now = 1_500
  const runner = createTaskRunner({ db, now: () => now, everyMs: 0,
    prompt: async (threadId, text, actor) => { prompts.push([threadId, text, actor]); return undefined },
    ensureThread: async () => { throw new Error("ensureThread should not be called") } })
  await runner.tick()
  expect(prompts).toEqual([["t-new", "standup", "task"]])
  expect(db.tasks.list()[0]?.nextRunAt).toBe(now + 60 * 60_000)
  expect(db.tasks.list()[0]?.id).toBe(id)
})

test("tick records a run audit entry for each due task", async () => {
  const db = setup()
  db.threads.upsert(threadRow({ threadId: "t1", channelId: "c1", sessionId: "s-t1", title: null, lastActiveAt: 10 }))
  db.tasks.add({ channelId: "c1", prompt: "standup", everyMinutes: 60, nextRunAt: 0, createdAt: 1 })
  const entries: any[] = []
  const runner = createTaskRunner({ db, now: () => 100, everyMs: 0,
    prompt: async () => undefined,
    ensureThread: async () => "t1",
    audit: (entry) => entries.push(entry) })
  await runner.tick()
  expect(entries).toEqual([{ kind: "task", channelId: "c1", threadId: "t1", actorId: "scheduler", detail: "standup", decision: "run" }])
})

test("tick truncates the audited prompt detail to 200 chars", async () => {
  const db = setup()
  db.threads.upsert(threadRow({ threadId: "t1", channelId: "c1", sessionId: "s-t1", title: null, lastActiveAt: 10 }))
  const prompt = "x".repeat(500)
  db.tasks.add({ channelId: "c1", prompt, everyMinutes: 60, nextRunAt: 0, createdAt: 1 })
  const entries: any[] = []
  const runner = createTaskRunner({ db, now: () => 100, everyMs: 0,
    prompt: async () => undefined,
    ensureThread: async () => "t1",
    audit: (entry) => entries.push(entry) })
  await runner.tick()
  expect(entries[0]?.detail).toHaveLength(200)
})

test("tick skips disabled and not-yet-due tasks", async () => {
  const db = setup()
  const id = db.tasks.add({ channelId: "c1", prompt: "later", everyMinutes: 5, nextRunAt: 10_000, createdAt: 1 })
  db.tasks.setEnabled(id, false)
  const prompts: string[] = []
  const runner = createTaskRunner({ db, now: () => 20_000, everyMs: 0,
    prompt: async () => { prompts.push("x"); return undefined },
    ensureThread: async () => "t1" })
  await runner.tick()
  expect(prompts).toEqual([])
})

test("tick creates a thread when the channel has none", async () => {
  const db = setup()
  db.tasks.add({ channelId: "c1", prompt: "kickoff", everyMinutes: 1, nextRunAt: 0, createdAt: 1 })
  const prompts: string[] = []
  const runner = createTaskRunner({ db, now: () => 1, everyMs: 0,
    prompt: async (threadId) => { prompts.push(threadId); return undefined },
    ensureThread: async (channelId) => `new-${channelId}` })
  await runner.tick()
  expect(prompts).toEqual(["new-c1"])
})

test("a failing prompt is logged and leaves next_run_at unchanged for retry", async () => {
  const db = setup()
  const id = db.tasks.add({ channelId: "c1", prompt: "flaky", everyMinutes: 5, nextRunAt: 0, createdAt: 1 })
  const warnings: string[] = []
  const runner = createTaskRunner({ db, now: () => 100, everyMs: 0,
    prompt: async () => { throw new Error("boom") },
    ensureThread: async () => "t1",
    log: { warn: (message) => { warnings.push(message) } } })
  await runner.tick()
  expect(warnings).toEqual(["scheduled task failed"])
  expect(db.tasks.list()[0]?.id).toBe(id)
  expect(db.tasks.list()[0]?.nextRunAt).toBe(0)
})
