# Terminal Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/attach` and `/session-id` so a user can drive the same OpenCode session from a shell inside the project sandbox, and add the `ATTACH_AUTO_THREAD` config that turns terminal-started sessions into Discord threads.

**Architecture:** New pure-text helpers in `src/attach.ts` format the exact `sbx exec ... opencode attach` line; `src/commands.ts` gains two ephemeral commands that read the current thread row. The SSE `EventRouter` gains an optional `onUnknownSession` hook; `src/index.ts` wires it to a resolver that, when `ATTACH_AUTO_THREAD=true`, fetches the session title with `session.get`, creates a Discord thread, and routes the event to it.

**Tech Stack:** TypeScript (ESM, Node `>=24 <25`), discord.js 14, vitest 3, `node:sqlite`, Mintlify docs, Changesets.

**Spec:** docs/superpowers/specs/2026-09-27-vnext-features-design.md

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (guarded by `test/imports.test.ts`). Only `src/opencode.ts` and `src/projects.ts` may build `http://127.0.0.1:${...}` URLs.
- argv-only spawning: `shell: false`, `windowsHide: true`; never interpolate user input into a shell string sent to the host.
- Secrets (Discord token, server passwords, provider keys) never in argv, logs, audit entries, or Discord messages; redact through `src/log.ts`.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and `../src/x.ts` imports.
- Migrations are append-only; never insert into or reorder `MIGRATIONS` in `src/db.ts` (this plan adds none).
- Command changes update `docs-site/reference/commands.mdx` and the README commands table; config changes update `docs-site/guides/configuration.mdx` and `.env.example`; new docs pages register in `docs-site/docs.json`.
- No new npm dependencies.
- Run `npm test`, `npm run typecheck`, and `npm run build` before each commit.

## Worktree

Before Task 1, create an isolated worktree per the `superpowers:using-git-worktrees`
skill: branch `feat/terminal-attach` based on `main`. Run every command, edit, and
commit in that worktree. Do not touch the main checkout (its `docs-site/docs.json`
has unrelated uncommitted merge state; `main` itself is clean and already lists
`guides/terminal-attach` in the docs navigation).

## File Structure

Created:

- `src/attach.ts` — exact attach command line, `/attach` and `/session-id` reply formatting, and the `ATTACH_AUTO_THREAD` resolver. Pure text/factory code: no Discord or SDK imports.
- `test/attach.test.ts` — exact-string formatter tests plus auto-thread gate tests.
- `test/docs.test.ts` — docs-sync guards for the command and config docs.
- `.changeset/terminal-attach.md` — one minor changeset for this plan.

Modified:

- `src/commands.ts` — register `/session-id` and `/attach`; handle both; reply `error: <message>` ephemerally when `deferReply` is unavailable.
- `src/config.ts` — parse `ATTACH_AUTO_THREAD` into `Config.attachAutoThread`.
- `src/events.ts` — optional `EventRouterDeps.onUnknownSession` hook in the SSE consume loop.
- `src/index.ts` — build the resolver with `session.get` and hand it to each project's `EventRouter`.
- `test/commands.test.ts` — interaction fake additions, command-set expectation, handler tests.
- `test/config.test.ts` — `ATTACH_AUTO_THREAD` parsing tests.
- `test/events.test.ts` — unknown-session routing test.
- `.env.example`, `docs-site/guides/configuration.mdx` — config docs.
- `docs-site/guides/terminal-attach.mdx`, `docs-site/reference/commands.mdx`, `README.md` — command and feature docs.
- `docs-site/docs.json` — verify `guides/terminal-attach` is registered; no edit expected.

---

### Task 1: `/session-id` command

**Files:**

- Create: `src/attach.ts`
- Modify: `src/commands.ts:6-28` (`commandData`), `:106-226` (`handleCommand`), `:223-225` (catch)
- Test: `test/attach.test.ts` (create), `test/commands.test.ts:14-33` (helper), `:57-60` (command set), tests appended at end

**Interfaces:**

- Consumes: `Project` from `src/types.ts` (`{ sandboxName: string; channelId: string; ... }`); `Db.threads.get(threadId: string): Thread | undefined` (`Thread.sessionId: string`, `Thread.channelId: string`); `Db.projects.getByChannel(channelId: string): Project | undefined`; `noMentions(content: string, extra?: Record<string, unknown>): any`.
- Produces:
  - `src/attach.ts`: `attachCommand(project: Pick<Project, "sandboxName">, sessionId: string): string`
  - `src/attach.ts`: `sessionIdReply(project: Pick<Project, "sandboxName">, sessionId: string): string`
  - `handleCommand` handles `commandName === "session-id"` and answers `use /session-id inside a thread`, `project not found`, or the session-id reply.

