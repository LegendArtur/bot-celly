# Worktrees and Forks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Discord thread an optional git worktree inside its project sandbox, with `/worktree status|new|merge|remove`, plus `/fork`, `/btw`, `/last-sessions`, and `/project create clone:<url>` support.

**Architecture:** A new pure/ops module `src/worktrees.ts` owns slug/branch/porcelain parsing, `.gitignore` maintenance, and argv-only `sbx exec git …` operations. The store gains `db.threads.setWorktree`. `Runner` routes session calls through a `directoryFor(threadId)` hook, so worktree threads run against their worktree directory. Commands stay thin: `commands.ts` validates/flags and delegates to injected services (`worktrees`, `forkThread`), while `index.ts` wires the SDK. Forks use `session.fork` and copy model/agent/worktree onto the new thread row.

**Tech Stack:** Node 24 ESM TypeScript (`strict`, `noUncheckedIndexedAccess`), `node:sqlite`, `@opencode-ai/sdk` 1.18.32 (`session.fork`, `query.directory`), discord.js 14, vitest.

**Spec:** docs/superpowers/specs/2026-09-27-vnext-features-design.md

## Global Constraints

Copied from spec §2 and §4.6 — every task's requirements implicitly include these:

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (guarded by `test/imports.test.ts`). Only `src/opencode.ts` and `src/projects.ts` may build `http://127.0.0.1:${...}` URLs.
- argv-only spawning: `shell: false`, `windowsHide: true`; every `sbx` execution is an argv array, never a shell string.
- No new npm dependencies.
- Secrets (Discord token, server passwords, provider keys) never in argv, logs, audit entries, or Discord messages. Redact through `src/log.ts`.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and `../src/x.ts` imports. Temp dirs via `mkdtempSync(join(tmpdir(), "celly-...-")); try { } finally { rmSync(...) }`.
- Migrations are append-only; this plan needs **no migration** (`threads.worktree_path` already exists). Never insert into or reorder `MIGRATIONS`.
- The worktree root is `<project>/.celly/worktrees/<slug>` inside the sandbox mount; on first use append `.celly/` to the project's `.gitignore` when missing (log, don't fail, when unwritable).
- Command changes update `docs-site/reference/commands.mdx` and the README commands table; security-relevant changes update `docs-site/reference/security.mdx`; new docs pages register in `docs-site/docs.json` (this plan adds no new pages).
- Run `npm test`, `npm run typecheck`, `npm run build` before each commit.

## Worktree

The spec (§1) runs each plan in its own **executor** git worktree from `main`, created with `superpowers:using-git-worktrees` at execution time. Do not confuse that with this feature: this plan builds *per-thread* worktrees that live inside the project sandbox at `<project>/.celly/worktrees/<slug>` and are created with `git worktree add` through `sbx exec`. The executor's own worktree is irrelevant to the product code and must not be touched by the implementation.

## File Structure

- Create: `src/worktrees.ts` — pure helpers (Task 1), `.gitignore` helper + `WorktreeService` (Tasks 4–5). One responsibility: everything that knows how Celly shells out to git for worktrees.
- Create: `test/worktrees.test.ts` — pure-helper tests (Task 1) and fake-sbx service tests asserting exact argv (Tasks 4–5).
- Create: `.changeset/worktrees-and-forks.md` — minor changeset (Task 9).
- Modify: `src/db.ts` — add `threads.setWorktree` (Task 2).
- Modify: `test/db.test.ts` — `setWorktree` tests (Task 2).
- Modify: `src/runner.ts` — `RunnerDeps.directoryFor`, `withDirectory`, directory query on prompt/abort/messages (Task 3).
- Modify: `test/runner.test.ts` — payload assertions (Task 3).
- Modify: `src/sbx.ts` — non-throwing `execResult` for merge/remove (Task 5).
- Modify: `test/sbx-lifecycle.test.ts` — `execResult` test (Task 5).
- Modify: `src/commands.ts` — `/worktree`, `requiresOwner`, fork/btw, `/last-sessions`, clone options (Tasks 4–8).
- Modify: `test/commands.test.ts` — command wiring tests; `interaction()` gains `getInteger`/`getBoolean` (Tasks 4–8).
- Modify: `src/handlers.ts` — `createForkThread` factory (Task 6).
- Modify: `test/handlers.test.ts` — fork factory test (Task 6).
- Modify: `src/projects.ts` — `validateCloneUrl`, `clone` input, clone after bootstrap (Task 8).
- Modify: `test/projects.test.ts` — clone argv/validation/rollback tests (Task 8).
- Modify: `src/index.ts` — wire `WorktreeService`, `directoryFor`, `forkThread` (Tasks 3–6).
- Modify: `docs-site/reference/commands.mdx`, `docs-site/reference/architecture.mdx`, `docs-site/reference/security.mdx`, `README.md` (Task 9).
- Not modified: `src/types.ts` (`Thread.worktreePath` already exists), `docs-site/docs.json` (no new pages).

---

### Task 1: Worktree pure helpers

**Files:**
- Create: `src/worktrees.ts`
- Test: `test/worktrees.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `worktreeSlug(text: string): string`
  - `worktreeBranch(threadId: string): string` (`celly/<short>`)
  - `parseWorktreeList(stdout: string): { path: string; branch?: string }[]`
  - `parseStatusPorcelain(stdout: string): string[]`
  - `mergeOutcome(stdout: string, stderr: string, code: number): { ok: boolean; conflicts: string[] }`

- [ ] **Step 1: Write the failing test**

Create `test/worktrees.test.ts`:

```ts
// test/worktrees.test.ts
import { expect, test } from "vitest"
import { mergeOutcome, parseStatusPorcelain, parseWorktreeList, worktreeBranch, worktreeSlug } from "../src/worktrees.ts"

test("worktreeSlug lowercases, collapses separators, and caps the length", () => {
  expect(worktreeSlug("My Feature!! / v2")).toBe("my-feature-v2")
  expect(worktreeSlug("")).toBe("work")
  expect(worktreeSlug("---")).toBe("work")
  expect(worktreeSlug("a".repeat(60)).length).toBeLessThanOrEqual(30)
})

