// src/worktrees.ts
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { joinPathLike } from "./sbx.js"
import type { Sbx } from "./sbx.js"
import type { Db } from "./db.ts"
import type { Project, Thread } from "./types.ts"

export function worktreeSlug(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const slug = cleaned.slice(0, 30).replace(/-+$/g, "")
  return slug || "work"
}

export function worktreeBranch(threadId: string): string {
  const cleaned = threadId.toLowerCase().replace(/[^a-z0-9]/g, "")
  return `celly/${cleaned.slice(-8) || "work"}`
}

export interface WorktreeEntry { path: string; branch?: string }

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  const flush = (): void => { if (current) { entries.push(current); current = undefined } }
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (line === "") { flush(); continue }
    if (line.startsWith("worktree ")) { flush(); current = { path: line.slice("worktree ".length).trim() }; continue }
    if (line.startsWith("branch ") && current) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
  }
  flush()
  return entries
}

export function parseStatusPorcelain(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(2).trim())
    .filter((file) => file.length > 0)
}

export function mergeOutcome(stdout: string, stderr: string, code: number): { ok: boolean; conflicts: string[] } {
  const conflicts = new Set<string>()
  for (const raw of `${stdout}\n${stderr}`.split("\n")) {
    const line = raw.trim()
    const conflict = /^CONFLICT \([^)]*\):\s+(?:Merge conflict in |Rename conflict in )?(.+?)(?:\s+(?:deleted|modified|renamed|added) in .*)?$/.exec(line)
    if (conflict?.[1]) conflicts.add(conflict[1].trim())
    const both = /^both modified:\s+(.+)$/.exec(line)
    if (both?.[1]) conflicts.add(both[1].trim())
  }
  return { ok: code === 0, conflicts: [...conflicts] }
}

export function ensureGitignoreEntry(directory: string, onWarn: (message: string, fields?: Record<string, unknown>) => void): void {
  const file = join(directory, ".gitignore")
  try {
    let current = ""
    try { current = readFileSync(file, "utf8") } catch {}
    if (current.split(/\r?\n/).some((line) => line.trim() === ".celly/" || line.trim() === ".celly")) return
    const separator = current === "" || current.endsWith("\n") ? "" : "\n"
    appendFileSync(file, `${separator}.celly/\n`)
  } catch (e) {
    onWarn("could not append .celly/ to .gitignore; continuing", { directory, error: String(e) })
  }
}

export interface WorktreeLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}
export interface WorktreeDeps { sbx: Sbx; db: Db; log: WorktreeLog }

export class WorktreeService {
  constructor(private readonly deps: WorktreeDeps) {}

  private lookup(threadId: string): { thread: Thread; project: Project } {
    const thread = this.deps.db.threads.get(threadId)
    if (!thread) throw new Error(`unknown thread ${threadId}`)
    const project = this.deps.db.projects.getByChannel(thread.channelId)
    if (!project) throw new Error(`unknown project for thread ${threadId}`)
    return { thread, project }
  }

  async create(threadId: string, name?: string): Promise<string> {
    const { thread, project } = this.lookup(threadId)
    if (thread.worktreePath) throw new Error(`this thread already has a worktree at ${thread.worktreePath}`)
    if (!project.sandboxPath) throw new Error("project sandbox path is not resolved; run /project wake")
    const branch = name ? `celly/${worktreeSlug(name)}` : worktreeBranch(threadId)
    const slug = branch.slice("celly/".length)
    const relative = `.celly/worktrees/${slug}`
    ensureGitignoreEntry(project.directory, (message, fields) => this.deps.log.warn(message, fields))
    await this.deps.sbx.exec(project.sandboxName, ["git", "-C", project.sandboxPath, "worktree", "add", "-b", branch, relative, "HEAD"], { timeoutMs: 120_000 })
    const worktreePath = joinPathLike(project.sandboxPath, relative)
    this.deps.db.threads.setWorktree(threadId, worktreePath)
    this.deps.log.info("worktree created", { threadId, worktreePath, branch })
    return `created worktree ${worktreePath} (branch ${branch})`
  }