- [ ] **Step 1: Write the failing formatter tests**

Create `test/attach.test.ts`:

```ts
// test/attach.test.ts
import { expect, test } from "vitest"
import { attachCommand, sessionIdReply } from "../src/attach.ts"

test("attachCommand renders the exact sbx exec opencode attach line", () => {
  expect(attachCommand({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'")
})

test("sessionIdReply shows the bare session id and the command behind a spoiler", () => {
  expect(sessionIdReply({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("`ses_abc`\n||sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'||")
})
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/attach.test.ts -t "sessionIdReply"`
Expected: FAIL — cannot resolve import `../src/attach.ts`.

- [ ] **Step 3: Implement the formatters**

Create `src/attach.ts`:

```ts
// src/attach.ts
import type { Project } from "./types.ts"

export const ATTACH_URL = "http://127.0.0.1:4096"

/**
 * Spec §4.1: the exact terminal attach line for a project's sandbox and
 * session. The server password stays inside the sandbox env file, so this
 * command contains no secret.
 */
export function attachCommand(project: Pick<Project, "sandboxName">, sessionId: string): string {
  return `sbx exec -it ${project.sandboxName} bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach ${ATTACH_URL} -s ${sessionId}'`
}

export function sessionIdReply(project: Pick<Project, "sandboxName">, sessionId: string): string {
  return `\`${sessionId}\`\n||${attachCommand(project, sessionId)}||`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/attach.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Extend the interaction fake in `test/commands.test.ts`**

Replace the `interaction` helper (`test/commands.test.ts:14-33`) with:

```ts
function interaction(over: any = {}) {
  const calls: any[] = []
  const strings = over.strings ?? {}
  const i: any = {
    commandName: over.commandName ?? "project",
    guildId: over.guildId ?? "g",
    channelId: over.channelId ?? "c",
    channel: over.channel,
    user: over.user ?? { id: "u1" },
    calls,
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => over.sub,
      getString: (n: string) => strings[n],
    },
    deferReply: async (o: any) => {
      if (over.deferError) throw new Error(over.deferError)
      i.deferred = true
      calls.push({ kind: "defer", o })
    },
    editReply: async (c: any) => { i.replied = true; calls.push({ kind: "edit", c }) },
    reply: async (c: any) => { i.replied = true; calls.push({ kind: "reply", c }) },
  }
  return i
}
```

- [ ] **Step 6: Update the command-set test and add the failing handler tests**

Replace `test/commands.test.ts:57-60` with:

```ts
test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "model", "new", "project", "resume", "session-id"])
})
```

Append at the end of `test/commands.test.ts`:

```ts
test("session-id replies with the bare id and the spoiler command from a thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "session-id", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(i.calls[0]).toEqual({ kind: "defer", o: { flags: 64 } })
  expect(editOf(i)).toBe("`s1`\n||sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s s1'||")
})

test("session-id outside a thread is rejected", async () => {
  const i = interaction({ commandName: "session-id", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("use /session-id inside a thread")
})

test("session-id reports a missing project row", async () => {
  const db = fresh()
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "session-id", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toBe("project not found")
})

test("a failed defer reports error: <message> as an ephemeral reply", async () => {
  const i = interaction({ commandName: "session-id", channelId: "t1", deferError: "defer failed" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "error: defer failed", flags: 64, allowedMentions: { parse: [] } } })
})
```

- [ ] **Step 7: Run the failing handler tests**

Run: `npx vitest run test/commands.test.ts -t "session-id"`
Expected: FAIL — replies say `not implemented in this build`.

- [ ] **Step 8: Implement the command**

In `src/commands.ts`, add the import at the top:

```ts
import { sessionIdReply } from "./attach.js"
```

In `commandData()` append the command to the returned array (`src/commands.ts:22-27`):

```ts
    { name: "agent", description: "Choose the agent for this thread" },
    { name: "session-id", description: "Show this thread's OpenCode session id" } ]
```

In `handleCommand`, insert this branch immediately before the final `await interaction.editReply(noMentions("not implemented in this build"))` line (`src/commands.ts:222`):

```ts
    if (interaction.commandName === "session-id") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions("use /session-id inside a thread"))
      const project = deps.db.projects.getByChannel(thread.channelId)
      if (!project) return void await interaction.editReply(noMentions("project not found"))
      return void await interaction.editReply(noMentions(sessionIdReply(project, thread.sessionId)))
    }
```

Replace the `handleCommand` catch (`src/commands.ts:223-225`) with:

```ts
  } catch (e) {
    const content = `error: ${(e as Error).message}`
    if (interaction.deferred || interaction.replied) return void await interaction.editReply(noMentions(content))
    await interaction.reply(noMentions(content, { flags: 64 }))
  }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/attach.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/attach.ts src/commands.ts test/attach.test.ts test/commands.test.ts
git commit -m "feat(commands): add /session-id"
```

---

### Task 2: `/attach` command

**Files:**

- Modify: `src/attach.ts` (add `attachReply`), `src/commands.ts:22-27`, `:222` (combined branch)
- Test: `test/attach.test.ts`, `test/commands.test.ts`

**Interfaces:**

- Consumes: `attachCommand(project, sessionId): string` from Task 1.
- Produces:
  - `src/attach.ts`: `attachReply(project: Pick<Project, "sandboxName">, sessionId: string): string`
  - `handleCommand` handles `commandName === "attach"` and answers `use /attach inside a thread`, `project not found`, or the code-block reply.

- [ ] **Step 1: Write the failing formatter test**

In `test/attach.test.ts`, change the import line to:

```ts
import { attachCommand, attachReply, sessionIdReply } from "../src/attach.ts"
```

Append:

````ts
test("attachReply wraps the exact command in a code block", () => {
  expect(attachReply({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("```\nsbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'\n```")
})
````

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/attach.test.ts -t "attachReply"`
Expected: FAIL — `attachReply` is not exported.

- [ ] **Step 3: Implement `attachReply`**

Append to `src/attach.ts`:

````ts
export function attachReply(project: Pick<Project, "sandboxName">, sessionId: string): string {
  return ["```", attachCommand(project, sessionId), "```"].join("\n")
}
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/attach.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Update the command-set test and add the failing handler tests**

Replace the expected array in `test/commands.test.ts`:

```ts
  expect(names).toEqual(["abort", "agent", "attach", "model", "new", "project", "resume", "session-id"])
```

Append at the end of `test/commands.test.ts`:

````ts
test("attach replies with the code-block command from a thread", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "attach", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(i.calls[0]).toEqual({ kind: "defer", o: { flags: 64 } })
  expect(editOf(i)).toBe("```\nsbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s s1'\n```")
})

test("attach outside a thread is rejected", async () => {
  const i = interaction({ commandName: "attach", channelId: "c" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true })
  expect(editOf(i)).toBe("use /attach inside a thread")
})

test("attach reports a missing project row", async () => {
  const db = fresh()
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "attach", channelId: "t1" })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(editOf(i)).toBe("project not found")
})
````

