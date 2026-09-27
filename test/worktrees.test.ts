// test/worktrees.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"
import { ensureGitignoreEntry, mergeOutcome, parseStatusPorcelain, parseWorktreeList, WorktreeService, worktreeBranch, worktreeSlug } from "../src/worktrees.ts"

test("worktreeSlug lowercases, collapses separators, and caps the length", () => {
  expect(worktreeSlug("My Feature!! / v2")).toBe("my-feature-v2")
  expect(worktreeSlug("")).toBe("work")
  expect(worktreeSlug("---")).toBe("work")
  expect(worktreeSlug("a".repeat(60)).length).toBeLessThanOrEqual(30)
})

test("worktreeBranch uses the trailing eight alphanumerics of the thread id", () => {
  expect(worktreeBranch("!!thread-42!!")).toBe("celly/thread42")
  expect(worktreeBranch("123456789012345678")).toBe("celly/12345678")
  expect(worktreeBranch("")).toBe("celly/work")
})

test("parseWorktreeList reads porcelain records and strips refs/heads", () => {
  const porcelain = [
    "worktree /sandbox/celly-demo/workspace",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /sandbox/celly-demo/workspace/.celly/worktrees/my-feature",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/celly/my-feature",
    "",
    "worktree /sandbox/celly-demo/workspace/.celly/worktrees/detached",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "",
  ].join("\n")
  expect(parseWorktreeList(porcelain)).toEqual([
    { path: "/sandbox/celly-demo/workspace", branch: "main" },
    { path: "/sandbox/celly-demo/workspace/.celly/worktrees/my-feature", branch: "celly/my-feature" },
    { path: "/sandbox/celly-demo/workspace/.celly/worktrees/detached" },
  ])
  expect(parseWorktreeList("")).toEqual([])
})

test("parseStatusPorcelain returns changed paths and ignores blanks", () => {
  expect(parseStatusPorcelain(" M src/a.ts\n?? new.txt\n")).toEqual(["src/a.ts", "new.txt"])
  expect(parseStatusPorcelain("R  old.txt -> new.txt\n")).toEqual(["old.txt -> new.txt"])
  expect(parseStatusPorcelain("")).toEqual([])
})

test("mergeOutcome reports success, deduplicated conflicts, and hard failures", () => {
  expect(mergeOutcome("Merge made by the 'ort' strategy.", "", 0)).toEqual({ ok: true, conflicts: [] })
  expect(mergeOutcome("", [
    "CONFLICT (content): Merge conflict in src/a.ts",
    "CONFLICT (content): Merge conflict in src/a.ts",
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n"), 1)).toEqual({ ok: false, conflicts: ["src/a.ts"] })
  expect(mergeOutcome("", "CONFLICT (modify/delete): config.json deleted in HEAD and modified in celly/x.  Version celly/x of config.json left in tree.", 1))
    .toEqual({ ok: false, conflicts: ["config.json"] })
  expect(mergeOutcome("", "fatal: refusing to merge unrelated histories", 128))
    .toEqual({ ok: false, conflicts: [] })
})

const ROOT = "/sandbox/celly-demo/workspace"

function threadRow(over: any = {}) {
  return { threadId: "t1", channelId: "c", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1, ...over }
}

function makeService(over: any = {}) {
  const calls: Array<{ name: string; args: string[]; opts?: { timeoutMs?: number } }> = []
  const results = new Map<string, { code: number; stdout: string; stderr: string }>()
  const warns: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const sbx: any = {
    exec: async (name: string, args: string[], opts?: { timeoutMs?: number }) => {
      calls.push({ name, args, opts })
      return results.get(args.join(" ")) ?? { code: 0, stdout: "", stderr: "" }
    },
    execResult: async (name: string, args: string[], opts?: { timeoutMs?: number }) => {
      calls.push({ name, args, opts })
      return results.get(args.join(" ")) ?? { code: 0, stdout: "", stderr: "" }
    },
  }
  const db = openDb(":memory:"); db.migrate()
  const directory = over.directory ?? "/projects/demo"
  db.projects.insertProvisioning({ channelId: "c", guildId: "g", name: "demo", directory,
    sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 })
  db.projects.setReady("c", ROOT)
  db.threads.upsert(threadRow(over.thread))
  const service = new WorktreeService({ sbx, db, log: { info() {}, warn: (message: string, fields?: Record<string, unknown>) => warns.push({ message, fields }) } })
  return { calls, results, warns, db, service }
}

function porcelainFor(worktreePath: string): string {
  return [`worktree ${ROOT}`, "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", "",
    `worktree ${worktreePath}`, "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/celly/t1", ""].join("\n")
}

test("ensureGitignoreEntry appends .celly/ once and leaves existing content intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-wt-"))
  try {
    const warnings: string[] = []
    ensureGitignoreEntry(dir, (message) => warnings.push(message))
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".celly/\n")
    ensureGitignoreEntry(dir, (message) => warnings.push(message))
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".celly/\n")
    const file = join(dir, ".gitignore")
    rmSync(file)
    writeFileSync(file, "node_modules")
    ensureGitignoreEntry(dir, (message) => warnings.push(message))
    expect(readFileSync(file, "utf8")).toBe("node_modules\n.celly/\n")
    expect(warnings).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureGitignoreEntry warns instead of throwing when the directory is unwritable", () => {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
  ensureGitignoreEntry(join(tmpdir(), "celly-missing-dir", "project"), (message, fields) => warnings.push({ message, fields }))
  expect(warnings).toHaveLength(1)
  expect(warnings[0].message).toMatch(/gitignore/)
})