  async status(threadId: string): Promise<string> {
    const { thread, project } = this.lookup(threadId)
    if (!thread.worktreePath) return "no worktree for this thread; run /worktree new [name]"
    if (!project.sandboxPath) return `worktree: ${thread.worktreePath}\nstatus: unknown (sandbox path not resolved)`
    const listed = await this.deps.sbx.exec(project.sandboxName, ["git", "-C", project.sandboxPath, "worktree", "list", "--porcelain"], { timeoutMs: 30_000 })
    const entry = parseWorktreeList(listed.stdout).find((w) => w.path === thread.worktreePath)
    const dirty = parseStatusPorcelain((await this.deps.sbx.exec(project.sandboxName, ["git", "-C", thread.worktreePath, "status", "--porcelain"], { timeoutMs: 30_000 })).stdout)
    const branch = entry?.branch ? ` (branch ${entry.branch})` : " (branch unknown)"
    return `worktree: ${thread.worktreePath}${branch}\nstatus: ${dirty.length ? `dirty (${dirty.length} changed)` : "clean"}`
  }

  async merge(threadId: string): Promise<string> {
    const { thread, project } = this.lookup(threadId)
    if (!thread.worktreePath) throw new Error("no worktree for this thread")
    if (!project.sandboxPath) throw new Error("project sandbox path is not resolved; run /project wake")
    const root = project.sandboxPath
    const listed = await this.deps.sbx.exec(project.sandboxName, ["git", "-C", root, "worktree", "list", "--porcelain"], { timeoutMs: 30_000 })
    const branch = parseWorktreeList(listed.stdout).find((w) => w.path === thread.worktreePath)?.branch
    if (!branch) throw new Error("worktree is not registered with git; run /worktree status")
    const worktreeDirty = parseStatusPorcelain((await this.deps.sbx.exec(project.sandboxName, ["git", "-C", thread.worktreePath, "status", "--porcelain"], { timeoutMs: 30_000 })).stdout)
    if (worktreeDirty.length) return `worktree has uncommitted changes:\n${worktreeDirty.map((f) => `- ${f}`).join("\n")}`
    const rootDirty = parseStatusPorcelain((await this.deps.sbx.exec(project.sandboxName, ["git", "-C", root, "status", "--porcelain"], { timeoutMs: 30_000 })).stdout)
    if (rootDirty.length) return `project root has uncommitted changes:\n${rootDirty.map((f) => `- ${f}`).join("\n")}`
    const result = await this.deps.sbx.execResult(project.sandboxName, ["git", "-C", root, "merge", "--no-ff", branch], { timeoutMs: 120_000 })
    const outcome = mergeOutcome(result.stdout, result.stderr, result.code)
    if (outcome.ok) return `merged ${branch} into the project root`
    if (outcome.conflicts.length) {
      return `merge conflicts in:\n${outcome.conflicts.map((f) => `- ${f}`).join("\n")}\nresolve them in the sandbox and commit, then run /worktree merge again`
    }
    const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? `exit ${result.code}`
    throw new Error(`merge failed (${result.code}): ${detail}`)
  }

  async remove(threadId: string, force: boolean): Promise<string> {
    const { thread, project } = this.lookup(threadId)
    if (!thread.worktreePath) throw new Error("no worktree for this thread")
    if (!project.sandboxPath) throw new Error("project sandbox path is not resolved; run /project wake")
    const worktreePath = thread.worktreePath
    const args = ["git", "-C", project.sandboxPath, "worktree", "remove", ...(force ? ["--force"] : []), worktreePath]
    const result = await this.deps.sbx.execResult(project.sandboxName, args, { timeoutMs: 120_000 })
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? `exit ${result.code}`
      if (!force) return `cannot remove worktree: ${detail} (use /worktree remove force:true to discard changes)`
      throw new Error(`git worktree remove failed: ${detail}`)
    }
    this.deps.db.threads.setWorktree(threadId, null)
    return `removed ${worktreePath}`
  }
}