- [ ] **Step 6: Run the failing handler tests**

Run: `npx vitest run test/commands.test.ts -t "attach"`
Expected: FAIL — replies say `not implemented in this build` and the command-set test fails.

- [ ] **Step 7: Implement the command**

In `src/commands.ts`, extend the import:

```ts
import { attachReply, sessionIdReply } from "./attach.js"
```

In `commandData()`, append:

```ts
    { name: "session-id", description: "Show this thread's OpenCode session id" },
    { name: "attach", description: "Show the terminal attach command for this thread" } ]
```

Replace the Task 1 session-id branch with the combined branch:

```ts
    if (interaction.commandName === "attach" || interaction.commandName === "session-id") {
      const thread = deps.db.threads.get(interaction.channelId)
      if (!thread) return void await interaction.editReply(noMentions(`use /${interaction.commandName} inside a thread`))
      const project = deps.db.projects.getByChannel(thread.channelId)
      if (!project) return void await interaction.editReply(noMentions("project not found"))
      const content = interaction.commandName === "attach"
        ? attachReply(project, thread.sessionId)
        : sessionIdReply(project, thread.sessionId)
      return void await interaction.editReply(noMentions(content))
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/attach.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/attach.ts src/commands.ts test/attach.test.ts test/commands.test.ts
git commit -m "feat(commands): add /attach"
```

---

### Task 3: `ATTACH_AUTO_THREAD` config + auto-thread routing

**Files:**

- Modify: `src/config.ts:5-14` (Config), `:47-51` (helpers), `:56-81` (loadConfig); `src/events.ts:75-80` (deps), `:107-118` (consume); `src/index.ts:12-13` (imports), `:249-267` (EventRouter wiring), after `:333` (resolver)
- Test: `test/config.test.ts`, `test/attach.test.ts`, `test/events.test.ts`

