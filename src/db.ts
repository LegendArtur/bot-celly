import { DatabaseSync } from "node:sqlite"
import type { Project, ProjectStatus, RenderState, Thread } from "./types.ts"

export interface Db {
  migrate(): void
  close(): void
  projects: {
    insertProvisioning(p: Omit<Project, "status">): void
    setReady(channelId: string, sandboxPath: string): void
    setStatus(channelId: string, s: ProjectStatus): void
    getByChannel(channelId: string): Project | undefined
    getByName(name: string): Project | undefined
    list(): Project[]
    remove(channelId: string): void
  }
  threads: {
    upsert(t: Thread): void
    get(threadId: string): Thread | undefined
    getBySession(sessionId: string): Thread[]
    setRenderState(threadId: string, s: RenderState): void
    setLiveMessage(threadId: string, messageId: string | null): void
    touch(threadId: string): void
    byChannel(channelId: string): Thread[]
    recent(limit: number): Thread[]
  }
  settings: { get(key: string): string | undefined; set(key: string, value: string): void }
}

const SCHEMA = `
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
const rowToProject = (r: any): Project => ({
  channelId: r.channel_id, guildId: r.guild_id, name: r.name, directory: r.directory,
  sandboxPath: r.sandbox_path ?? null, sandboxName: r.sandbox_name, hostPort: r.host_port,
  serverPassword: r.server_password, status: r.status, createdAt: r.created_at,
})
const rowToThread = (r: any): Thread => ({
  threadId: r.thread_id, channelId: r.channel_id, sessionId: r.session_id, title: r.title,
  model: r.model, agent: r.agent, worktreePath: r.worktree_path ?? null,
  liveMessageId: r.live_message_id ?? null, renderState: r.render_state,
  createdAt: r.created_at, lastActiveAt: r.last_active_at,
})

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path)
  raw.exec("PRAGMA foreign_keys = ON")
  const db: Db = {
    migrate() { raw.exec(SCHEMA); raw.exec("PRAGMA user_version = 1") },
    close() { raw.close() },
    projects: {
      insertProvisioning(p) {
        raw.prepare(`INSERT INTO projects (channel_id,guild_id,name,directory,sandbox_path,sandbox_name,host_port,server_password,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,'provisioning',?)`).run(p.channelId,p.guildId,p.name,p.directory,p.sandboxPath,p.sandboxName,p.hostPort,p.serverPassword,p.createdAt)
      },
      setReady(channelId, sandboxPath) { raw.prepare(`UPDATE projects SET status='ready', sandbox_path=? WHERE channel_id=?`).run(sandboxPath, channelId) },
      setStatus(channelId, s) { raw.prepare(`UPDATE projects SET status=? WHERE channel_id=?`).run(s, channelId) },
      getByChannel(channelId) { const r = raw.prepare(`SELECT * FROM projects WHERE channel_id=?`).get(channelId); return r ? rowToProject(r) : undefined },
      getByName(name) { const r = raw.prepare(`SELECT * FROM projects WHERE name=?`).get(name); return r ? rowToProject(r) : undefined },
      list() { return raw.prepare(`SELECT * FROM projects ORDER BY created_at`).all().map(rowToProject) },
      remove(channelId) { raw.prepare(`DELETE FROM projects WHERE channel_id=?`).run(channelId) },
    },
    threads: {
      upsert(t) {
        raw.prepare(`INSERT INTO threads (thread_id,channel_id,session_id,title,model,agent,worktree_path,live_message_id,render_state,created_at,last_active_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET title=excluded.title, model=excluded.model, agent=excluded.agent, last_active_at=excluded.last_active_at`)
          .run(t.threadId,t.channelId,t.sessionId,t.title,t.model,t.agent,t.worktreePath,t.liveMessageId,t.renderState,t.createdAt,t.lastActiveAt)
      },
      get(threadId) { const r = raw.prepare(`SELECT * FROM threads WHERE thread_id=?`).get(threadId); return r ? rowToThread(r) : undefined },
      getBySession(sessionId) { return raw.prepare(`SELECT * FROM threads WHERE session_id=? ORDER BY last_active_at DESC`).all(sessionId).map(rowToThread) },
      setRenderState(threadId, s) { raw.prepare(`UPDATE threads SET render_state=? WHERE thread_id=?`).run(s, threadId) },
      setLiveMessage(threadId, m) { raw.prepare(`UPDATE threads SET live_message_id=? WHERE thread_id=?`).run(m, threadId) },
      touch(threadId) { raw.prepare(`UPDATE threads SET last_active_at=? WHERE thread_id=?`).run(Date.now(), threadId) },
      byChannel(channelId) { return raw.prepare(`SELECT * FROM threads WHERE channel_id=? ORDER BY last_active_at DESC`).all(channelId).map(rowToThread) },
      recent(limit) { return raw.prepare(`SELECT * FROM threads ORDER BY last_active_at DESC LIMIT ?`).all(limit).map(rowToThread) },
    },
    settings: {
      get(key) { const r = raw.prepare(`SELECT value FROM settings WHERE key=?`).get(key); return r ? (r as any).value : undefined },
      set(key, value) { raw.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value) },
    },
  }
  return db
}