test("worktreeBranch uses the trailing eight alphanumerics of the thread id", () => {
  expect(worktreeBranch("!!thread-42!!")).toBe("celly/read42")
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worktrees.test.ts`
Expected: FAIL — `Failed to resolve import "../src/worktrees.ts" from "test/worktrees.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

Create `src/worktrees.ts`:

```ts
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
    .map((line) => line.trim())
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worktrees.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/worktrees.ts test/worktrees.test.ts
git commit -m "feat(worktrees): add slug, branch, porcelain, and merge parsing helpers"
```

---

### Task 2: Persist the thread worktree path

**Files:**
- Modify: `src/db.ts` (interface `threads` block and implementation)
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: existing `threads.worktree_path` column and `rowToThread` mapping; no migration.
- Produces: `db.threads.setWorktree(threadId: string, path: string | null): void`.

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.ts` (uses the existing `fresh()`, `proj`, and thread-row shape):

```ts
test("setWorktree stores and clears the thread worktree path", () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: null, model: null, agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 5 })
  db.threads.setWorktree("t1", "/sandbox/celly-demo/workspace/.celly/worktrees/t1")
  expect(db.threads.get("t1")?.worktreePath).toBe("/sandbox/celly-demo/workspace/.celly/worktrees/t1")
  db.threads.setWorktree("t1", null)
  expect(db.threads.get("t1")?.worktreePath).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — `TypeError: db.threads.setWorktree is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/db.ts`, add to the `Db` interface `threads` block after `setAgent`:

```ts
    setWorktree(threadId: string, path: string | null): void
```

In the `threads` implementation, after `setAgent`:

```ts
      setWorktree(threadId, path) { raw.prepare(`UPDATE threads SET worktree_path=? WHERE thread_id=?`).run(path, threadId) },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db.test.ts`
Expected: PASS, including the existing thread tests.

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "feat(db): add threads.setWorktree"
```

---

### Task 3: Route session calls to the thread worktree directory

**Files:**
- Modify: `src/runner.ts` (`RunnerDeps`, `withDirectory`, `prompt`, `abort`, `recover`)
- Modify: `src/index.ts` (import `withDirectory`; `directoryFor`; create/session create pass the directory)
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `db.threads.get(threadId)?.worktreePath` (Tasks 1–2 data; index wiring).
- Produces:
  - `RunnerDeps.directoryFor?(threadId: string): string | undefined`
  - `export function withDirectory<T extends object>(directory: string | null | undefined, options: T): T & { query?: { directory: string } }`
  - `promptAsync`, `abort`, and `messages` payloads carry `query: { directory }` when defined.

- [ ] **Step 1: Write the failing tests**

In `test/runner.test.ts`, extend the import line:

```ts
import { evaluatePermission, normalizeCommand, Runner, withDirectory } from "../src/runner.ts"
```

Append these tests:

```ts
test("withDirectory adds the query only when a directory is defined", () => {
  expect(withDirectory("/w/t1", { body: { title: "x" } })).toEqual({ body: { title: "x" }, query: { directory: "/w/t1" } })
  expect(withDirectory(null, { body: { title: "x" } })).toEqual({ body: { title: "x" } })
  expect(withDirectory(undefined, { path: { id: "s1" } })).toEqual({ path: { id: "s1" } })
})

test("prompt passes the thread worktree directory as query", async () => {
  const payloads: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async (a: any) => { payloads.push(a) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1",
    directoryFor: (threadId: string) => (threadId === "t1" ? "/w/t1" : undefined),
    log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "hi", "u")
  await runner.prompt("t2", "hi", "u")
  expect(payloads[0].query).toEqual({ directory: "/w/t1" })
  expect(payloads[1].query).toBeUndefined()
})

test("abort passes the thread worktree directory as query", async () => {
  const aborts: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { promptAsync: async () => {}, abort: async (a: any) => { aborts.push(a) } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", directoryFor: () => "/w/t1",
    log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.prompt("t1", "a", "u")
  await runner.abort("t1")
  expect(aborts[0]).toEqual({ path: { id: "s1" }, query: { directory: "/w/t1" } })
})

test("recover passes the thread worktree directory to session.messages", async () => {
  const payloads: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: { messages: async (a: any) => { payloads.push(a); return { data: [] } } } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", directoryFor: () => "/w/t1",
    log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.recover({ threadId: "t1", sessionId: "s1" })
  expect(payloads[0]).toEqual({ path: { id: "s1" }, query: { directory: "/w/t1" } })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — `withDirectory` is not exported and the captured payloads have no `query`.

- [ ] **Step 3: Write minimal implementation**

In `src/runner.ts`, add above the `RunnerDeps` interface:

```ts
export function withDirectory<T extends object>(directory: string | null | undefined, options: T): T & { query?: { directory: string } } {
  if (!directory) return options
  return { ...options, query: { directory } }
}
```

Add the optional dep to `RunnerDeps`:

```ts
  directoryFor?(threadId: string): string | undefined
```

In `prompt`, replace the `promptAsync` call:

```ts
      await client.session.promptAsync(withDirectory(this.deps.directoryFor?.(threadId), { path: { id: sessionId }, body }) as any)
```

In `abort`, replace the `abort` call:

```ts
      await client.session.abort(withDirectory(this.deps.directoryFor?.(threadId), { path: { id: sessionId } }) as any)
```

In `recover`, replace the `messages` call:

```ts
    const messages = await client.session.messages(withDirectory(this.deps.directoryFor?.(thread.threadId), { path: { id: thread.sessionId } }) as any)
```

In `src/index.ts`:

1. Extend the runner import:

```ts
import { Runner, withDirectory } from "./runner.js"
```

2. Add `directoryFor` to the `new Runner({...})` deps (after `sessionFor`):

```ts
    directoryFor: (threadId) => db.threads.get(threadId)?.worktreePath ?? undefined,
```

3. In `createSessionFor`, accept and pass a directory:

```ts
  const createSessionFor = async (project: Project, title: string, directory?: string | null): Promise<string> => {
    const sdk = resolveClient(project)
    const created = await sdk.session.create(withDirectory(directory, { body: { title } }) as any)
    const sessionId = sessionIdFrom(created)
    if (!sessionId) throw new Error("opencode session.create returned no id")
    return sessionId
  }
```

4. In `sessionFor`, pass the thread's worktree path on the lazy-create path:

```ts
      const created = await sdk.session.create(withDirectory(thread.worktreePath, { body: { title: thread.title ?? undefined } }) as any)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS, including every pre-existing runner test.

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/runner.ts src/index.ts test/runner.test.ts
git commit -m "feat(runner): route session calls through the thread worktree directory"
```

---

### Task 4: `/worktree status|new` and `.gitignore` maintenance

**Files:**
- Modify: `src/worktrees.ts` (add `ensureGitignoreEntry`, `WorktreeService` with `create`/`status`)
- Modify: `src/commands.ts` (`WorktreeCommands`, `CommandDeps.worktree`, `commandData`, handler, subcommand capture)
- Modify: `src/index.ts` (construct `WorktreeService`, pass it in `commandDeps`)
- Test: `test/worktrees.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `db.threads.setWorktree` (Task 2); `Sbx.exec(name, args, opts?)`.
- Produces:
  - `ensureGitignoreEntry(directory: string, onWarn: (message: string, fields?: Record<string, unknown>) => void): void`
  - `class WorktreeService` with `constructor(deps: { sbx: Sbx; db: Db; log: WorktreeLog })`, `create(threadId: string, name?: string): Promise<string>`, `status(threadId: string): Promise<string>`
  - `commands.ts`: `export interface WorktreeCommands { status(threadId: string): Promise<string>; create(threadId: string, name?: string): Promise<string> }`; `CommandDeps.worktree?: WorktreeCommands`.

- [ ] **Step 1: Write the failing service tests**

In `test/worktrees.test.ts`, replace the top import block with:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openDb } from "../src/db.ts"
import { ensureGitignoreEntry, mergeOutcome, parseStatusPorcelain, parseWorktreeList, WorktreeService, worktreeBranch, worktreeSlug } from "../src/worktrees.ts"
```

Append the fixtures and tests:

```ts
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
```

- [ ] **Step 2: Run service tests to verify they fail**

Run: `npx vitest run test/worktrees.test.ts`
Expected: FAIL — `ensureGitignoreEntry is not a function` / `WorktreeService is not a constructor`.

- [ ] **Step 3: Implement the gitignore helper and service**

In `src/worktrees.ts`, replace the top of the file (above `worktreeSlug`) with these imports:

```ts
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { joinPathLike } from "./sbx.js"
import type { Sbx } from "./sbx.js"
import type { Db } from "./db.ts"
import type { Project, Thread } from "./types.ts"
```

Append to `src/worktrees.ts`:

```ts
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
    if (!project.sandboxPath) throw new Error("project sandbox path is not resolved; run /project start")
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
}
```

- [ ] **Step 4: Write the failing command tests**

In `test/commands.test.ts`, extend the `interaction()` fake options:

```ts
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => strings[n],
      getInteger: (n: string) => (over.integers ?? {})[n],
      getBoolean: (n: string) => (over.booleans ?? {})[n],
    },
```

Update the declared command set to include `worktree`:

```ts
test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "model", "new", "project", "resume", "worktree"])
})
```

Append:

```ts
test("worktree outside a thread is rejected", async () => {
  const i = interaction({ commandName: "worktree", sub: "status", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("use /worktree inside a thread")
})

test("worktree status forwards the thread id", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "status", channelId: "t1" })
  const seen: string[] = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    worktree: { status: async (threadId: string) => { seen.push(threadId); return "worktree: /w" }, create: async () => "" } })
  expect(seen).toEqual(["t1"])
  expect(editOf(i)).toBe("worktree: /w")
})

test("worktree new forwards the thread and optional name", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "new", channelId: "t1", strings: { name: "feature" } })
  const seen: Array<[string, string | undefined]> = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    worktree: { status: async () => "", create: async (threadId: string, name?: string) => { seen.push([threadId, name]); return "created" } } })
  expect(seen).toEqual([["t1", "feature"]])
  expect(editOf(i)).toBe("created")
})
```

- [ ] **Step 5: Run command tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `commandData()` has no `worktree`, and `handleCommand` replies `not implemented in this build`.

- [ ] **Step 6: Implement command definitions and handler**

In `src/commands.ts`, add after `CreateThreadInput`:

```ts
export interface WorktreeCommands {
  status(threadId: string): Promise<string>
  create(threadId: string, name?: string): Promise<string>
}
```

Add to `CommandDeps` (after `setThreadAgent`):

```ts
  worktree?: WorktreeCommands
```

In `commandData()`, append after the `agent` entry:

```ts
    { name: "worktree", description: "Manage this thread's git worktree", options: [
      { type: ApplicationCommandOptionType.Subcommand, name: "status", description: "Show this thread's worktree status" },
      { type: ApplicationCommandOptionType.Subcommand, name: "new", description: "Create a git worktree for this thread", options: [
        { type: ApplicationCommandOptionType.String, name: "name", description: "Worktree name (defaults to the thread)", required: false } ] },
    ] }
```

In `handleCommand`, widen the subcommand lookup:

```ts
  const sub = interaction.commandName === "project" || interaction.commandName === "worktree"
    ? interaction.options.getSubcommand(false)
    : null
```

Add the worktree branch just before the final `await interaction.editReply(noMentions("not implemented in this build"))` line:

```ts
    if (interaction.commandName === "worktree") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions("use /worktree inside a thread"))
      if (!deps.worktree) return void await interaction.editReply(noMentions("worktree support unavailable"))
      if (sub === "status") return void await interaction.editReply(noMentions(await deps.worktree.status(thread.threadId)))
      if (sub === "new") {
        const worktreeName = interaction.options.getString("name", false) ?? undefined
        return void await interaction.editReply(noMentions(await deps.worktree.create(thread.threadId, worktreeName)))
      }
    }
```

- [ ] **Step 7: Wire the service in `src/index.ts`**

Add the import:

```ts
import { WorktreeService } from "./worktrees.js"
```

After `runnerSvc = new Runner({...})`:

```ts
  const worktrees = new WorktreeService({ sbx, db, log })
```

Add to the `commandDeps` object (after `setThreadAgent`):

```ts
    worktree: worktrees,
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/worktrees.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 9: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/worktrees.ts src/commands.ts src/index.ts test/worktrees.test.ts test/commands.test.ts
git commit -m "feat(worktrees): add /worktree status and new with gitignore maintenance"
```

---

### Task 5: `/worktree merge` and `/worktree remove`

**Files:**
- Modify: `src/sbx.ts` (add non-throwing `execResult`; `exec` delegates)
- Modify: `src/worktrees.ts` (`merge`, `remove`)
- Modify: `src/commands.ts` (`WorktreeCommands` gains `merge`/`remove`; `requiresOwner`; `commandData`; handler)
- Test: `test/sbx-lifecycle.test.ts`, `test/worktrees.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `Sbx.execResult(name: string, args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>`; Task 4 service.
- Produces:
  - `WorktreeService.merge(threadId: string): Promise<string>` (returns a user-visible refusal/conflict/success message)
  - `WorktreeService.remove(threadId: string, force: boolean): Promise<string>`
  - `WorktreeCommands.merge(threadId: string): Promise<string>`, `WorktreeCommands.remove(threadId: string, force: boolean): Promise<string>`
  - `requiresOwner("worktree", "merge") === true`.

- [ ] **Step 1: Write the failing `execResult` test**

Append to `test/sbx-lifecycle.test.ts`:

```ts
test("execResult returns non-zero exits without throwing and exec still throws", async () => {
  const r = new FakeRunner({ "exec celly-demo": [
    { code: 1, stdout: "out", stderr: "err" },
    { code: 1, stdout: "out", stderr: "err" },
  ] })
  const sbx = new Sbx(r as any)
  await expect(sbx.execResult("celly-demo", ["git", "merge", "x"]))
    .resolves.toEqual({ code: 1, stdout: "out", stderr: "err" })
  await expect(sbx.exec("celly-demo", ["git", "merge", "x"]))
    .rejects.toThrow("sbx exec failed (1): err")
  expect(r.calls[1]).toEqual(["exec", "celly-demo", "git", "merge", "x"])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/sbx-lifecycle.test.ts`
Expected: FAIL — `sbx.execResult is not a function`.

- [ ] **Step 3: Implement `execResult`**

In `src/sbx.ts`, replace the `exec` method:

```ts
  async execResult(name: string, args: string[], opts: { timeoutMs?: number } = {}) {
    return this.runner.run(["exec", name, ...args], opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {})
  }
  async exec(name: string, args: string[], opts: { timeoutMs?: number } = {}) {
    const r = await this.execResult(name, args, opts)
    if (r.code !== 0) throw new SbxError(`sbx exec failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
    return r
  }
```

- [ ] **Step 4: Write the failing merge/remove service tests**

Append to `test/worktrees.test.ts`:

```ts
test("merge runs porcelain checks then git merge --no-ff with exact argv", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { calls, results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "list", "--porcelain"].join(" "), { code: 0, stdout: porcelainFor(worktreePath), stderr: "" })
  expect(await service.merge("t1")).toBe("merged celly/t1 into the project root")
  expect(calls.map((c) => c.args)).toEqual([
    ["git", "-C", ROOT, "worktree", "list", "--porcelain"],
    ["git", "-C", worktreePath, "status", "--porcelain"],
    ["git", "-C", ROOT, "status", "--porcelain"],
    ["git", "-C", ROOT, "merge", "--no-ff", "celly/t1"],
  ])
})

test("merge refuses a dirty worktree and lists the changed files", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { calls, results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "list", "--porcelain"].join(" "), { code: 0, stdout: porcelainFor(worktreePath), stderr: "" })
  results.set(["git", "-C", worktreePath, "status", "--porcelain"].join(" "), { code: 0, stdout: " M src/a.ts\n", stderr: "" })
  const out = await service.merge("t1")
  expect(out).toBe("worktree has uncommitted changes:\n- src/a.ts")
  expect(calls.some((c) => c.args.includes("merge"))).toBe(false)
})

test("merge refuses a dirty project root and lists the changed files", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { calls, results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "list", "--porcelain"].join(" "), { code: 0, stdout: porcelainFor(worktreePath), stderr: "" })
  results.set(["git", "-C", ROOT, "status", "--porcelain"].join(" "), { code: 0, stdout: "?? scratch.txt\n", stderr: "" })
  const out = await service.merge("t1")
  expect(out).toBe("project root has uncommitted changes:\n- scratch.txt")
  expect(calls.some((c) => c.args.includes("merge"))).toBe(false)
})

test("merge reports conflicted files from the merge output", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "list", "--porcelain"].join(" "), { code: 0, stdout: porcelainFor(worktreePath), stderr: "" })
  results.set(["git", "-C", ROOT, "merge", "--no-ff", "celly/t1"].join(" "), { code: 1, stdout: "",
    stderr: "CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed; fix conflicts and then commit the result." })
  const out = await service.merge("t1")
  expect(out).toContain("merge conflicts in:")
  expect(out).toContain("- src/a.ts")
})

test("merge throws a hard failure when the output names no conflicts", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "list", "--porcelain"].join(" "), { code: 0, stdout: porcelainFor(worktreePath), stderr: "" })
  results.set(["git", "-C", ROOT, "merge", "--no-ff", "celly/t1"].join(" "), { code: 128, stdout: "", stderr: "fatal: refusing to merge unrelated histories" })
  await expect(service.merge("t1")).rejects.toThrow(/unrelated histories/)
})

test("merge without a worktree is rejected", async () => {
  const { service } = makeService()
  await expect(service.merge("t1")).rejects.toThrow(/no worktree for this thread/)
})

test("remove runs git worktree remove with exact argv and clears the stored path", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { calls, db, service } = makeService({ thread: { worktreePath } })
  expect(await service.remove("t1", false)).toBe(`removed ${worktreePath}`)
  expect(calls).toEqual([{ name: "celly-demo",
    args: ["git", "-C", ROOT, "worktree", "remove", worktreePath], opts: { timeoutMs: 120_000 } }])
  expect(db.threads.get("t1")?.worktreePath).toBeNull()
})

test("remove with force passes --force", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { calls, service } = makeService({ thread: { worktreePath } })
  await service.remove("t1", true)
  expect(calls[0].args).toEqual(["git", "-C", ROOT, "worktree", "remove", "--force", worktreePath])
})

test("remove without force suggests force when git refuses", async () => {
  const worktreePath = `${ROOT}/.celly/worktrees/t1`
  const { db, results, service } = makeService({ thread: { worktreePath } })
  results.set(["git", "-C", ROOT, "worktree", "remove", worktreePath].join(" "),
    { code: 1, stdout: "", stderr: "fatal: '/w' contains modified or untracked files, use --force to delete it" })
  const out = await service.remove("t1", false)
  expect(out).toContain("use /worktree remove force:true")
  expect(db.threads.get("t1")?.worktreePath).toBe(worktreePath)
})
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npx vitest run test/worktrees.test.ts`
Expected: FAIL — `service.merge is not a function` / `service.remove is not a function`.

- [ ] **Step 6: Implement `merge` and `remove`**

Append to `WorktreeService` in `src/worktrees.ts`:

```ts
  async merge(threadId: string): Promise<string> {
    const { thread, project } = this.lookup(threadId)
    if (!thread.worktreePath) throw new Error("no worktree for this thread")
    if (!project.sandboxPath) throw new Error("project sandbox path is not resolved; run /project start")
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
    if (!project.sandboxPath) throw new Error("project sandbox path is not resolved; run /project start")
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
```

- [ ] **Step 7: Write the failing command tests**

In `test/commands.test.ts`, update the two Task 4 worktree fakes to include `merge`/`remove` (the interface grows), e.g. the status test fake becomes:

```ts
    worktree: { status: async (threadId: string) => { seen.push(threadId); return "worktree: /w" },
      create: async () => "", merge: async () => "", remove: async () => "" } })
```

Append:

```ts
test("worktree merge is owner-only", async () => {
  const i = interaction({ commandName: "worktree", sub: "merge", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64 } })
})

test("worktree merge forwards the thread id", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "merge", channelId: "t1" })
  const seen: string[] = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true,
    worktree: { status: async () => "", create: async () => "",
      merge: async (threadId: string) => { seen.push(threadId); return "merged celly/t1 into the project root" }, remove: async () => "" } })
  expect(seen).toEqual(["t1"])
  expect(editOf(i)).toBe("merged celly/t1 into the project root")
})

test("worktree remove forwards the force flag", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "worktree", sub: "remove", channelId: "t1", booleans: { force: true } })
  const seen: Array<[string, boolean]> = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    worktree: { status: async () => "", create: async () => "", merge: async () => "",
      remove: async (threadId: string, force: boolean) => { seen.push([threadId, force]); return "removed" } } })
  expect(seen).toEqual([["t1", true]])
  expect(editOf(i)).toBe("removed")
})
```

Update the `requiresOwner` test:

```ts
test("requiresOwner scopes project mutations", () => {
  for (const sub of ["add", "create", "start", "stop", "remove"]) expect(requiresOwner("project", sub)).toBe(true)
  for (const sub of ["list", "status"]) expect(requiresOwner("project", sub)).toBe(false)
  expect(requiresOwner("worktree", "merge")).toBe(true)
  for (const sub of ["status", "new", "remove"]) expect(requiresOwner("worktree", sub)).toBe(false)
  expect(requiresOwner("new", null)).toBe(false)
  expect(requiresOwner("model", "resume")).toBe(false)
})
```

- [ ] **Step 8: Run command tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — the owner-only merge check does not trigger and the handler replies `not implemented in this build`.

- [ ] **Step 9: Implement the command surface**

In `src/commands.ts`, extend `WorktreeCommands`:

```ts
export interface WorktreeCommands {
  status(threadId: string): Promise<string>
  create(threadId: string, name?: string): Promise<string>
  merge(threadId: string): Promise<string>
  remove(threadId: string, force: boolean): Promise<string>
}
```

In `commandData()`, add to the `worktree` options after the `new` subcommand:

```ts
      { type: ApplicationCommandOptionType.Subcommand, name: "merge", description: "Merge the worktree branch into the project (owner-only)" },
      { type: ApplicationCommandOptionType.Subcommand, name: "remove", description: "Remove this thread's worktree", options: [
        { type: ApplicationCommandOptionType.Boolean, name: "force", description: "Discard uncommitted changes", required: false } ] },
```

In the worktree handler branch, after the `new` case:

```ts
      if (sub === "merge") return void await interaction.editReply(noMentions(await deps.worktree.merge(thread.threadId)))
      if (sub === "remove") {
        const force = interaction.options.getBoolean("force", false) ?? false
        return void await interaction.editReply(noMentions(await deps.worktree.remove(thread.threadId, force)))
      }
```

Update `requiresOwner`:

```ts
const OWNER_ONLY_PROJECT_SUBS = new Set(["add", "create", "start", "stop", "remove"])
const OWNER_ONLY_WORKTREE_SUBS = new Set(["merge"])
export function requiresOwner(commandName: string, sub: string | null | undefined): boolean {
  if (commandName === "project") return !!sub && OWNER_ONLY_PROJECT_SUBS.has(sub)
  if (commandName === "worktree") return !!sub && OWNER_ONLY_WORKTREE_SUBS.has(sub)
  return false
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run test/sbx-lifecycle.test.ts test/worktrees.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 11: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 12: Commit**

```bash
git add src/sbx.ts src/worktrees.ts src/commands.ts test/sbx-lifecycle.test.ts test/worktrees.test.ts test/commands.test.ts
git commit -m "feat(worktrees): add owner-only merge with dirty refusal and remove"
```

---

### Task 6: `/fork` and `/btw`

**Files:**
- Modify: `src/commands.ts` (`ForkThreadInput`, `ForkedThread`, `CommandDeps.forkThread`, `commandData`, handler)
- Modify: `src/handlers.ts` (`createForkThread`)
- Modify: `src/index.ts` (wire `forkThread`)
- Test: `test/commands.test.ts`, `test/handlers.test.ts`

**Interfaces:**
- Consumes: `withDirectory` (Task 3); `sessionIdFrom`/`sanitizeThreadName` helpers; `Thread`/`Project` types.
- Produces:
  - `export interface ForkThreadInput { sourceThreadId: string; title: string; prompt?: string; authorId?: string }`
  - `export interface ForkedThread { threadId: string; sessionId: string; notice?: string }`
  - `CommandDeps.forkThread?(input: ForkThreadInput): Promise<ForkedThread>`
  - `export function createForkThread(deps: ForkThreadDeps): (input: ForkThreadInput) => Promise<ForkedThread>`

- [ ] **Step 1: Write the failing handler test**

In `test/handlers.test.ts`, add `createForkThread` to the handlers import (keep the existing imports), add `openDb` if it is not already imported:

```ts
import { openDb } from "../src/db.ts"
import { createForkThread, createMessageHandler } from "../src/handlers.ts"
```

Append:

```ts
test("createForkThread forks the session and copies model, agent, and worktree", async () => {
  const db = openDb(":memory:"); db.migrate()
  db.projects.insertProvisioning({ channelId: "c", guildId: "g", name: "demo", directory: "C:\\p",
    sandboxPath: null, sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 })
  db.threads.upsert({ threadId: "t1", channelId: "c", sessionId: "s1", title: "source", model: "anthropic/claude",
    agent: "build", worktreePath: "/sandbox/celly-demo/workspace/.celly/worktrees/t1",
    liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 1 })
  const forkCalls: any[] = []
  const created: any[] = []
  const prompted: string[] = []
  const fork = createForkThread({
    db,
    client: { channels: { fetch: async () => ({ threads: { create: async (o: any) => { created.push(o); return { id: "t9", members: { add: async () => {} } } } }) } } },
    runner: { prompt: async (threadId: string) => { prompted.push(threadId); return undefined } },
    ensureReady: async () => {},
    resolveClient: () => ({ session: { fork: async (a: any) => { forkCalls.push(a); return { data: { id: "s9" } } } } }),
    registerSession: () => {},
    startTyping: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} } as any,
  })
  const result = await fork({ sourceThreadId: "t1", title: "btw · hi", prompt: "hi", authorId: "u1" })
  expect(forkCalls).toEqual([{ path: { id: "s1" }, query: { directory: "/sandbox/celly-demo/workspace/.celly/worktrees/t1" } }])
  expect(created).toEqual([{ name: "btw · hi" }])
  expect(db.threads.get("t9")).toMatchObject({ sessionId: "s9", model: "anthropic/claude", agent: "build",
    worktreePath: "/sandbox/celly-demo/workspace/.celly/worktrees/t1", channelId: "c" })
  expect(result).toEqual({ threadId: "t9", sessionId: "s9", notice: undefined })
  expect(prompted).toEqual(["t9"])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/handlers.test.ts`
Expected: FAIL — `createForkThread` is not exported.

- [ ] **Step 3: Implement the fork factory**

In `src/commands.ts`, after `CreateThreadInput`:

```ts
export interface ForkThreadInput {
  sourceThreadId: string; title: string; prompt?: string; authorId?: string
}
export interface ForkedThread { threadId: string; sessionId: string; notice?: string }
```

Add to `CommandDeps` (after `createThread`):

```ts
  forkThread?(input: ForkThreadInput): Promise<ForkedThread>
```

In `src/handlers.ts`, extend imports (merge with the existing helper/render/commands imports):

```ts
import { withDirectory } from "./runner.js"
import { buildPromptText, projectForChannel, sessionIdFrom } from "./helpers.js"
import { renderPayload, sanitizeThreadName } from "./render.js"
import type { CreateThreadInput, ForkThreadInput, ForkedThread } from "./commands.ts"
```

Append:

```ts
export interface ForkThreadDeps {
  db: Pick<Db, "threads" | "projects">
  client: { channels: { fetch(id: string): Promise<any> } }
  runner: Pick<Runner, "prompt">
  ensureReady(channelId: string): Promise<void>
  resolveClient(project: Project): any
  registerSession(threadId: string, sessionId: string): void
  startTyping(threadId: string): void
  log: Logger
}

/**
 * `/fork` and `/btw`: fork the source session with `session.fork`, then open a
 * new Discord thread that copies the source model, agent, and worktree.
 */
export function createForkThread(deps: ForkThreadDeps): (input: ForkThreadInput) => Promise<ForkedThread> {
  return async function forkThread(input: ForkThreadInput): Promise<ForkedThread> {
    const source = deps.db.threads.get(input.sourceThreadId)
    if (!source) throw new Error(`unknown thread ${input.sourceThreadId}`)
    const project = deps.db.projects.getByChannel(source.channelId)
    if (!project) throw new Error(`unknown project for thread ${input.sourceThreadId}`)
    await deps.ensureReady(project.channelId)
    const sdk = deps.resolveClient(project)
    const forked = await sdk.session.fork(withDirectory(source.worktreePath, { path: { id: source.sessionId } }) as any)
    const sessionId = sessionIdFrom(forked)
    if (!sessionId) throw new Error("opencode session.fork returned no id")
    const channel = await deps.client.channels.fetch(project.channelId)
    if (!channel || !("threads" in channel)) throw new Error("project channel unavailable")
    const title = sanitizeThreadName(input.title)
    const thread = await channel.threads.create({ name: title })
    if (input.authorId) await thread.members.add(input.authorId).catch(() => {})
    deps.db.threads.upsert({ threadId: thread.id, channelId: project.channelId, sessionId, title,
      model: source.model, agent: source.agent, worktreePath: source.worktreePath,
      liveMessageId: null, renderState: "idle", createdAt: Date.now(), lastActiveAt: Date.now() })
    deps.registerSession(thread.id, sessionId)
    let notice: string | undefined
    if (input.prompt) {
      notice = await deps.runner.prompt(thread.id, input.prompt, input.authorId ?? "n/a")
      if (notice === undefined || notice.startsWith("queued")) deps.startTyping(thread.id)
    }
    return { threadId: thread.id, sessionId, notice }
  }
}
```

- [ ] **Step 4: Run the handler test to verify it passes**

Run: `npx vitest run test/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing command tests**

In `test/commands.test.ts`, update the declared command set:

```ts
test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "btw", "fork", "model", "new", "project", "resume", "worktree"])
})
```

Append:

```ts
test("fork outside a thread is rejected", async () => {
  const i = interaction({ commandName: "fork", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true,
    forkThread: async () => { throw new Error("should not run") } })
  expect(editOf(i)).toBe("use /fork inside a thread")
})

test("fork forwards the source thread, title, and prompt", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "fork", channelId: "t1", strings: { prompt: "try this" } })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s9" } } })
  expect(captured).toEqual({ sourceThreadId: "t1", title: "try this", prompt: "try this", authorId: "u1" })
  expect(editOf(i)).toBe("forked into <#t9>")
})

test("fork without a prompt titles the new thread after the source", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "fork", channelId: "t1" })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s9" } } })
  expect(captured.title).toBe("fork of source")
  expect(captured.prompt).toBeUndefined()
})

test("btw prefixes the title and requires a prompt", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "btw", channelId: "t1", strings: { prompt: "be quick" } })
  let captured: any
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async (input: any) => { captured = input; return { threadId: "t9", sessionId: "s9" } } })
  expect(captured.title).toBe("btw · be quick")
  expect(captured.prompt).toBe("be quick")
  expect(editOf(i)).toBe("forked into <#t9>")

  const missing = interaction({ commandName: "btw", channelId: "t1" })
  await handleCommand(missing, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async () => { throw new Error("should not run") } })
  expect(editOf(missing)).toBe("usage: /btw <prompt>")
})

test("fork surfaces the run notice when the forked prompt is queued", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.threads.upsert(threadRow("t1", "c", { title: "source" }))
  const i = interaction({ commandName: "fork", channelId: "t1", strings: { prompt: "hi" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true,
    forkThread: async () => ({ threadId: "t9", sessionId: "s9", notice: "queued (1)" }) })
  expect(editOf(i)).toBe("forked into <#t9> (queued (1))")
})
```

- [ ] **Step 6: Run command tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `fork`/`btw` are not in `commandData()` and fall through to `not implemented in this build`.

- [ ] **Step 7: Implement the command surface**

In `commandData()`, append after the `worktree` entry:

```ts
    { name: "fork", description: "Fork this thread's session into a new thread", options: [
      { type: ApplicationCommandOptionType.String, name: "prompt", description: "Initial prompt for the fork" } ] },
    { name: "btw", description: "Fork this thread with a quick side-question", options: [
      { type: ApplicationCommandOptionType.String, name: "prompt", description: "The side-question", required: true } ] }
```

In `handleCommand`, add before the `abort` block:

```ts
    if (interaction.commandName === "fork" || interaction.commandName === "btw") {
      const source = deps.db.threads.get(interaction.channelId)
      if (!source) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
      if (!deps.forkThread) return void await interaction.editReply(noMentions("fork support unavailable"))
      const prompt = interaction.options.getString("prompt", false) ?? undefined
      if (interaction.commandName === "btw" && !prompt) return void await interaction.editReply(noMentions("usage: /btw <prompt>"))
      const title = interaction.commandName === "btw" ? `btw · ${prompt}` : (prompt ?? `fork of ${source.title ?? source.threadId}`)
      const forked = await deps.forkThread({ sourceThreadId: source.threadId, title, prompt, authorId: interaction.user?.id })
      const note = forked.notice ? ` (${forked.notice})` : ""
      return void await interaction.editReply(noMentions(`forked into <#${forked.threadId}>${note}`))
    }
```

- [ ] **Step 8: Wire `forkThread` in `src/index.ts`**

Extend imports:

```ts
import { createForkThread, createMessageHandler, createProjectDownHandler, createProjectMissingHandler, createReadyHandler, createReconcileThreads, createShutdown } from "./handlers.js"
```

After `runnerSvc = new Runner({...})` and before `commandDeps`:

```ts
  const forkThread = createForkThread({
    db, client, runner: runnerSvc,
    ensureReady: (channelId) => projects.ensureReady(channelId),
    resolveClient,
    registerSession,
    startTyping,
    log,
  })
```

Add to `commandDeps` (after `createThread`):

```ts
    forkThread,
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/handlers.test.ts`
Expected: PASS.

- [ ] **Step 10: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add src/commands.ts src/handlers.ts src/index.ts test/commands.test.ts test/handlers.test.ts
git commit -m "feat(commands): add /fork and /btw with session forks and copied worktrees"
```

---

### Task 7: `/last-sessions`

**Files:**
- Modify: `src/commands.ts` (`commandData`, handler)
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `db.threads.byChannel(channelId)` (ordered `last_active_at DESC`).
- Produces: `/last-sessions [count]` — ephemeral (the handler defers with `flags: 64` already), clamped to 1..10, default 5.

- [ ] **Step 1: Write the failing tests**

In `test/commands.test.ts`, update the declared command set:

```ts
test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "btw", "fork", "last-sessions", "model", "new", "project", "resume", "worktree"])
})
```

Append:

```ts
test("last-sessions lists recent threads, default 5, newest first", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  for (let i = 1; i <= 7; i++) db.threads.upsert(threadRow(`t${i}`, "c", { title: `Session ${i}`, lastActiveAt: i }))
  const i = interaction({ commandName: "last-sessions", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  const out = editOf(i)
  expect(out.split("\n")).toHaveLength(5)
  expect(out).toContain("<#t7> — Session 7")
  expect(out).not.toContain("<#t2>")
})

test("last-sessions honours a requested count and caps it at 10", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  for (let i = 1; i <= 12; i++) db.threads.upsert(threadRow(`t${i}`, "c", { title: `Session ${i}`, lastActiveAt: i }))
  const three = interaction({ commandName: "last-sessions", channelId: "c", integers: { count: 3 } })
  await handleCommand(three, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(three).split("\n")).toHaveLength(3)

  const forty = interaction({ commandName: "last-sessions", channelId: "c", integers: { count: 40 } })
  await handleCommand(forty, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(forty).split("\n")).toHaveLength(10)
})

test("last-sessions inside a thread uses the parent project channel", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1", "c", { title: "First" }))
  const i = interaction({ commandName: "last-sessions", channelId: "t1", channel: { isThread: () => true, parentId: "c" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toContain("<#t1> — First")
})

test("last-sessions outside a project is rejected", async () => {
  const i = interaction({ commandName: "last-sessions", channelId: "other" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("this channel is not a project")
})

test("last-sessions with no threads says so", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = interaction({ commandName: "last-sessions", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toBe("no sessions yet")
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `last-sessions` is not declared and replies `not implemented in this build`.

- [ ] **Step 3: Implement the command**

In `commandData()`, append after the `btw` entry:

```ts
    { name: "last-sessions", description: "List recent threads in this channel (ephemeral)", options: [
      { type: ApplicationCommandOptionType.Integer, name: "count", description: "How many to show (default 5, max 10)", required: false } ] }
```

In `handleCommand`, add after the `abort` block and before the `worktree` block:

```ts
    if (interaction.commandName === "last-sessions") {
      const parentId = interaction.channel?.isThread?.() ? interaction.channel.parentId : interaction.channelId
      const project = parentId ? deps.db.projects.getByChannel(parentId) : undefined
      if (!project) return void await interaction.editReply(noMentions("this channel is not a project"))
      const requested = interaction.options.getInteger("count", false) ?? 5
      const count = Math.min(Math.max(requested, 1), 10)
      const threads = deps.db.threads.byChannel(project.channelId).slice(0, count)
      if (threads.length === 0) return void await interaction.editReply(noMentions("no sessions yet"))
      const lines = threads.map((t) => `<#${t.threadId}> — ${t.title ?? t.sessionId}`)
      return void await interaction.editReply(noMentions(lines.join("\n")))
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS, including every pre-existing command test.

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "feat(commands): add ephemeral /last-sessions"
```

---

### Task 8: `/project create clone:` and `branch:`

**Files:**
- Modify: `src/projects.ts` (`CloneOptions`, `validateCloneUrl`, `addProject`/`doAddProject` input, clone after bootstrap)
- Modify: `src/commands.ts` (`commandData` create options, create handler)
- Test: `test/projects.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `Sbx.exec(name, args, opts?)` (argv-only).
- Produces:
  - `export interface CloneOptions { url: string; branch?: string }`
  - `export function validateCloneUrl(url: string): void` (strict single `https://` URL, throws otherwise)
  - `addProject(input: { guildId: string; name: string; directory: string; existingChannelId?: string; clone?: CloneOptions }, onProgress?)`
  - clone argv: `["git", "-C", <sandboxPath>, "clone", ...(branch ? ["--branch", branch] : []), <url>, "."]`

- [ ] **Step 1: Write the failing tests**

Append to `test/projects.test.ts`:

```ts
test("addProject rejects a non-https clone URL before any sbx call", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan1", deleteChannel: async () => {} } as any)
  for (const url of ["http://example.com/a.git", "git@github.com:a/b.git", "https://example.com/a b", "ftp://example.com/a"]) {
    await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo", clone: { url } }))
      .rejects.toThrow(/https/)
  }
  expect(calls).toEqual([])
})

test("addProject clones an https repository after bootstrap with exact argv", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  const order: string[] = []
  let cloneArgs: string[] | undefined
  const baseExec = sbx.exec
  sbx.exec = async (n: string, args: string[]) => { order.push(args.join(" ")); if (args[0] === "git") cloneArgs = args; return baseExec(n, args) }
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {},
      resolveSandboxPath: async () => "/sandbox/celly-demo/workspace" } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo",
      clone: { url: "https://example.com/a.git", branch: "main" } })
    expect(cloneArgs).toEqual(["git", "-C", "/sandbox/celly-demo/workspace", "clone", "--branch", "main", "https://example.com/a.git", "."])
    const prepare = order.findIndex((o) => o.includes("bash"))
    const clone = order.findIndex((o) => o.startsWith("git "))
    expect(clone).toBeGreaterThan(prepare)
  } finally { await server.close() }
})

test("addProject omits --branch when only a clone URL is given", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  const server = await healthServer(true)
  let cloneArgs: string[] | undefined
  const baseExec = sbx.exec
  sbx.exec = async (n: string, args: string[]) => { if (args[0] === "git") cloneArgs = args; return baseExec(n, args) }
  try {
    const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(server.port, server.port), log: logger(),
      isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async () => {},
      resolveSandboxPath: async () => "/sandbox/celly-demo/workspace" } as any)
    await svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo", clone: { url: "https://example.com/a.git" } })
    expect(cloneArgs).toEqual(["git", "-C", "/sandbox/celly-demo/workspace", "clone", "https://example.com/a.git", "."])
  } finally { await server.close() }
})

test("addProject rolls back when the clone fails", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner, calls } = fakes()
  const baseExec = sbx.exec
  sbx.exec = async (n: string, args: string[]) => { if (args[0] === "git") throw new Error("clone failed"); return baseExec(n, args) }
  const deleted: string[] = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true, createChannel: async () => "chan-demo", deleteChannel: async (c: string) => { deleted.push(c) },
    resolveSandboxPath: async () => "/sandbox/celly-demo/workspace" } as any)
  await expect(svc.addProject({ guildId: "g", name: "demo", directory: "C:\\projects\\demo", clone: { url: "https://example.com/a.git" } }))
    .rejects.toThrow(/clone failed/)
  expect(db.projects.list()).toEqual([])
  expect(calls).toContainEqual(["rm", "celly-demo"])
  expect(deleted).toEqual(["chan-demo"])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/projects.test.ts`
Expected: FAIL — the clone option is ignored (no `git` argv captured) and non-https URLs are not rejected.

- [ ] **Step 3: Implement the projects side**

In `src/projects.ts`, add after the imports:

```ts
export interface CloneOptions { url: string; branch?: string }
const CLONE_URL = /^https:\/\/[^\s"'`\\<>]+$/i
export function validateCloneUrl(url: string): void {
  if (!CLONE_URL.test(url)) throw new Error("clone URL must be a single https:// repository URL")
}
```

Change both `addProject` and `doAddProject` input types to:

```ts
    input: { guildId: string; name: string; directory: string; existingChannelId?: string; clone?: CloneOptions },
```

In `doAddProject`, right after `this.validateDirectory(input.directory)`:

```ts
    if (input.clone) validateCloneUrl(input.clone.url)
```

After `const sandboxPath = await this.resolveSandboxPath(channelId, sandboxName, input.directory)` and before `const child = this.bootServer(channelId)`:

```ts
      if (input.clone) {
        await this.report(onProgress, "cloning…")
        const args = ["git", "-C", sandboxPath, "clone"]
        if (input.clone.branch) args.push("--branch", input.clone.branch)
        args.push(input.clone.url, ".")
        await sbx.exec(sandboxName, args, { timeoutMs: 300_000 })
      }
```

- [ ] **Step 4: Run project tests to verify they pass**

Run: `npx vitest run test/projects.test.ts`
Expected: PASS, including every pre-existing saga test.

- [ ] **Step 5: Write the failing command tests**

In `test/commands.test.ts`, append:

```ts
test("project create forwards clone and branch to the create saga", async () => {
  const i = interaction({ sub: "create", strings: { name: "demo", clone: "https://example.com/a.git", branch: "main" } })
  let captured: any
  const projects: any = {
    createProjectDirectory: async () => "C:\\projects\\demo",
    addProject: async (input: any) => { captured = input; return { ...proj, name: "demo" } },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(captured).toEqual({ guildId: "g", name: "demo", directory: "C:\\projects\\demo",
    clone: { url: "https://example.com/a.git", branch: "main" } })
  expect(editOf(i)).toBe("created demo")
})

test("project create omits clone for a plain create", async () => {
  const i = interaction({ sub: "create", strings: { name: "demo" } })
  let captured: any
  const projects: any = {
    createProjectDirectory: async () => "C:\\projects\\demo",
    addProject: async (input: any) => { captured = input; return { ...proj, name: "demo" } },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(captured).toEqual({ guildId: "g", name: "demo", directory: "C:\\projects\\demo" })
  expect(editOf(i)).toBe("created demo")
})

test("project create rejects branch without clone before creating a directory", async () => {
  const i = interaction({ sub: "create", strings: { name: "demo", branch: "main" } })
  const projects: any = {
    createProjectDirectory: async () => { throw new Error("should not run") },
    addProject: async () => { throw new Error("should not run") },
  }
  await handleCommand(i, { projects, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true })
  expect(editOf(i)).toBe("branch requires clone")
})
```

- [ ] **Step 6: Run command tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `captured.clone` is `undefined` and `branch` without `clone` still creates the directory.

- [ ] **Step 7: Implement the command surface**

In `commandData()`, replace the `project` `create` subcommand options:

```ts
    { type: ApplicationCommandOptionType.Subcommand, name: "create", description: "Create a project directory", options: [
      { type: ApplicationCommandOptionType.String, name: "name", description: "Project name", required: true },
      { type: ApplicationCommandOptionType.String, name: "clone", description: "Clone an https git repository into the new directory" },
      { type: ApplicationCommandOptionType.String, name: "branch", description: "Branch to clone (requires clone)" } ] },
```

In `handleCommand`, replace the `if (sub === "add" || sub === "create")` block body:

```ts
      if (sub === "add" || sub === "create") {
        const onProgress = (stage: string) => interaction.editReply(noMentions(stage))
        const cloneUrl = sub === "create" ? interaction.options.getString("clone", false) : null
        const branch = sub === "create" ? interaction.options.getString("branch", false) : null
        if (branch && !cloneUrl) return void await interaction.editReply(noMentions("branch requires clone"))
        const directory = sub === "create" ? await deps.projects.createProjectDirectory(name) : interaction.options.getString("path", true)
        const clone = cloneUrl ? { url: cloneUrl, ...(branch ? { branch } : {}) } : undefined
        const added = await deps.projects.addProject({ guildId: interaction.guildId, name, directory, ...(clone ? { clone } : {}) }, onProgress)
        await deps.postConnected?.(added.channelId, added.name)
        return void await interaction.editReply(noMentions(sub === "create" ? `created ${added.name}` : `added ${added.name}`))
      }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/projects.test.ts test/commands.test.ts`
Expected: PASS.

- [ ] **Step 9: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/projects.ts src/commands.ts test/projects.test.ts test/commands.test.ts
git commit -m "feat(projects): add https clone and branch options to /project create"
```

---

### Task 9: Docs, README, and changeset

**Files:**
- Modify: `docs-site/reference/commands.mdx`
- Modify: `docs-site/reference/architecture.mdx`
- Modify: `docs-site/reference/security.mdx`
- Modify: `README.md`
- Create: `.changeset/worktrees-and-forks.md`

**Interfaces:**
- Consumes: the final command surface from Tasks 4–8.
- Produces: user-facing documentation and a minor changeset; no code.

- [ ] **Step 1: Update `docs-site/reference/commands.mdx`**

Replace the `/project create` row:

```mdx
| `/project create name:<name> [clone:<url>] [branch:<name>]` | owner | Create a directory under `PROJECTS_ROOT`, then add it. `clone` must be a single `https://` repository URL; `branch` requires `clone` and defaults to the remote HEAD. |
```

Add a section after `## Sessions` and before `## Messages and shell`:

```mdx
## Worktrees and forks

| Command | Access | Behavior |
| --- | --- | --- |
| `/worktree status` | authorized | Show this thread's worktree path, branch, and clean/dirty state. |
| `/worktree new [name]` | authorized | Create `<project>/.celly/worktrees/<slug>` on branch `celly/<slug>`; appends `.celly/` to the project's `.gitignore` on first use. |
| `/worktree merge` | owner | Refuse when the worktree or the project root is dirty, then `git merge --no-ff` the worktree branch into the project root. Conflicts are listed by file. |
| `/worktree remove [force]` | authorized | `git worktree remove` this thread's worktree; `force` discards uncommitted changes. |
| `/fork [prompt]` | authorized | Fork this thread's session into a new thread, copying model, agent, and worktree. |
| `/btw <prompt>` | authorized | `/fork` with a `btw · ` title prefix. |
| `/last-sessions [count]` | authorized | Ephemeral list of recent threads in this channel (default 5, max 10). |
```

Update the deferred list: change

```mdx
Features: worktree-per-thread, `/btw` forks, queue UI (`. queue`),
permission-approval buttons, `question` rendered as Discord components, voice
messages, image attachments, OpenCode web UI, tunnels/screenshare, multi-guild,
cloud sandboxes, `--clone` sandbox mode, OAuth subscription login, and
Linux/macOS deployment docs.
```

to

```mdx
Features: queue UI (`. queue`), permission-approval buttons, `question`
rendered as Discord components, voice messages, image attachments, OpenCode
web UI, tunnels/screenshare, multi-guild, cloud sandboxes, OAuth subscription
login, and Linux/macOS deployment docs.
```

- [ ] **Step 2: Update `docs-site/reference/architecture.mdx` module map**

Add after the `src/shell.ts` row in the module table:

```mdx
| `src/worktrees.ts` | Per-thread worktrees: slug/branch/porcelain/merge parsing, `.gitignore` maintenance, and argv-only `sbx exec git …` add/list/status/merge/remove operations. |
```

- [ ] **Step 3: Update `docs-site/reference/security.mdx`**

Add before `## Secrets`:

```mdx
## Worktrees

Thread worktrees live under `<project>/.celly/worktrees/<slug>`, inside the same
mounted project directory and the same per-project microVM as the project root.
They add no new host paths: the `PROJECTS_ROOT` containment and sensitivity
checks still apply, `.celly/` is appended to the project's `.gitignore` on first
use, and every git invocation runs in the sandbox through argv-only `sbx exec`.
`/worktree merge` refuses dirty worktrees and dirty project roots before it
touches the main branch.
```

- [ ] **Step 4: Update `README.md`**

Add to the Features list after the Session resume bullet:

```md
- **Per-thread worktrees.** `/worktree` creates, merges, and removes git
  worktrees under `<project>/.celly/worktrees`, and `/fork` (or `/btw`) forks a
  session with its worktree.
```

Add to the Commands table after the `/agent` row:

```md
| `/worktree status\|new\|merge\|remove` | thread | Manage this thread's git worktree. |
| `/fork [prompt]` / `/btw <prompt>` | thread | Fork this session into a new thread. |
| `/last-sessions [count]` | channel or thread | List recent threads (ephemeral, max 10). |
```

Change the `/project create` row to:

```md
| `/project create <name> [clone] [branch]` | guild (owner) | Create a project directory; optionally `git clone` an https repository. |
```

Update the roadmap list: remove `worktree-per-thread`, `/btw` forks from the
Thread/conversation bullet, and remove `--clone` sandbox mode from the
Scale/deploy bullet, leaving those bullets to read:

```md
- **Thread/conversation:** queue UI, permission approval buttons, `question` as
  Discord components.
```

```md
- **Scale/deploy:** multi-guild, cloud sandboxes, OAuth subscription login,
  Linux/macOS deployment docs.
```

- [ ] **Step 5: Create the changeset**

Create `.changeset/worktrees-and-forks.md`:

```md
---
"celly": minor
---

Add per-thread git worktrees (`/worktree status|new|merge|remove`), session
forks (`/fork`, `/btw`), ephemeral `/last-sessions`, and `clone:`/`branch:`
options for `/project create`.
```

- [ ] **Step 6: Validate docs**

Run: `npm run docs:validate && npm run docs:links`
Expected: PASS. If `npx mint` cannot reach the registry in this environment, record that in the commit message and re-run the commands in CI.

- [ ] **Step 7: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add docs-site/reference/commands.mdx docs-site/reference/architecture.mdx docs-site/reference/security.mdx README.md .changeset/worktrees-and-forks.md
git commit -m "docs: document worktrees, forks, last-sessions, and project create clone"
```

---

## Self-Review

**1. Spec coverage (spec §4.6):**

- Worktree root `<project>/.celly/worktrees/<slug>`: Task 4 (`relative` path and `joinPathLike`).
- `.gitignore` append, log-don't-fail: Task 4 (`ensureGitignoreEntry`, `create still runs git and logs…`).
- Pure helpers with exact names: Task 1.
- Exact git argv: Tasks 4 and 5 (fake-sbx assertions).
- Store worktree path in `threads.worktree_path` without a migration: Task 2.
- Directory routing (`directoryFor`, `query.directory` on create/promptAsync/abort/messages): Task 3. Diff/summarize are conversation-ux's plan and will call `directoryFor` the same way.
- `/fork`, `/btw`, `/last-sessions` (ephemeral, max 10): Tasks 6 and 7.
- `/project create` clone (https-only, branch, rollback): Task 8.
- Acceptance: pure-helper tests (Task 1), exact-argv wiring (Tasks 4/5/8), dirty-check refusal (Task 5), merge-conflict file listing (Task 5), clone rollback (Task 8), directory propagation payloads (Task 3).
- Docs/security/README/changeset: Task 9.

**2. Placeholder scan:** every step carries real test/implementation code; the only conditional is the `npx mint` network note in Task 9, which names the fallback explicitly. No TBD/TODO/"similar to" references.

**3. Identifier consistency:** `worktreeSlug`/`worktreeBranch`/`parseWorktreeList`/`parseStatusPorcelain`/`mergeOutcome` (Task 1) are consumed by `WorktreeService` (Tasks 4–5); `setWorktree` (Task 2) is consumed by Tasks 4–5; `withDirectory`/`directoryFor` (Task 3) are consumed by Task 6's `createForkThread`; `WorktreeCommands` (Task 4, extended Task 5) matches `WorktreeService`'s methods and the `commandDeps.worktree` wiring; `ForkThreadInput`/`ForkedThread`/`createForkThread`/`forkThread` match across commands, handlers, index, and tests; `execResult` (Task 5) is used only by merge/remove.