**Interfaces:**

- Consumes: `createThreadForProject(input: CreateThreadInput): Promise<{ threadId: string; sessionId: string; notice?: string }>` (`src/index.ts:315`); `resolveClient(project: Project): OpencodeClient` (`src/opencode.ts:16`); `sdk.session.get({ path: { id: string } })` returning `{ data: { title: string } }` (SDK v1).
- Produces:
  - `Config.attachAutoThread: boolean` (default `false`).
  - `src/attach.ts`: `AutoThreadDeps` and `createAutoThreadResolver(deps: AutoThreadDeps): (project: Project, sessionId: string) => Promise<string | undefined>`.
  - `EventRouterDeps.onUnknownSession?(sessionId: string): Promise<string | undefined>`.
  - Wired behavior: with the flag on, an event for an unknown session creates a Discord thread titled from `session.get` and routes the event there; with the flag off, the event is dropped exactly as before.

- [ ] **Step 1: Write the failing config test**

Append to `test/config.test.ts`:

```ts
test("parses ATTACH_AUTO_THREAD as a boolean defaulting to false", () => {
  expect(loadConfig(base).attachAutoThread).toBe(false)
  expect(loadConfig({ ...base, ATTACH_AUTO_THREAD: "true" }).attachAutoThread).toBe(true)
  expect(loadConfig({ ...base, ATTACH_AUTO_THREAD: "1" }).attachAutoThread).toBe(true)
  expect(loadConfig({ ...base, ATTACH_AUTO_THREAD: "false" }).attachAutoThread).toBe(false)
  expect(() => loadConfig({ ...base, ATTACH_AUTO_THREAD: "maybe" })).toThrow(/ATTACH_AUTO_THREAD/)
})
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/config.test.ts -t "ATTACH_AUTO_THREAD"`
Expected: FAIL — `attachAutoThread` is undefined and `maybe` does not throw.

- [ ] **Step 3: Implement the config**

In `src/config.ts`, add to the `Config` interface after `maxConcurrentRuns`:

```ts
export interface Config {
  discordToken: string; guildId: string; projectsRoot: string
  accessRoleId?: string; blockRoleId?: string; ownerRoleId?: string; categoryId?: string
  sandboxTemplate: string; sandboxCpus: number; sandboxMemory: string
  portRangeStart: number; portRangeEnd: number
  defaultModel?: string; defaultAgent?: string
  bootTimeoutMs: number; healthTimeoutMs: number; editIntervalMs: number
  attachmentMaxBytes: number; maxQueue: number; maxConcurrentRuns: number
  attachAutoThread: boolean
  dataDir: string; logLevel: "debug" | "info" | "warn" | "error"
}
```

Add the boolean helper after `int` (`src/config.ts:47-51`):

```ts
const bool = (e: NodeJS.ProcessEnv, k: string, d: boolean): boolean => {
  const raw = e[k]?.trim().toLowerCase()
  if (raw === undefined || raw === "") return d
  if (raw === "true" || raw === "1") return true
  if (raw === "false" || raw === "0") return false
  throw new Error(`${k} must be a boolean, got "${e[k]}"`)
}
```

Add to the `loadConfig` return, after `maxConcurrentRuns`:

```ts
    maxQueue: int(env, "MAX_QUEUE", 20, 1), maxConcurrentRuns: int(env, "MAX_CONCURRENT_RUNS", 4, 1),
    attachAutoThread: bool(env, "ATTACH_AUTO_THREAD", false),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (all config tests, including the new one).

- [ ] **Step 5: Write the failing auto-thread gate tests**

In `test/attach.test.ts`, extend the import line:

```ts
import { attachCommand, attachReply, createAutoThreadResolver, sessionIdReply } from "../src/attach.ts"
```

Append:

```ts
const autoProject = {
  channelId: "c", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null,
  sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", status: "ready", createdAt: 1,
} as const

test("auto-thread gate drops unknown sessions when disabled", async () => {
  const created: any[] = []
  const resolve = createAutoThreadResolver({
    enabled: false,
    sessionTitle: async () => "terminal work",
    createThread: async (input) => { created.push(input); return { threadId: "t1" } },
    log: { warn: () => {} },
  })
  expect(await resolve(autoProject, "s1")).toBeUndefined()
  expect(created).toEqual([])
})