test("create runs git worktree add with exact argv, appends .gitignore, and stores the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-wt-"))
  try {
    const { calls, db, service } = makeService({ directory: dir })
    const out = await service.create("t1", "My Feature!!")
    expect(calls).toEqual([{ name: "celly-demo",
      args: ["git", "-C", ROOT, "worktree", "add", "-b", "celly/my-feature", ".celly/worktrees/my-feature", "HEAD"],
      opts: { timeoutMs: 120_000 } }])
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".celly/\n")
    expect(db.threads.get("t1")?.worktreePath).toBe(`${ROOT}/.celly/worktrees/my-feature`)
    expect(out).toBe(`created worktree ${ROOT}/.celly/worktrees/my-feature (branch celly/my-feature)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("create without a name uses the short thread branch for both branch and path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-wt-"))
  try {
    const { calls, db, service } = makeService({ directory: dir })
    db.threads.upsert(threadRow({ threadId: "123456789012345678" }))
    await service.create("123456789012345678")
    expect(calls[0].args).toEqual(["git", "-C", ROOT, "worktree", "add", "-b", "celly/12345678", ".celly/worktrees/12345678", "HEAD"])
    expect(db.threads.get("123456789012345678")?.worktreePath).toBe(`${ROOT}/.celly/worktrees/12345678`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("create refuses when the thread already has a worktree", async () => {
  const { service } = makeService({ thread: { worktreePath: `${ROOT}/.celly/worktrees/t1` } })
  await expect(service.create("t1")).rejects.toThrow(/already has a worktree/)
})

test("create still runs git and logs when .gitignore is unwritable", async () => {
  const { calls, warns, db, service } = makeService({ directory: join(tmpdir(), "celly-missing-dir", "project") })
  await service.create("t1", "feature")
  expect(calls).toHaveLength(1)
  expect(warns).toHaveLength(1)
  expect(db.threads.get("t1")?.worktreePath).toBe(`${ROOT}/.celly/worktrees/feature`)
})

test("status reports the path, branch, and clean state", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "list", "--porcelain"].join(" "), { code: 0, stdout: porcelainFor(worktreePath), stderr: "" })
  expect(await service.status("t1")).toBe(`worktree: ${worktreePath} (branch celly/t1)\nstatus: clean`)
})

test("status reports dirty file counts", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "list", "--porcelain"].join(" "), { code: 0, stdout: porcelainFor(worktreePath), stderr: "" })
  results.set(["git", "-C", worktreePath, "status", "--porcelain"].join(" "), { code: 0, stdout: " M src/a.ts\n?? new.txt\n", stderr: "" })
  expect(await service.status("t1")).toContain("dirty (2 changed)")
})

test("status without a worktree tells the user how to create one", async () => {
  const { service } = makeService()
  expect(await service.status("t1")).toBe("no worktree for this thread; run /worktree new [name]")
})
