// src/worktrees.ts

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
