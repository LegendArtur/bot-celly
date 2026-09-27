import { DatabaseSync } from "node:sqlite"
import type { Project, ProjectStatus, RenderState, ScheduledTask, Thread } from "./types.ts"

export interface Db {
  migrate(): void
  close(): void
  backupTo(dest: string): void
  projects: {
    insertProvisioning(p: Omit<Project, "status" | "lastActiveAt">): void
    setReady(channelId: string, sandboxPath: string): void
    setStatus(channelId: string, s: ProjectStatus): void
    setHostPort(channelId: string, port: number): void
    setServerPassword(channelId: string, password: string): void
    getByChannel(channelId: string): Project | undefined
    getByName(name: string): Project | undefined
    list(): Project[]
    remove(channelId: string): void
    touch(channelId: string, at: number): void
    idleSince(at: number): Project[]
  }
  threads: {
    upsert(t: Thread): void
    get(threadId: string): Thread | undefined
    getBySession(sessionId: string): Thread[]
    setRenderState(threadId: string, s: RenderState): void
    setLiveMessage(threadId: string, messageId: string | null): void
    setLiveMessages(threadId: string, messageIds: string[] | null): void
    liveMessageIds(threadId: string): string[]
    setModel(threadId: string, model: string | null): void
    setAgent(threadId: string, agent: string | null): void
    touch(threadId: string): void
    byChannel(channelId: string): Thread[]
    recent(limit: number): Thread[]
  }
  tasks: {
    add(input: { channelId: string; prompt: string; everyMinutes: number; nextRunAt: number; createdAt: number }): number
    list(): ScheduledTask[]
    remove(id: number): boolean
    due(now: number): ScheduledTask[]
    markRun(id: number, nextRunAt: number): void
    setEnabled(id: number, enabled: boolean): void
  }
  settings: { get(key: string): string | undefined; set(key: string, value: string): void }
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
  directory TEXT NOT NULL, sandbox_path TEXT, sandbox_name TEXT NOT NULL UNIQUE,
  host_port INTEGER NOT NULL UNIQUE, server_password TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES projects(channel_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, title TEXT, model TEXT, agent TEXT, worktree_path TEXT,
  live_message_id TEXT, render_state TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`
const SCHEMA_V2 = `
CREATE TABLE threads_new (
  thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES projects(channel_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, title TEXT, model TEXT, agent TEXT, worktree_path TEXT,
  live_message_id TEXT, render_state TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
INSERT INTO threads_new (thread_id,channel_id,session_id,title,model,agent,worktree_path,live_message_id,render_state,created_at,last_active_at)
  SELECT thread_id,channel_id,session_id,title,model,agent,worktree_path,live_message_id,render_state,created_at,last_active_at FROM threads;
DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;
CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
`
const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, prompt TEXT NOT NULL,
  every_minutes INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
`
const MIGRATIONS: { version: number; up(raw: DatabaseSync): void }[] = [
  { version: 1, up: (raw) => raw.exec(SCHEMA_V1) },
  { version: 2, up: (raw) => raw.exec(SCHEMA_V2) },
  { version: 3, up: (raw) => raw.exec("ALTER TABLE threads ADD COLUMN live_message_ids TEXT") },
  { version: 4, up: (raw) => raw.exec("CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id)") },
  { version: 5, up: (raw) => raw.exec("ALTER TABLE projects ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0") },
  { version: 6, up: (raw) => raw.exec(SCHEMA_V6) },
]
function userVersion(raw: DatabaseSync): number {
  const row = raw.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}
const rowToProject = (r: any): Project => ({
  channelId: r.channel_id, guildId: r.guild_id, name: r.name, directory: r.directory,
  sandboxPath: r.sandbox_path ?? null, sandboxName: r.sandbox_name, hostPort: r.host_port,
  serverPassword: r.server_password, status: r.status, createdAt: r.created_at,
  lastActiveAt: r.last_active_at ?? 0,
})
const rowToThread = (r: any): Thread => ({
  threadId: r.thread_id, channelId: r.channel_id, sessionId: r.session_id, title: r.title,
  model: r.model, agent: r.agent, worktreePath: r.worktree_path ?? null,
  liveMessageId: r.live_message_id ?? null, renderState: r.render_state,
  createdAt: r.created_at, lastActiveAt: r.last_active_at,
})
const rowToTask = (r: any): ScheduledTask => ({
  id: Number(r.id), channelId: r.channel_id, prompt: r.prompt, everyMinutes: r.every_minutes,
  nextRunAt: r.next_run_at, enabled: Number(r.enabled) === 1, createdAt: r.created_at,
})

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path)
  raw.exec("PRAGMA foreign_keys = ON")
  const db: Db = {
    migrate() {
      for (const migration of MIGRATIONS) {
        if (userVersion(raw) >= migration.version) continue
        raw.exec("BEGIN")
        try {
          migration.up(raw)
          raw.exec(`PRAGMA user_version = ${migration.version}`)
          raw.exec("COMMIT")
        } catch (e) {
          raw.exec("ROLLBACK")
          throw e
        }
      }
    },
    close() { raw.close() },
    backupTo(dest) {
      if (!dest || dest.includes("\0")) throw new Error("invalid backup path")
      raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
    },
    projects: {
      insertProvisioning(p) {
        raw.prepare(`INSERT INTO projects (channel_id,guild_id,name,directory,sandbox_path,sandbox_name,host_port,server_password,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,'provisioning',?)`).run(p.channelId,p.guildId,p.name,p.directory,p.sandboxPath,p.sandboxName,p.hostPort,p.serverPassword,p.createdAt)
      },
      setReady(channelId, sandboxPath) { raw.prepare(`UPDATE projects SET status='ready', sandbox_path=? WHERE channel_id=?`).run(sandboxPath, channelId) },
      setStatus(channelId, s) { raw.prepare(`UPDATE projects SET status=? WHERE channel_id=?`).run(s, channelId) },
      setHostPort(channelId, port) { raw.prepare(`UPDATE projects SET host_port=? WHERE channel_id=?`).run(port, channelId) },
      setServerPassword(channelId, password) { raw.prepare(`UPDATE projects SET server_password=? WHERE channel_id=?`).run(password, channelId) },
      getByChannel(channelId) { const r = raw.prepare(`SELECT * FROM projects WHERE channel_id=?`).get(channelId); return r ? rowToProject(r) : undefined },
      getByName(name) { const r = raw.prepare(`SELECT * FROM projects WHERE name=?`).get(name); return r ? rowToProject(r) : undefined },
      list() { return raw.prepare(`SELECT * FROM projects ORDER BY created_at`).all().map(rowToProject) },
      remove(channelId) { raw.prepare(`DELETE FROM projects WHERE channel_id=?`).run(channelId) },
      touch(channelId, at) { raw.prepare(`UPDATE projects SET last_active_at=? WHERE channel_id=?`).run(at, channelId) },
      idleSince(at) { return raw.prepare(`SELECT * FROM projects WHERE last_active_at <= ? ORDER BY last_active_at, created_at`).all(at).map(rowToProject) },
    },
    threads: {
      upsert(t) {
        raw.prepare(`INSERT INTO threads (thread_id,channel_id,session_id,title,model,agent,worktree_path,live_message_id,render_state,created_at,last_active_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET session_id=excluded.session_id, title=excluded.title, model=excluded.model, agent=excluded.agent, last_active_at=excluded.last_active_at`)
          .run(t.threadId,t.channelId,t.sessionId,t.title,t.model,t.agent,t.worktreePath,t.liveMessageId,t.renderState,t.createdAt,t.lastActiveAt)
      },
      get(threadId) { const r = raw.prepare(`SELECT * FROM threads WHERE thread_id=?`).get(threadId); return r ? rowToThread(r) : undefined },
      getBySession(sessionId) { return raw.prepare(`SELECT * FROM threads WHERE session_id=? ORDER BY last_active_at DESC`).all(sessionId).map(rowToThread) },
      setRenderState(threadId, s) { raw.prepare(`UPDATE threads SET render_state=? WHERE thread_id=?`).run(s, threadId) },
      setLiveMessage(threadId, m) { raw.prepare(`UPDATE threads SET live_message_id=? WHERE thread_id=?`).run(m, threadId) },
      setLiveMessages(threadId, ids) { raw.prepare(`UPDATE threads SET live_message_ids=? WHERE thread_id=?`).run(ids && ids.length ? JSON.stringify(ids) : null, threadId) },
      liveMessageIds(threadId) {
        const row = raw.prepare(`SELECT live_message_id, live_message_ids FROM threads WHERE thread_id=?`).get(threadId) as any
        if (!row) return []
        if (typeof row.live_message_ids === "string" && row.live_message_ids) {
          try {
            const parsed = JSON.parse(row.live_message_ids)
            if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === "string")
          } catch {}
        }
        return typeof row.live_message_id === "string" && row.live_message_id ? [row.live_message_id] : []
      },
      setModel(threadId, model) { raw.prepare(`UPDATE threads SET model=? WHERE thread_id=?`).run(model, threadId) },
      setAgent(threadId, agent) { raw.prepare(`UPDATE threads SET agent=? WHERE thread_id=?`).run(agent, threadId) },
      touch(threadId) { raw.prepare(`UPDATE threads SET last_active_at=? WHERE thread_id=?`).run(Date.now(), threadId) },
      byChannel(channelId) { return raw.prepare(`SELECT * FROM threads WHERE channel_id=? ORDER BY last_active_at DESC`).all(channelId).map(rowToThread) },
      recent(limit) { return raw.prepare(`SELECT * FROM threads ORDER BY last_active_at DESC LIMIT ?`).all(limit).map(rowToThread) },
    },
    tasks: {
      add(input) {
        const info = raw.prepare(`INSERT INTO scheduled_tasks (channel_id,prompt,every_minutes,next_run_at,enabled,created_at)
          VALUES (?,?,?,?,1,?)`).run(input.channelId, input.prompt, input.everyMinutes, input.nextRunAt, input.createdAt)
        return Number(info.lastInsertRowid)
      },
      list() { return raw.prepare(`SELECT * FROM scheduled_tasks ORDER BY id`).all().map(rowToTask) },
      remove(id) { return Number(raw.prepare(`DELETE FROM scheduled_tasks WHERE id=?`).run(id).changes) > 0 },
      due(now) { return raw.prepare(`SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at`).all(now).map(rowToTask) },
      markRun(id, nextRunAt) { raw.prepare(`UPDATE scheduled_tasks SET next_run_at=? WHERE id=?`).run(nextRunAt, id) },
      setEnabled(id, enabled) { raw.prepare(`UPDATE scheduled_tasks SET enabled=? WHERE id=?`).run(enabled ? 1 : 0, id) },
    },
    settings: {
      get(key) { const r = raw.prepare(`SELECT value FROM settings WHERE key=?`).get(key); return r ? (r as any).value : undefined },
      set(key, value) { raw.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value) },
    },
  }
  return db
}