test("auto-thread gate creates a thread titled by the session title", async () => {
  const created: any[] = []
  const resolve = createAutoThreadResolver({
    enabled: true,
    sessionTitle: async (_project, sessionId) => (sessionId === "s1" ? "terminal work" : undefined),
    createThread: async (input) => { created.push(input); return { threadId: "t1" } },
    log: { warn: () => {} },
  })
  expect(await resolve(autoProject, "s1")).toBe("t1")
  expect(created).toEqual([{ channelId: "c", title: "terminal work", sessionId: "s1" }])
})

test("auto-thread gate falls back to a generated title and drops on lookup failure", async () => {
  const created: any[] = []
  const warns: string[] = []
  const resolve = createAutoThreadResolver({
    enabled: true,
    sessionTitle: async () => undefined,
    createThread: async (input) => { created.push(input); return { threadId: "t1" } },
    log: { warn: (message) => { warns.push(message) } },
  })
  expect(await resolve(autoProject, "s1")).toBe("t1")
  expect(created).toEqual([{ channelId: "c", title: "session s1", sessionId: "s1" }])

  const failing = createAutoThreadResolver({
    enabled: true,
    sessionTitle: async () => { throw new Error("gone") },
    createThread: async () => { throw new Error("must not create") },
    log: { warn: (message) => { warns.push(message) } },
  })
  expect(await failing(autoProject, "s1")).toBeUndefined()
  expect(warns).toEqual(["auto-thread session lookup failed"])
})
```

- [ ] **Step 6: Run the failing gate tests**

Run: `npx vitest run test/attach.test.ts -t "auto-thread"`
Expected: FAIL — `createAutoThreadResolver` is not exported.

- [ ] **Step 7: Implement the resolver**

Add to the top of `src/attach.ts`:

```ts
import type { CreateThreadInput } from "./commands.ts"
```

Append to `src/attach.ts`:

```ts
export interface AutoThreadDeps {
  enabled: boolean
  sessionTitle(project: Project, sessionId: string): Promise<string | undefined>
  createThread(input: CreateThreadInput): Promise<{ threadId: string }>
  log: { warn(message: string, fields?: Record<string, unknown>): void }
}

/**
 * Spec §4.1: when ATTACH_AUTO_THREAD is on, an event for a session with no
 * Discord thread creates one first. Returns the new thread id, or undefined
 * (drop the event) when disabled, when the title lookup fails, or when thread
 * creation fails.
 */
export function createAutoThreadResolver(deps: AutoThreadDeps): (project: Project, sessionId: string) => Promise<string | undefined> {
  return async (project, sessionId) => {
    if (!deps.enabled) return undefined
    let title: string | undefined
    try {
      title = await deps.sessionTitle(project, sessionId)
    } catch (e) {
      deps.log.warn("auto-thread session lookup failed", { sessionId, error: String(e) })
      return undefined
    }
    try {
      const created = await deps.createThread({ channelId: project.channelId, title: title?.trim() || `session ${sessionId}`, sessionId })
      return created.threadId
    } catch (e) {
      deps.log.warn("auto-thread creation failed", { sessionId, error: String(e) })
      return undefined
    }
  }
}
```

- [ ] **Step 8: Run the gate tests to verify they pass**

Run: `npx vitest run test/attach.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Write the failing event-router test**

Append to `test/events.test.ts` (the `waitFor` helper is defined at `test/events.test.ts:59`):

