import { openDb } from "../../src/db.ts"
import type { Db } from "../../src/db.ts"
import type { Project, Thread } from "../../src/types.ts"

export function freshDb(): Db {
  const db = openDb(":memory:")
  db.migrate()
  return db
}

export function projectFixture(over: Partial<Project> = {}): Project {
  return {
    channelId: "c", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null,
    sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", status: "provisioning", createdAt: 1,
    ...over,
  }
}

export function threadRow(over: Partial<Thread> = {}): Thread {
  return {
    threadId: "t1", channelId: "c", sessionId: "s1", title: "hello", model: null, agent: null, variant: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1,
    ...over,
  }
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as any