```ts
test("asks onUnknownSession for an unknown session and routes the event to the created thread", async () => {
  const events: Array<{ threadId: string; e: any }> = []
  const looked: string[] = []
  let connections = 0
  const server = createServer((_req, res) => {
    connections++
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    if (connections === 1) {
      res.write(`data: ${JSON.stringify({ payload: { type: "session.idle", properties: { sessionID: "terminal-1" } } })}\n\n`)
      res.end()
    }
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const router = new EventRouter({
      route: () => undefined,
      onEvent: (threadId, e) => events.push({ threadId, e }),
      onResync: async () => {},
      knownSessions: () => [],
      onUnknownSession: async (sessionId) => { looked.push(sessionId); return `auto:${sessionId}` },
    })
    const ac = new AbortController()
    const done = router.subscribe(`http://127.0.0.1:${port}`, "pw", ac.signal)
    await waitFor(() => events.length >= 1)
    ac.abort()
    await done
    expect(looked).toEqual(["terminal-1"])
    expect(events).toEqual([{ threadId: "auto:terminal-1", e: { kind: "idle", sessionId: "terminal-1" } }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
```

- [ ] **Step 10: Run the failing event-router test**

Run: `npx vitest run test/events.test.ts -t "onUnknownSession"`
Expected: FAIL — the event is dropped because `onUnknownSession` is not called.

- [ ] **Step 11: Implement the event-router hook**

In `src/events.ts`, replace `EventRouterDeps` (`src/events.ts:75-80`) with:

```ts
export interface EventRouterDeps {
  route(sessionId: string): string | undefined
  onEvent(threadId: string, e: NormalizedEvent): void
  onResync(threadId: string, sessionId: string): Promise<void>
  knownSessions(): { threadId: string; sessionId: string }[]
  onUnknownSession?(sessionId: string): Promise<string | undefined>
}
```

In `subscribe`, replace `consume` (`src/events.ts:107-118`) with:

```ts
        const consume = async (): Promise<void> => {
          let m: RegExpExecArray | null
          while ((m = FRAME_BOUNDARY.exec(buf))) {
            const block = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length)
            const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
            if (!data) continue
            let parsed: any; try { parsed = JSON.parse(data) } catch { continue }
            const e = normalizeEvent(parsed); if (!e) continue
            let threadId = this.deps.route(e.sessionId)
            if (!threadId && this.deps.onUnknownSession) {
              try { threadId = await this.deps.onUnknownSession(e.sessionId) }
              catch (err) { console.warn("onUnknownSession failed", err) }
            }
            if (threadId) this.deps.onEvent(threadId, e)
          }
        }
```

Then await both call sites:

```ts
          if (done) { buf += decoder.decode(); await consume(); break }
          buf += decoder.decode(value, { stream: true })
          await consume()
```

- [ ] **Step 12: Run the event tests to verify they pass**

Run: `npx vitest run test/events.test.ts`
Expected: PASS (all tests, including the pre-existing SSE routing tests).

- [ ] **Step 13: Wire the resolver in `src/index.ts`**

Add the import near the other local imports (`src/index.ts:12-13`):

```ts
import { commandData, handleCommand, handleSelect } from "./commands.js"
import type { CommandDeps, CreateThreadInput } from "./commands.js"
import { createAutoThreadResolver } from "./attach.js"
```

In `subscribeProject`, add the hook to the `EventRouter` deps (`src/index.ts:254-264`), directly after `onResync`:

```ts
      onResync: async (threadId, sessionId) => { await runnerSvc.recover({ threadId, sessionId }) },
      onUnknownSession: (sessionId) => autoThread(project, sessionId),
```

Immediately after the `createThreadForProject` function (`src/index.ts:333`), add:

```ts
  const autoThread = createAutoThreadResolver({
    enabled: cfg.attachAutoThread,
    sessionTitle: async (project, sessionId) => {
      const sdk = resolveClient(project)
      const res: any = await sdk.session.get({ path: { id: sessionId } })
      const data = res?.data ?? res
      const title = typeof data?.title === "string" ? data.title.trim() : ""
      return title || undefined
    },
    createThread: createThreadForProject,
    log,
  })
```

(`subscribeProject` only calls `autoThread` from event callbacks, which run after `main` finishes wiring, so the declaration order is safe.)

- [ ] **Step 14: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS (all test files).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 15: Commit**

```bash
git add src/attach.ts src/config.ts src/events.ts src/index.ts test/attach.test.ts test/config.test.ts test/events.test.ts
git commit -m "feat(attach): auto-create threads for terminal-started sessions"
```

---

### Task 4: Docs + changeset

**Files:**

- Create: `test/docs.test.ts`, `.changeset/terminal-attach.md`
- Modify: `docs-site/reference/commands.mdx:28-65`, `README.md:130-146`, `docs-site/guides/terminal-attach.mdx` (whole file), `docs-site/guides/configuration.mdx:20-43`, `.env.example:32-35`

**Interfaces:**

- Consumes: the `/attach` and `/session-id` behavior from Tasks 1–2 and `ATTACH_AUTO_THREAD` from Task 3.
- Produces: documentation on every surface the global constraints name, plus one minor changeset.

- [ ] **Step 1: Write the failing docs-sync tests**

Create `test/docs.test.ts`:

```ts
// test/docs.test.ts
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

test("commands reference and README list /attach and /session-id", () => {
  const commands = read("../docs-site/reference/commands.mdx")
  const readme = read("../README.md")
  for (const doc of [commands, readme]) {
    expect(doc).toContain("`/attach`")
    expect(doc).toContain("`/session-id`")
  }
})

test("terminal attach guide documents the exact attach command and ATTACH_AUTO_THREAD", () => {
  const guide = read("../docs-site/guides/terminal-attach.mdx")
  expect(guide).toContain("ATTACH_AUTO_THREAD")
  expect(guide).toContain("sbx exec -it")
  expect(guide).toContain("exec opencode attach http://127.0.0.1:4096 -s")
})

test("configuration docs and .env.example list ATTACH_AUTO_THREAD", () => {
  expect(read("../docs-site/guides/configuration.mdx")).toContain("ATTACH_AUTO_THREAD")
  expect(read("../.env.example")).toContain("ATTACH_AUTO_THREAD")
})

test("the terminal attach guide states the web UI is not published", () => {
  expect(read("../docs-site/guides/terminal-attach.mdx")).toContain("intentionally not published")
})
```

- [ ] **Step 2: Run the failing docs tests**

Run: `npx vitest run test/docs.test.ts`
Expected: FAIL — the docs do not mention the new commands or config yet.

- [ ] **Step 3: Update the commands reference**

In `docs-site/reference/commands.mdx`, add to the Sessions table (`:30-36`) after the `/agent` row:

```mdx
| `/attach` | thread | Show the exact `sbx exec` + `opencode attach` command for this thread's session (ephemeral). |
| `/session-id` | thread | Show this thread's session id and the attach command behind a spoiler (ephemeral). |
```

In the "Deferred to v1.1" section (`:56-65`), remove `OpenCode web UI, ` from the features list and add after that paragraph:

```mdx
The OpenCode web UI is intentionally not published (the sandbox server stays
loopback-only); attach from a terminal instead — see the
[terminal attach guide](/guides/terminal-attach).
```

- [ ] **Step 4: Update the README commands table**

In `README.md`, add after the `/agent` row (`:145`):

```md
| `/attach` | thread | Show the terminal attach command for this thread. |
| `/session-id` | thread | Show this thread's session id and attach command. |
```

- [ ] **Step 5: Rewrite the terminal attach guide**

Replace the entire contents of `docs-site/guides/terminal-attach.mdx` with:

````mdx
---
title: Terminal attach
description: Drive the same OpenCode sessions from a shell inside the sandbox, alongside Discord.
---

Sessions live in the sandbox's OpenCode storage, so Discord threads and a
terminal attached to the same sandbox share the same conversations. This is
useful for hands-on work while Celly keeps the sandbox awake and streams to
Discord.

## Attach from Discord

Inside a thread, run `/attach` to get the exact command for that thread's
session (the reply is ephemeral, so only you see it):

```text
sbx exec -it <sandboxName> bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s <sessionId>'
```

`/session-id` returns just the session id plus the same command behind a
spoiler, which is handy when you want to type the `-s <id>` yourself.

## Attach from a terminal

Open a shell in the project's sandbox, load the generated server environment,
then attach to the running server:

```bash
sbx exec -it <sandbox> bash
```

Inside the sandbox:

```bash
set -a; . ~/.config/celly/opencode.env; set +a
opencode attach http://127.0.0.1:4096
```

<Note>
Replace `<sandbox>` with the project's sandbox name (`celly-<slug>`). You can
find it with `/project status <name>`, which reports the host port, or from
`sbx ls`.
</Note>

`opencode attach` accepts `-c/--continue`, `-s/--session <id>`, and
`-p/--password` (defaults to `OPENCODE_SERVER_PASSWORD`), plus `--dir`. Run
`opencode attach --help` in the sandbox for the exact semantics of your
installed OpenCode version.

## What is shared

- The `opencode serve` process is the same one Celly supervises, so sessions
  created in Discord appear in the terminal and vice versa.
- The server password lives in `~/.config/celly/opencode.env` inside the
  sandbox (mode `0600`) and in the bot database. Sourcing it is what lets
  `opencode attach` authenticate to the loopback server.
- `/project status` shows the sandbox state, host port, and session count. Any
  reply that would contain the server password is ephemeral and masked.

## Caveat: terminal-started sessions

By default, a session you start **only** from the terminal, with no Discord
thread behind it, is not routed to Discord. The event router only renders turns
into a thread that owns the session; terminal-originated turns are rendered
into the owning session's most recent thread **if one exists**, otherwise they
are ignored.

Set `ATTACH_AUTO_THREAD=true` to change that: the first event for an unknown
session creates a Discord thread titled after the session's title (fetched from
the server) and then routes events normally. Sessions with no project channel
are still dropped.

To keep a conversation on both surfaces, either enable `ATTACH_AUTO_THREAD` or
start it from Discord (or `/resume` it into a thread) and then attach from the
terminal.

<Warning>
An active `sbx exec` session holds the sandbox awake. Stopping the serve child
or the sandbox from the terminal will mark the project degraded in Discord; the
next prompt or `/project start` re-establishes it.
</Warning>

## Web UI

The OpenCode web UI is intentionally not published. `sbx` maps one loopback
host port per sandbox port, and exposing `4096` to the host network would break
the loopback-only invariant that protects the server password and session data.
Terminal attach is the supported out-of-Discord path.

## Related

- [Commands](/reference/commands) — `/attach`, `/session-id`, `/project status`, `/resume`, and the rest.
- [Deployment](/guides/deployment) — running Celly as a service.
````

- [ ] **Step 6: Update configuration docs and `.env.example`**

In `docs-site/guides/configuration.mdx`, add after the `MAX_CONCURRENT_RUNS` row (`:41`):

```mdx
| `ATTACH_AUTO_THREAD` | `false` | Auto-create a Discord thread for a terminal-started session on its first event. |
```

In `.env.example`, add after the Limits block (`:35`):

```
# # Terminal attach.
# ATTACH_AUTO_THREAD=false
```

- [ ] **Step 7: Run the docs tests to verify they pass**

Run: `npx vitest run test/docs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Verify the docs build inputs**

Run: `rg "guides/terminal-attach" docs-site/docs.json`
Expected: one match — the page is already registered; if it is missing (only possible on a base without it), add `"guides/terminal-attach"` to the Guides pages array.

Run: `npm run docs:validate`
Expected: PASS (requires network for `npx mint`).

Run: `npm run docs:links`
Expected: PASS, no broken links.

- [ ] **Step 9: Add the changeset**

Create `.changeset/terminal-attach.md`:

```md
---
"celly": minor
---

Add `/attach` and `/session-id` for driving the same OpenCode session from a terminal inside the sandbox, and add the optional `ATTACH_AUTO_THREAD` setting to auto-create Discord threads for terminal-started sessions.
```

- [ ] **Step 10: Run the full suite, typecheck, and build**

Run: `npm test`
Expected: PASS (all test files).

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add .changeset/terminal-attach.md docs-site/reference/commands.mdx docs-site/guides/terminal-attach.mdx docs-site/guides/configuration.mdx README.md .env.example test/docs.test.ts
git commit -m "docs(attach): document terminal attach and add changeset"
```

---

## Self-Review

**Spec coverage (spec §4.1):**

- `/attach` ephemeral for the current thread's session with the exact `sbx exec -it <sandboxName> ... opencode attach http://127.0.0.1:4096 -s <sessionId>` line: Task 2.
- `/session-id` ephemeral with `` `<sessionId>` `` plus the command behind a spoiler: Task 1.
- Both require a known thread; missing thread / missing project answers; failures report `error: <message>` with an ephemeral fallback when the interaction cannot be deferred: Task 1 (shared handler path).
- `ATTACH_AUTO_THREAD` boolean default `false`; unknown session with a known project channel auto-creates a thread titled from `session.get` and routes events there; unknown sessions with no project are dropped as today: Task 3.
- Tests cover command output, missing-thread errors, and the auto-thread gate: Tasks 1–3.
- Web UI deliberately not exposed and terminal attach documented as the supported path: Task 4 guide + commands reference.
- Docs updated (`commands.mdx`, README commands table, terminal-attach guide, configuration docs, `.env.example`) and one changeset committed with the final task: Task 4.
- Global constraints: no new dependencies, no migrations, no `child_process`/loopback-URL violations (the attach command is literal `http://127.0.0.1:4096`, no `${...}` URL template in `src/attach.ts`).

**Placeholder scan:** no `TBD`/`TODO`, no "add error handling", every code step contains the exact code, every command step contains the exact command and expected result.

**Identifier consistency:** `attachCommand`, `attachReply`, `sessionIdReply`, `AutoThreadDeps`, `createAutoThreadResolver`, `Config.attachAutoThread`, `EventRouterDeps.onUnknownSession`, and the test helper additions (`interaction.deferred`, `over.deferError`) are used with the same names and signatures across all tasks.

**Deferred to other plans:** `parseCustomIdFull` and the reserved custom-id actions (spec §3.1) belong to approvals/worktrees plans, not this one.
