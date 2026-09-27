# Approvals and Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord approval buttons for permission requests, interactive agent questions (buttons/select/modal), the `/mode` command with `auto`/`buttons`/`plan` policies, v1/v2 permission replies, and a best-effort audit log.

**Architecture:** A new `ApprovalManager` owns pending Discord requests (in memory, no persistence) and talks to the runner through injected send/edit/reply callbacks, so it never imports an SDK client. The runner decides per event with `decidePermission(mode, req)`: `auto` keeps today's `evaluatePermission`, `buttons` answers read-only tools and asks the manager for everything else, `plan` allows only `read`/`glob`/`grep`/`list`/`find`. `src/opencode.ts` gains a v2 client so the runner and manager can reply to v2 permission/question requests; v1 permissions keep using the existing endpoint. `src/audit.ts` appends JSONL decisions.

**Tech Stack:** TypeScript (ESM, Node 24, strict + noUncheckedIndexedAccess), discord.js 14.27, `@opencode-ai/sdk` 1.18.32 (v1 + `@opencode-ai/sdk/v2/client`), vitest, node:sqlite.

**Spec:** docs/superpowers/specs/2026-09-27-vnext-features-design.md

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (guarded by `test/imports.test.ts`). Only `src/opencode.ts` and `src/projects.ts` may build `http://127.0.0.1:${...}` URLs.
- argv-only spawning: `shell: false`, `windowsHide: true`; never interpolate user input into a shell string sent to the host.
- Secrets (Discord token, server passwords, provider keys) never in argv, logs, audit entries, or Discord messages. Redact through `src/log.ts`.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and `../src/x.ts` imports. Temp dirs via `mkdtempSync(join(tmpdir(), "celly-...-")); try { } finally { rmSync(...) }`.
- No new npm dependencies: the v2 client is already `@opencode-ai/sdk/v2/client`.
- Command changes update `docs-site/reference/commands.mdx` and the README commands table; config changes update `docs-site/guides/configuration.mdx` and `.env.example`; security-relevant changes update `docs-site/reference/security.mdx`. This plan adds no docs page, so `docs-site/docs.json` is not touched.
- Custom IDs stay `celly:<action>:<id>[:<extra>]`. Reserved actions used here: `approval`, `answer`, `reject-question`, `mode`. Buttons max 5 per row; `custom_id` max 100 chars; ephemeral replies use `flags: 64`.
- `APPROVAL_MODE` is `auto | buttons | plan`, default `buttons`, seeded once into `settings.approval_mode`. Per-channel override key: `approval_mode:<channelId>`.
- `ApprovalManager` takes type-only `QuestionInfo` imports and injected reply callbacks; it must not build or call an opencode SDK client.
- `NormalizedEvent` existing kinds stay byte-compatible. The `tool.title` and `usage` extensions named in spec §3.2 belong to the conversation-ux and providers-and-cost plans; this plan adds only `permission.source`, `permission-replied`, and `question`.
- Run `npm test`, `npm run typecheck`, and `npm run build` before each commit.

## Worktree

Per `superpowers:using-git-worktrees`, run this plan in its own worktree fresh from `main`:

1. Detect isolation first: if `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir` (and this is not a submodule), you are already in a worktree — keep it.
2. Otherwise use a native worktree tool if available; fallback: `git worktree add .worktrees/approvals-and-questions -b approvals-and-questions` after confirming `.worktrees` is gitignored (add `.worktrees/` to `.gitignore` and commit that first if not).
3. In the worktree run `npm ci`, then `npm test && npm run typecheck && npm run build`. Expected: green. If red, stop and report before changing code.
4. The main checkout currently has an uncommitted merge conflict in `docs-site/docs.json` and the design spec is untracked. A fresh worktree from committed `main` gets the clean `docs.json`; copy `docs/superpowers/specs/2026-09-27-vnext-features-design.md` into the worktree (or commit it on `main` first) so executors can read it.

## File Structure

- `src/audit.ts` (new) — append-only JSONL audit log, mode 0600, `append`/`tail`.
- `src/events.ts` (modify) — `permission.source`, `permission-replied`, `question` normalization.
- `src/opencode.ts` (modify) — `createV2Client`/`resolveV2Client`; question policy becomes `allow` in Task 8.
- `src/mode.ts` (new) — `ApprovalMode` type/resolution and the plan read-only tool set.
- `src/approvals.ts` (new) — `ApprovalManager`, custom-id builders, question component rendering.
- `src/config.ts` (modify) — `APPROVAL_MODE` parsing and seeding.
- `src/runner.ts` (modify) — `decidePermission`, permission/question event routing, injected responders.
- `src/commands.ts` (modify) — `parseCustomIdFull`, interaction handlers, `/mode`.
- `src/handlers.ts` (modify) — `!shell` audit entry.
- `src/index.ts` (modify) — ApprovalManager, v2 clients, audit log, interaction wiring.
- Tests: `test/audit.test.ts`, `test/mode.test.ts`, `test/approvals.test.ts` (new); `test/events.test.ts`, `test/opencode.test.ts`, `test/config.test.ts`, `test/runner.test.ts`, `test/commands.test.ts`, `test/handlers.test.ts` (modify).
- Docs: `docs-site/reference/commands.mdx`, `docs-site/reference/security.mdx`, `docs-site/guides/configuration.mdx`, `README.md`, `.env.example`, `.changeset/approvals-and-questions.md`.

---

### Task 1: Audit log (`src/audit.ts`)

**Files:**
- Create: `src/audit.ts`
- Test: `test/audit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type AuditKind = "permission" | "question" | "shell" | "mode" | "task"`
  - `interface AuditDraft { guildId?: string; channelId?: string; threadId: string; actorId: string; kind: AuditKind; detail: string; decision: string }`
  - `interface AuditEntry { ts: string; guildId?: string; channelId: string; threadId: string; actorId: string; kind: AuditKind; detail: string; decision: string }`
  - `interface AuditLog { append(draft: AuditDraft): void; tail(limit: number): AuditEntry[] }`
  - `createAuditLog(opts: { file: string; clock?: () => number }): AuditLog`

- [ ] **Step 1: Write the failing tests**

Create `test/audit.test.ts`:

```ts
// test/audit.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createAuditLog } from "../src/audit.ts"

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "celly-audit-"))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test("creates the audit file with mode 0600", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl")
    createAuditLog({ file })
    expect(readFileSync(file, "utf8")).toBe("")
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

test("appends one JSON object per line with the injected clock", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl")
    const audit = createAuditLog({ file, clock: () => Date.parse("2026-01-02T03:04:05.000Z") })
    audit.append({ kind: "permission", channelId: "c1", threadId: "t1", actorId: "u1", detail: "bash git push", decision: "reject" })
    audit.append({ kind: "mode", threadId: "c1", actorId: "u2", detail: "approval_mode:c1", decision: "buttons" })
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { ts: "2026-01-02T03:04:05.000Z", channelId: "c1", threadId: "t1", actorId: "u1", kind: "permission", detail: "bash git push", decision: "reject" },
      { ts: "2026-01-02T03:04:05.000Z", channelId: "c1", threadId: "c1", actorId: "u2", kind: "mode", detail: "approval_mode:c1", decision: "buttons" },
    ])
  })
})

test("tail returns the last N entries oldest-first and ignores malformed lines", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl")
    const audit = createAuditLog({ file, clock: () => 0 })
    audit.append({ kind: "shell", channelId: "c1", threadId: "c1", actorId: "u1", detail: "echo one", decision: "run" })
    audit.append({ kind: "shell", channelId: "c1", threadId: "c1", actorId: "u1", detail: "echo two", decision: "run" })
    const raw = readFileSync(file, "utf8")
    rmSync(file)
    writeFileSync(file, `not json\n${raw}`)
    expect(audit.tail(1).map((e) => e.detail)).toEqual(["echo two"])
    expect(audit.tail(10).map((e) => e.detail)).toEqual(["echo one", "echo two"])
    expect(audit.tail(0)).toEqual([])
  })
})

test("tail on a missing file returns an empty list", () => {
  withTempDir((dir) => {
    const audit = createAuditLog({ file: join(dir, "audit.jsonl") })
    rmSync(join(dir, "audit.jsonl"))
    expect(audit.tail(5)).toEqual([])
  })
})

test("append never throws when the file is unwritable", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl")
    const audit = createAuditLog({ file })
    rmSync(file)
    mkdirSync(file)
    expect(() => audit.append({ kind: "shell", channelId: "c1", threadId: "c1", actorId: "u1", detail: "x", decision: "run" })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/audit.test.ts`
Expected: FAIL — `Failed to resolve import "../src/audit.ts"`.

- [ ] **Step 3: Implement `src/audit.ts`**

```ts
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

export type AuditKind = "permission" | "question" | "shell" | "mode" | "task"
export interface AuditDraft {
  guildId?: string
  channelId?: string
  threadId: string
  actorId: string
  kind: AuditKind
  detail: string
  decision: string
}
export interface AuditEntry {
  ts: string
  guildId?: string
  channelId: string
  threadId: string
  actorId: string
  kind: AuditKind
  detail: string
  decision: string
}
export interface AuditLog {
  append(draft: AuditDraft): void
  tail(limit: number): AuditEntry[]
}
const FILE_MODE = 0o600
export function createAuditLog(opts: { file: string; clock?: () => number }): AuditLog {
  const clock = opts.clock ?? Date.now
  try {
    mkdirSync(dirname(opts.file), { recursive: true })
    appendFileSync(opts.file, "", { mode: FILE_MODE })
    chmodSync(opts.file, FILE_MODE)
  } catch (err) {
    console.error(`audit log init failed: ${String(err)}`)
  }
  return {
    append(draft) {
      const entry: AuditEntry = {
        ts: new Date(clock()).toISOString(),
        channelId: draft.channelId ?? draft.threadId,
        threadId: draft.threadId,
        actorId: draft.actorId,
        kind: draft.kind,
        detail: draft.detail,
        decision: draft.decision,
        ...(draft.guildId ? { guildId: draft.guildId } : {}),
      }
      try { appendFileSync(opts.file, JSON.stringify(entry) + "\n", { mode: FILE_MODE }) }
      catch (err) { console.error(`audit append failed: ${String(err)}`) }
    },
    tail(limit) {
      if (limit <= 0) return []
      let raw = ""
      try { raw = readFileSync(opts.file, "utf8") } catch { return [] }
      const entries: AuditEntry[] = []
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try { entries.push(JSON.parse(line)) } catch {}
      }
      return entries.slice(Math.max(0, entries.length - limit))
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/audit.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/audit.ts test/audit.test.ts
git commit -m "feat: add audit log module"
```

---

### Task 2: Normalized events — `permission.source`, `question`, `permission-replied`

**Files:**
- Modify: `src/events.ts`
- Modify: `test/events.test.ts`

**Interfaces:**
- Consumes: `QuestionInfo` (type-only) from `@opencode-ai/sdk/v2`.
- Produces:
  - `{ kind: "permission"; sessionId: string; permissionId: string; source: "v1" | "v2"; tool: string; patterns: string[] }`
  - `{ kind: "permission-replied"; sessionId: string; requestId: string }`
  - `{ kind: "question"; sessionId: string; requestId: string; questions: QuestionInfo[] }`
  - `normalizeEvent` handles `permission.updated`, `permission.asked`, `permission.v2.asked`, `question.asked`, `question.v2.asked`, `permission.replied`.

- [ ] **Step 1: Update existing tests and add failing tests**

In `test/events.test.ts`, add the import at the top:

```ts
import type { QuestionInfo } from "@opencode-ai/sdk/v2"
```

Change the two existing permission expectations to include `source: "v1"`:

```ts
test("normalizes a permission request", () => {
  expect(normalizeEvent({ type: "permission.updated", properties: { sessionID: "s1", id: "perm1", tool: "bash", patterns: ["git push *"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "perm1", source: "v1", tool: "bash", patterns: ["git push *"] })
})
```

```ts
test("normalizes the SDK permission shape (type/pattern)", () => {
  expect(normalizeEvent({ type: "permission.updated", properties: { id: "perm1", sessionID: "s1", type: "bash", pattern: ["git push *"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "perm1", source: "v1", tool: "bash", patterns: ["git push *"] })
})
```

Append these tests:

```ts
test("normalizes v2 permission asks from both event spellings", () => {
  expect(normalizeEvent({ type: "permission.asked", properties: { id: "req1", sessionID: "s1", permission: "bash", patterns: ["npm test"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "req1", source: "v2", tool: "bash", patterns: ["npm test"] })
  expect(normalizeEvent({ type: "permission.v2.asked", properties: { id: "req2", sessionID: "s1", action: "edit", resources: ["src/a.ts"] } }))
    .toEqual({ kind: "permission", sessionId: "s1", permissionId: "req2", source: "v2", tool: "edit", patterns: ["src/a.ts"] })
})

test("normalizes question.asked and question.v2.asked into question info", () => {
  const questions = [{ question: "Which database?", header: "Database", options: [{ label: "sqlite", description: "single file" }], custom: true }]
  expect(normalizeEvent({ type: "question.asked", properties: { id: "q1", sessionID: "s1", questions } })).toEqual({
    kind: "question", sessionId: "s1", requestId: "q1",
    questions: [{ question: "Which database?", header: "Database", options: [{ label: "sqlite", description: "single file" }], custom: true }],
  })
  expect(normalizeEvent({ type: "question.v2.asked", properties: { id: "q2", sessionID: "s1", questions } }))
    .toMatchObject({ kind: "question", sessionId: "s1", requestId: "q2" })
})

test("drops malformed questions and options and keeps flags", () => {
  const e = normalizeEvent({ type: "question.asked", properties: { id: "q1", sessionID: "s1", questions: [
    null,
    { header: "no question" },
    { question: "ok", options: [{ label: 7 }, { description: "no label" }, { label: "yes" }], multiple: true, custom: false },
  ] } })
  const expected: QuestionInfo = { question: "ok", header: "", options: [{ label: "yes", description: "" }], multiple: true, custom: false }
  expect(e).toEqual({ kind: "question", sessionId: "s1", requestId: "q1", questions: [expected] })
})

test("normalizes permission.replied from both protocol versions", () => {
  expect(normalizeEvent({ type: "permission.replied", properties: { sessionID: "s1", requestID: "r2", reply: "once" } }))
    .toEqual({ kind: "permission-replied", sessionId: "s1", requestId: "r2" })
  expect(normalizeEvent({ type: "permission.replied", properties: { sessionID: "s1", permissionID: "p1", response: "reject" } }))
    .toEqual({ kind: "permission-replied", sessionId: "s1", requestId: "p1" })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/events.test.ts`
Expected: FAIL — `source` is missing from the old expectations and the new kinds normalize to `null`.

- [ ] **Step 3: Implement the events changes**

At the top of `src/events.ts` add:

```ts
import type { QuestionInfo } from "@opencode-ai/sdk/v2"
```

Replace the `NormalizedEvent` union with:

```ts
export type NormalizedEvent =
  | { kind: "text"; sessionId: string; messageId: string; partId: string; text: string }
  | { kind: "tool"; sessionId: string; messageId: string; partId: string; name: string; status: string }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId: string; message: string }
  | { kind: "permission"; sessionId: string; permissionId: string; source: "v1" | "v2"; tool: string; patterns: string[] }
  | { kind: "permission-replied"; sessionId: string; requestId: string }
  | { kind: "question"; sessionId: string; requestId: string; questions: QuestionInfo[] }
```

Add these helpers next to `toPatterns`:

```ts
function toQuestionInfo(value: unknown): QuestionInfo | null {
  if (!value || typeof value !== "object") return null
  const raw = value as { question?: unknown; header?: unknown; options?: unknown; multiple?: unknown; custom?: unknown }
  if (typeof raw.question !== "string" || !raw.question) return null
  const options: { label: string; description: string }[] = []
  if (Array.isArray(raw.options)) {
    for (const candidate of raw.options) {
      if (!candidate || typeof candidate !== "object") continue
      const option = candidate as { label?: unknown; description?: unknown }
      if (typeof option.label !== "string" || !option.label) continue
      options.push({ label: option.label, description: typeof option.description === "string" ? option.description : "" })
    }
  }
  const info: QuestionInfo = { question: raw.question, header: typeof raw.header === "string" ? raw.header : "", options }
  if (raw.multiple === true) info.multiple = true
  if (raw.custom === false) info.custom = false
  return info
}

function toQuestions(value: unknown): QuestionInfo[] {
  if (!Array.isArray(value)) return []
  const out: QuestionInfo[] = []
  for (const candidate of value) {
    const info = toQuestionInfo(candidate)
    if (info) out.push(info)
  }
  return out
}
```

Replace the `normalizeEvent` switch with:

```ts
export function normalizeEvent(raw: any): NormalizedEvent | null {
  const event = raw?.payload ?? raw
  const p = event?.properties ?? {}
  switch (event?.type) {
    case "message.part.updated": {
      const part = p.part ?? {}
      return partToEvent(part.sessionID ?? p.sessionID, part.messageID, part)
    }
    case "session.idle": return { kind: "idle", sessionId: p.sessionID }
    case "session.error": return { kind: "error", sessionId: p.sessionID, message: errorMessage(p.error) }
    case "permission.updated":
      return { kind: "permission", source: "v1", sessionId: p.sessionID, permissionId: p.id, tool: String(p.tool ?? p.type ?? ""), patterns: toPatterns(p.patterns ?? p.pattern) }
    case "permission.asked":
    case "permission.v2.asked":
      return { kind: "permission", source: "v2", sessionId: p.sessionID, permissionId: p.id, tool: String(p.permission ?? p.action ?? ""), patterns: toPatterns(p.patterns ?? p.resources) }
    case "permission.replied": {
      const requestId = String(p.requestID ?? p.permissionID ?? "")
      return requestId ? { kind: "permission-replied", sessionId: p.sessionID, requestId } : null
    }
    case "question.asked":
    case "question.v2.asked":
      return { kind: "question", sessionId: p.sessionID, requestId: String(p.id ?? ""), questions: toQuestions(p.questions) }
    default: return null
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/events.test.ts`
Expected: PASS. `test/runner.test.ts` still passes because its permission event is not typechecked and `onEvent` ignores `source` until Task 6.

- [ ] **Step 5: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat: normalize v2 permission and question events"
```

---

### Task 3: v2 opencode client helpers

**Files:**
- Modify: `src/opencode.ts`
- Modify: `test/opencode.test.ts`

**Interfaces:**
- Consumes: `basicAuth`, `resolveBaseUrl`, `Project`.
- Produces:
  - `type OpencodeV2Client = ReturnType<typeof createV2SdkClient> & { baseUrl: string; auth: string }`
  - `createV2Client(baseUrl: string, password: string): OpencodeV2Client`
  - `resolveV2Client(p: Project): OpencodeV2Client`

- [ ] **Step 1: Write the failing tests**

In `test/opencode.test.ts`, extend the source import line with `createV2Client` and `resolveV2Client`:

```ts
import { applyAndAssertCellyPolicy, BASH_DENY, basicAuth, buildCellyConfigJson, buildOpencodeEnv, buildServeArgs, cellyPolicy, createClient, createV2Client, resolveBaseUrl, resolveClient, resolveV2Client, waitForHealth } from "../src/opencode.ts"
```

Append:

```ts
test("createV2Client attaches basic auth and calls the v2 API", async () => {
  let auth: string | undefined
  let url: string | undefined
  const server = createServer((req, res) => {
    auth = req.headers.authorization
    url = req.url
    res.writeHead(200, { "content-type": "application/json" }).end("{}")
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const client = createV2Client(`http://127.0.0.1:${port}`, "s3cret")
    await client.session.permission.reply({ sessionID: "s1", requestID: "r1", reply: "once" })
    expect(auth).toBe("Basic " + Buffer.from("opencode:s3cret").toString("base64"))
    expect(url).toBe("/api/session/s1/permission/r1/reply")
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test("resolveV2Client builds the loopback baseUrl from the project", () => {
  const client = resolveV2Client({ hostPort: 4321, serverPassword: "pw" } as any)
  expect(client.baseUrl).toBe("http://127.0.0.1:4321")
  expect(client.auth).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/opencode.test.ts`
Expected: FAIL — `createV2Client`/`resolveV2Client` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/opencode.ts`, add next to the v1 import:

```ts
import { createOpencodeClient as createV2SdkClient } from "@opencode-ai/sdk/v2/client"
```

Add after `resolveClient`:

```ts
export type OpencodeV2Client = ReturnType<typeof createV2SdkClient> & { baseUrl: string; auth: string }
export function createV2Client(baseUrl: string, password: string): OpencodeV2Client {
  const auth = basicAuth(password)
  return Object.assign(createV2SdkClient({ baseUrl, headers: { Authorization: auth }, throwOnError: true }), { baseUrl, auth })
}
export function resolveV2Client(p: Project): OpencodeV2Client {
  return createV2Client(resolveBaseUrl(p), p.serverPassword)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/opencode.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/opencode.ts test/opencode.test.ts
git commit -m "feat: add v2 opencode client helpers"
```

---

### Task 4: Approval manager (`src/approvals.ts`)

**Files:**
- Create: `src/mode.ts` (type only in this task; Task 5 adds resolution)
- Create: `src/approvals.ts`
- Test: `test/approvals.test.ts`

**Interfaces:**
- Consumes: `AuditDraft` from `src/audit.ts` (Task 1); `QuestionInfo` (type-only) from `@opencode-ai/sdk/v2`.
- Produces:
  - `APPROVAL_MODES = ["auto", "buttons", "plan"] as const`, `type ApprovalMode = (typeof APPROVAL_MODES)[number]` (in `src/mode.ts`).
  - `type ApprovalDecision = "once" | "always" | "reject"`, `type ApprovalSource = "v1" | "v2"`.
  - `APPROVAL_ACTION`, `ANSWER_ACTION`, `REJECT_QUESTION_ACTION`, `APPROVAL_TIMEOUT_MS`, `MAX_QUESTION_ROWS`.
  - `approvalCustomId(requestId, decision)`, `answerCustomId(requestId, questionIndex, optionIndex?)`, `rejectQuestionCustomId(requestId)`.
  - `PermissionAsk`, `QuestionAsk`, `ReplyPermissionInput`, `ReplyQuestionInput`, `RejectQuestionInput`, `ApprovalManagerDeps`.
  - `class ApprovalManager` with `requestPermission`, `askQuestion`, `resolvePermission`, `answerOption`, `answerQuestion`, `resolveQuestion`, `rejectQuestion`, `cancel`, `hasPending`.
  - `questionComponents(requestId, questions): any[]`.

- [ ] **Step 1: Create `src/mode.ts`**

```ts
export const APPROVAL_MODES = ["auto", "buttons", "plan"] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]
```

- [ ] **Step 2: Write the failing tests**

Create `test/approvals.test.ts`:

```ts
// test/approvals.test.ts
import { expect, test, vi } from "vitest"
import { ComponentType } from "discord.js"
import {
  APPROVAL_TIMEOUT_MS, ApprovalManager, answerCustomId, approvalCustomId, questionComponents, rejectQuestionCustomId,
  type ApprovalManagerDeps, type PermissionAsk, type QuestionAsk,
} from "../src/approvals.ts"

const question = (over: any = {}) => ({
  question: "Which database?",
  header: "Database",
  options: [{ label: "sqlite", description: "single file" }, { label: "postgres", description: "server" }],
  ...over,
})
const permission: PermissionAsk = { threadId: "t1", sessionId: "s1", requestId: "r1", source: "v1", tool: "bash", patterns: ["npm test"], exact: true }
const questions: QuestionAsk = { threadId: "t1", sessionId: "s1", requestId: "q1", questions: [question()] }

function fake(over: Partial<ApprovalManagerDeps> = {}) {
  const sent: Array<{ threadId: string; content: string; components: any[] }> = []
  const edited: Array<{ threadId: string; messageId: string; content: string; components: any[] }> = []
  const permissionsReplied: any[] = []
  const questionsReplied: any[] = []
  const questionsRejected: any[] = []
  const audits: any[] = []
  let n = 0
  const deps: ApprovalManagerDeps = {
    send: async (threadId, content, components) => { sent.push({ threadId, content, components }); return `m${++n}` },
    edit: async (threadId, messageId, content, components) => { edited.push({ threadId, messageId, content, components }) },
    replyPermission: async (input) => { permissionsReplied.push(input) },
    replyQuestion: async (input) => { questionsReplied.push(input) },
    rejectQuestion: async (input) => { questionsRejected.push(input) },
    modeFor: () => "buttons",
    now: () => 1000,
    timeoutMs: APPROVAL_TIMEOUT_MS,
    audit: (entry) => { audits.push(entry) },
    log: () => {},
    ...over,
  }
  return { deps, sent, edited, permissionsReplied, questionsReplied, questionsRejected, audits }
}

test("requestPermission posts three buttons and resolves the chosen decision", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const pending = manager.requestPermission(permission)
  expect(f.sent[0]!.threadId).toBe("t1")
  const row = f.sent[0]!.components[0]
  expect(row.components.map((c: any) => c.custom_id)).toEqual([
    "celly:approval:r1:once", "celly:approval:r1:always", "celly:approval:r1:reject",
  ])
  expect(manager.resolvePermission("r1", "always", "u1")).toBe(true)
  await expect(pending).resolves.toBe("always")
  expect(f.permissionsReplied).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "r1", source: "v1", reply: "always" }])
  expect(f.edited[0]!.content).toContain("approved always")
  expect(f.audits[0]).toMatchObject({ kind: "permission", actorId: "u1", decision: "always" })
})

test("resolvePermission ignores unknown requests and invalid decisions", () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  expect(manager.resolvePermission("nope", "once", "u1")).toBe(false)
  expect(manager.resolvePermission("nope", "yolo" as any, "u1")).toBe(false)
})

test("requestPermission times out to reject and edits the message", async () => {
  vi.useFakeTimers()
  try {
    const f = fake({ timeoutMs: 1000 })
    const manager = new ApprovalManager(f.deps)
    const pending = manager.requestPermission(permission)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe("reject")
    expect(f.permissionsReplied[0]).toMatchObject({ reply: "reject" })
    expect(f.edited[0]!.content).toMatch(/timed out/)
    expect(f.audits[0]).toMatchObject({ actorId: "timeout", decision: "reject" })
  } finally {
    vi.useRealTimers()
  }
})

test("requestPermission outside buttons mode rejects immediately without posting", async () => {
  const f = fake({ modeFor: () => "plan" })
  const manager = new ApprovalManager(f.deps)
  await expect(manager.requestPermission(permission)).resolves.toBe("reject")
  expect(f.sent).toEqual([])
  expect(f.permissionsReplied).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "r1", source: "v1", reply: "reject" }])
})

test("askQuestion collects multi-question answers in order and replies once", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const input: QuestionAsk = { ...questions, questions: [question(), question({ question: "Deploy?", header: "Deploy", options: [] })] }
  const pending = manager.askQuestion(input)
  expect(f.sent).toHaveLength(1)
  expect(manager.answerOption("q1", 0, 1, "u1")).toBe(true)
  expect(f.questionsReplied).toEqual([])
  expect(manager.answerQuestion("q1", 1, ["yes"], "u2")).toBe(true)
  await expect(pending).resolves.toEqual([["postgres"], ["yes"]])
  expect(f.questionsReplied[0]).toEqual({ threadId: "t1", sessionId: "s1", requestId: "q1", answers: [["postgres"], ["yes"]] })
  expect(f.edited[0]!.content).toContain("answered")
  expect(f.audits).toHaveLength(2)
})

test("resolveQuestion completes a pending request with the full answer matrix", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const pending = manager.askQuestion(questions)
  expect(manager.resolveQuestion("q1", [["postgres"]], "u1")).toBe(true)
  await expect(pending).resolves.toEqual([["postgres"]])
  expect(f.questionsReplied[0]).toMatchObject({ answers: [["postgres"]] })
  expect(manager.resolveQuestion("q1", [["x"]], "u1")).toBe(false)
})

test("askQuestion renders a select above five options and keeps components/custom ids legal", () => {
  const options = Array.from({ length: 8 }, (_, i) => ({ label: `option-${i}`, description: `d${i}` }))
  const rows = questionComponents("r".repeat(32), [question({ options }), question(), question(), question(), question()])
  expect(rows.length).toBeLessThanOrEqual(5)
  expect(rows[0]!.components[0].type).toBe(ComponentType.StringSelect)
  expect(rows[0]!.components[0].options).toHaveLength(8)
  for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(5)
  for (const id of [approvalCustomId("r".repeat(32), "always"), answerCustomId("r".repeat(32), 4, 24), rejectQuestionCustomId("r".repeat(32))]) {
    expect(id.length).toBeLessThanOrEqual(100)
  }
})

test("askQuestion times out to null and rejects the server request", async () => {
  vi.useFakeTimers()
  try {
    const f = fake({ timeoutMs: 1000 })
    const manager = new ApprovalManager(f.deps)
    const pending = manager.askQuestion(questions)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBeNull()
    expect(f.questionsRejected).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "q1" }])
    expect(f.edited[0]!.content).toMatch(/timed out/)
  } finally {
    vi.useRealTimers()
  }
})

test("rejectQuestion resolves null and cancel clears a pending request", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const pendingQuestion = manager.askQuestion(questions)
  expect(manager.rejectQuestion("q1", "u1")).toBe(true)
  await expect(pendingQuestion).resolves.toBeNull()
  expect(f.questionsRejected).toHaveLength(1)

  const pendingPermission = manager.requestPermission(permission)
  manager.cancel("s1", "r1")
  await expect(pendingPermission).resolves.toBe("reject")
  expect(f.edited.some((e) => e.content.includes("no longer active"))).toBe(true)
})

test("askQuestion outside buttons mode rejects without posting", async () => {
  const f = fake({ modeFor: () => "auto" })
  const manager = new ApprovalManager(f.deps)
  await expect(manager.askQuestion(questions)).resolves.toBeNull()
  expect(f.sent).toEqual([])
  expect(f.questionsRejected).toHaveLength(1)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/approvals.test.ts`
Expected: FAIL — `Failed to resolve import "../src/approvals.ts"`.

- [ ] **Step 4: Implement `src/approvals.ts`**

```ts
import { ButtonStyle, ComponentType } from "discord.js"
import type { QuestionInfo } from "@opencode-ai/sdk/v2"
import type { AuditDraft } from "./audit.ts"
import type { ApprovalMode } from "./mode.ts"

export type ApprovalDecision = "once" | "always" | "reject"
export type ApprovalSource = "v1" | "v2"
export const APPROVAL_ACTION = "approval"
export const ANSWER_ACTION = "answer"
export const REJECT_QUESTION_ACTION = "reject-question"
export const APPROVAL_TIMEOUT_MS = 5 * 60_000
export const MAX_QUESTION_ROWS = 4

export interface PermissionAsk {
  threadId: string
  sessionId: string
  requestId: string
  source: ApprovalSource
  tool: string
  patterns: string[]
  exact: boolean
}
export interface QuestionAsk {
  threadId: string
  sessionId: string
  requestId: string
  questions: QuestionInfo[]
}
export interface ReplyPermissionInput {
  threadId: string
  sessionId: string
  requestId: string
  source: ApprovalSource
  reply: ApprovalDecision
}
export interface ReplyQuestionInput {
  threadId: string
  sessionId: string
  requestId: string
  answers: string[][]
}
export interface RejectQuestionInput {
  threadId: string
  sessionId: string
  requestId: string
}
export interface ApprovalManagerDeps {
  send(threadId: string, content: string, components: any[]): Promise<string>
  edit(threadId: string, messageId: string, content: string, components: any[]): Promise<void>
  replyPermission(input: ReplyPermissionInput): Promise<void>
  replyQuestion(input: ReplyQuestionInput): Promise<void>
  rejectQuestion(input: RejectQuestionInput): Promise<void>
  modeFor(threadId: string): ApprovalMode
  now(): number
  timeoutMs: number
  audit?(entry: AuditDraft): void
  log(msg: string, fields?: Record<string, unknown>): void
}

export function approvalCustomId(requestId: string, decision: ApprovalDecision): string {
  return `celly:${APPROVAL_ACTION}:${requestId}:${decision}`
}
export function answerCustomId(requestId: string, questionIndex: number, optionIndex?: number): string {
  const extra = optionIndex === undefined ? `${questionIndex}` : `${questionIndex}.${optionIndex}`
  return `celly:${ANSWER_ACTION}:${requestId}:${extra}`
}
export function rejectQuestionCustomId(requestId: string): string {
  return `celly:${REJECT_QUESTION_ACTION}:${requestId}`
}

function actionRow(components: any[]): any {
  return { type: ComponentType.ActionRow, components }
}
function button(customId: string, label: string, style: ButtonStyle): any {
  return { type: ComponentType.Button, style, custom_id: customId, label: label.slice(0, 80) }
}
function describePermission(input: PermissionAsk): string {
  const patterns = input.patterns.length ? input.patterns.map((p) => `\`${p}\``).join(", ") : "(no patterns)"
  return `tool \`${input.tool}\` · ${patterns}`
}
function decisionText(decision: ApprovalDecision, actorId: string): string {
  if (decision === "once") return `Permission **approved once** by <@${actorId}>.`
  if (decision === "always") return `Permission **approved always** by <@${actorId}>.`
  return `Permission **rejected** by <@${actorId}>.`
}
function describeQuestions(questions: QuestionInfo[]): string {
  return questions.map((q) => q.question).join(" | ").slice(0, 500)
}
function renderQuestions(questions: QuestionInfo[]): string {
  const blocks = questions.map((q, i) => `**${q.header || `Question ${i + 1}`}**\n${q.question}`)
  return `The agent asked:\n\n${blocks.join("\n\n")}`
}
function questionSelectOptions(question: QuestionInfo): any[] {
  const seen = new Set<string>()
  const options: any[] = []
  for (const option of question.options) {
    const label = String(option.label ?? "").trim().slice(0, 100)
    if (!label || seen.has(label)) continue
    seen.add(label)
    const mapped: any = { label, value: label }
    if (option.description) mapped.description = String(option.description).slice(0, 100)
    options.push(mapped)
    if (options.length >= 25) break
  }
  return options
}
export function questionComponents(requestId: string, questions: QuestionInfo[]): any[] {
  const rows: any[][] = []
  const utility: any[] = []
  const visible = questions.slice(0, MAX_QUESTION_ROWS)
  for (let index = 0; index < visible.length; index++) {
    const question = visible[index]!
    const options = question.options.filter((option) => typeof option?.label === "string" && option.label)
    const custom = question.custom !== false || options.length === 0
    if (options.length > 0 && options.length <= 5 && question.multiple !== true) {
      const buttons = options.map((option, optionIndex) =>
        button(answerCustomId(requestId, index, optionIndex), option.label, ButtonStyle.Secondary))
      if (custom && buttons.length < 5) buttons.push(button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary))
      else if (custom) utility.push(button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary))
      rows.push(buttons)
    } else if (options.length > 0) {
      const selectOptions = questionSelectOptions(question)
      rows.push([{
        type: ComponentType.StringSelect,
        custom_id: answerCustomId(requestId, index),
        placeholder: "Choose an answer",
        min_values: 1,
        max_values: question.multiple === true ? Math.max(1, selectOptions.length) : 1,
        options: selectOptions,
      }])
      if (custom) utility.push(button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary))
    } else {
      rows.push([button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary)])
    }
  }
  utility.push(button(rejectQuestionCustomId(requestId), "Reject", ButtonStyle.Danger))
  rows.push(utility)
  return rows.map(actionRow)
}

interface PendingPermission {
  input: PermissionAsk
  messageId: string | null
  resolve(decision: ApprovalDecision): void
  timer: ReturnType<typeof setTimeout>
}
interface PendingQuestion {
  input: QuestionAsk
  messageId: string | null
  answers: (string[] | undefined)[]
  resolve(answers: string[][] | null): void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalManager {
  private permissions = new Map<string, PendingPermission>()
  private questions = new Map<string, PendingQuestion>()
  constructor(private readonly deps: ApprovalManagerDeps) {}

  hasPending(requestId: string): boolean {
    return this.permissions.has(requestId) || this.questions.has(requestId)
  }

  private arm(timer: ReturnType<typeof setTimeout>): void {
    if (typeof (timer as any).unref === "function") (timer as any).unref()
  }
  private async sendSafe(threadId: string, content: string, components: any[]): Promise<string | null> {
    try { return await this.deps.send(threadId, content, components) }
    catch (err) { this.deps.log("approval message send failed", { threadId, error: String(err) }); return null }
  }
  private async editSafe(threadId: string, messageId: string | null, content: string): Promise<void> {
    if (!messageId) return
    try { await this.deps.edit(threadId, messageId, content, []) }
    catch (err) { this.deps.log("approval message edit failed", { threadId, messageId, error: String(err) }) }
  }
  private async replyPermissionSafe(input: PermissionAsk, reply: ApprovalDecision): Promise<void> {
    try {
      await this.deps.replyPermission({ threadId: input.threadId, sessionId: input.sessionId, requestId: input.requestId, source: input.source, reply })
    } catch (err) { this.deps.log("permission reply failed", { requestId: input.requestId, error: String(err) }) }
  }
  private async rejectQuestionSafe(input: QuestionAsk): Promise<void> {
    try {
      await this.deps.rejectQuestion({ threadId: input.threadId, sessionId: input.sessionId, requestId: input.requestId })
    } catch (err) { this.deps.log("question reject failed", { requestId: input.requestId, error: String(err) }) }
  }

  async requestPermission(input: PermissionAsk): Promise<ApprovalDecision> {
    if (this.deps.modeFor(input.threadId) !== "buttons") {
      this.deps.audit?.({ kind: "permission", threadId: input.threadId, actorId: "policy", detail: describePermission(input), decision: "reject" })
      await this.replyPermissionSafe(input, "reject")
      return "reject"
    }
    const components = [actionRow([
      button(approvalCustomId(input.requestId, "once"), "Approve once", ButtonStyle.Success),
      button(approvalCustomId(input.requestId, "always"), "Always allow", ButtonStyle.Primary),
      button(approvalCustomId(input.requestId, "reject"), "Reject", ButtonStyle.Danger),
    ])]
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => { void this.timeoutPermission(input.requestId) }, this.deps.timeoutMs)
      this.arm(timer)
      this.permissions.set(input.requestId, { input, messageId: null, resolve, timer })
    })
    const messageId = await this.sendSafe(input.threadId, `**Permission requested**\n${describePermission(input)}`, components)
    const pending = this.permissions.get(input.requestId)
    if (pending) pending.messageId = messageId
    return decision
  }

  resolvePermission(requestId: string, decision: ApprovalDecision, actorId: string): boolean {
    if (decision !== "once" && decision !== "always" && decision !== "reject") return false
    const pending = this.permissions.get(requestId)
    if (!pending) return false
    this.permissions.delete(requestId)
    clearTimeout(pending.timer)
    this.deps.audit?.({ kind: "permission", threadId: pending.input.threadId, actorId, detail: describePermission(pending.input), decision })
    void this.replyPermissionSafe(pending.input, decision)
    void this.editSafe(pending.input.threadId, pending.messageId, decisionText(decision, actorId))
    pending.resolve(decision)
    return true
  }

  private async timeoutPermission(requestId: string): Promise<void> {
    const pending = this.permissions.get(requestId)
    if (!pending) return
    this.permissions.delete(requestId)
    this.deps.audit?.({ kind: "permission", threadId: pending.input.threadId, actorId: "timeout", detail: describePermission(pending.input), decision: "reject" })
    await this.replyPermissionSafe(pending.input, "reject")
    await this.editSafe(pending.input.threadId, pending.messageId, "Permission request **timed out**; rejected.")
    pending.resolve("reject")
  }

  async askQuestion(input: QuestionAsk): Promise<string[][] | null> {
    if (this.deps.modeFor(input.threadId) !== "buttons") {
      this.deps.audit?.({ kind: "question", threadId: input.threadId, actorId: "policy", detail: describeQuestions(input.questions), decision: "reject" })
      await this.rejectQuestionSafe(input)
      return null
    }
    const answers: (string[] | undefined)[] = input.questions.map((_q, index) => (index >= MAX_QUESTION_ROWS ? [] : undefined))
    const asked = new Promise<string[][] | null>((resolve) => {
      const timer = setTimeout(() => { void this.timeoutQuestion(input.requestId) }, this.deps.timeoutMs)
      this.arm(timer)
      this.questions.set(input.requestId, { input, messageId: null, answers, resolve, timer })
    })
    const messageId = await this.sendSafe(input.threadId, renderQuestions(input.questions), questionComponents(input.requestId, input.questions))
    const pending = this.questions.get(input.requestId)
    if (pending) pending.messageId = messageId
    return asked
  }

  answerOption(requestId: string, questionIndex: number, optionIndex: number, actorId: string): boolean {
    const pending = this.questions.get(requestId)
    const option = pending?.input.questions[questionIndex]?.options[optionIndex]
    if (!option) return false
    return this.answerQuestion(requestId, questionIndex, [option.label], actorId)
  }

  answerQuestion(requestId: string, questionIndex: number, answers: string[], actorId: string): boolean {
    const pending = this.questions.get(requestId)
    if (!pending || questionIndex < 0 || questionIndex >= pending.input.questions.length) return false
    pending.answers[questionIndex] = answers
    this.deps.audit?.({ kind: "question", threadId: pending.input.threadId, actorId, detail: describeQuestions(pending.input.questions), decision: answers.join(", ") || "empty" })
    if (pending.answers.every((answer) => answer !== undefined)) {
      this.questions.delete(requestId)
      clearTimeout(pending.timer)
      this.completeQuestion(pending, pending.answers.map((answer) => answer ?? []), actorId)
    }
    return true
  }

  resolveQuestion(requestId: string, answers: string[][], actorId: string): boolean {
    const pending = this.questions.get(requestId)
    if (!pending || answers.length !== pending.input.questions.length) return false
    this.questions.delete(requestId)
    clearTimeout(pending.timer)
    this.deps.audit?.({ kind: "question", threadId: pending.input.threadId, actorId, detail: describeQuestions(pending.input.questions), decision: answers.map((a) => a.join(", ")).join(" | ") })
    this.completeQuestion(pending, answers, actorId)
    return true
  }

  rejectQuestion(requestId: string, actorId: string): boolean {
    const pending = this.questions.get(requestId)
    if (!pending) return false
    this.questions.delete(requestId)
    clearTimeout(pending.timer)
    this.deps.audit?.({ kind: "question", threadId: pending.input.threadId, actorId, detail: describeQuestions(pending.input.questions), decision: "reject" })
    void this.rejectQuestionSafe(pending.input)
    void this.editSafe(pending.input.threadId, pending.messageId, `Questions **rejected** by <@${actorId}>.`)
    pending.resolve(null)
    return true
  }

  cancel(_sessionId: string, requestId: string): void {
    const permission = this.permissions.get(requestId)
    if (permission) {
      this.permissions.delete(requestId)
      clearTimeout(permission.timer)
      void this.editSafe(permission.input.threadId, permission.messageId, "This request is no longer active.")
      permission.resolve("reject")
      return
    }
    const question = this.questions.get(requestId)
    if (question) {
      this.questions.delete(requestId)
      clearTimeout(question.timer)
      void this.editSafe(question.input.threadId, question.messageId, "This request is no longer active.")
      question.resolve(null)
    }
  }

  private completeQuestion(pending: PendingQuestion, answers: string[][], actorId: string): void {
    try {
      void this.deps.replyQuestion({ threadId: pending.input.threadId, sessionId: pending.input.sessionId, requestId: pending.input.requestId, answers })
        .catch((err) => this.deps.log("question reply failed", { requestId: pending.input.requestId, error: String(err) }))
    } catch (err) {
      this.deps.log("question reply failed", { requestId: pending.input.requestId, error: String(err) })
    }
    void this.editSafe(pending.input.threadId, pending.messageId, `Questions **answered** by <@${actorId}>.`)
    pending.resolve(answers)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/approvals.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mode.ts src/approvals.ts test/approvals.test.ts
git commit -m "feat: add approval manager"
```

---

### Task 5: Mode resolution and plan policy

**Files:**
- Modify: `src/mode.ts`
- Modify: `src/config.ts`
- Modify: `src/runner.ts` (add the pure `decidePermission`)
- Test: `test/mode.test.ts` (new), `test/config.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `evaluatePermission` already in `src/runner.ts`.
- Produces:
  - `isApprovalMode(value: string | undefined): value is ApprovalMode`
  - `approvalModeFor(settings: { get(key: string): string | undefined }, channelId?: string): ApprovalMode`
  - `PLAN_READ_ONLY_TOOLS: Set<string>`
  - `Config.approvalMode: ApprovalMode`
  - `decidePermission(mode: ApprovalMode, req: { tool: string; patterns: string[] }): "once" | "always" | "reject" | "ask"` in `src/runner.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/mode.test.ts`:

```ts
// test/mode.test.ts
import { expect, test } from "vitest"
import { APPROVAL_MODES, approvalModeFor, isApprovalMode, PLAN_READ_ONLY_TOOLS } from "../src/mode.ts"

function settings(entries: Record<string, string>) {
  return { get: (key: string) => entries[key] }
}

test("approvalModeFor prefers the channel override, then the global setting, then buttons", () => {
  expect(approvalModeFor(settings({ "approval_mode:c1": "plan", approval_mode: "auto" }), "c1")).toBe("plan")
  expect(approvalModeFor(settings({ approval_mode: "auto" }), "c1")).toBe("auto")
  expect(approvalModeFor(settings({}), "c1")).toBe("buttons")
  expect(approvalModeFor(settings({ approval_mode: "bogus" }), "c1")).toBe("buttons")
  expect(approvalModeFor(settings({}), undefined)).toBe("buttons")
  expect(APPROVAL_MODES).toEqual(["auto", "buttons", "plan"])
})

test("isApprovalMode narrows only the three known modes", () => {
  expect(isApprovalMode("auto")).toBe(true)
  expect(isApprovalMode("buttons")).toBe(true)
  expect(isApprovalMode("plan")).toBe(true)
  expect(isApprovalMode("yolo")).toBe(false)
  expect(isApprovalMode(undefined)).toBe(false)
})

test("PLAN_READ_ONLY_TOOLS is the read-only allow list", () => {
  expect([...PLAN_READ_ONLY_TOOLS].sort()).toEqual(["find", "glob", "grep", "list", "read"])
})
```

Append to `test/config.test.ts`:

```ts
test("APPROVAL_MODE defaults to buttons and rejects unknown modes", () => {
  expect(loadConfig(base).approvalMode).toBe("buttons")
  expect(loadConfig({ ...base, APPROVAL_MODE: "plan" }).approvalMode).toBe("plan")
  expect(() => loadConfig({ ...base, APPROVAL_MODE: "yolo" })).toThrow(/APPROVAL_MODE/)
})
```

Extend the existing `seedSettings` test with:

```ts
  seedSettings(db, { approvalMode: "plan" })
  expect(store.get("approval_mode")).toBe("plan")
  seedSettings(db, { approvalMode: "auto" })
  expect(store.get("approval_mode")).toBe("plan")
```

In `test/runner.test.ts`, extend the import and append the decision-table tests:

```ts
import { decidePermission, evaluatePermission, normalizeCommand, Runner } from "../src/runner.ts"
```

```ts
test("decidePermission keeps today's policy under auto", () => {
  expect(decidePermission("auto", { tool: "bash", patterns: ["npm test"] })).toBe("once")
  expect(decidePermission("auto", { tool: "bash", patterns: ["git push origin main"] })).toBe("reject")
})

test("decidePermission plan allows only read-only tools", () => {
  for (const tool of ["read", "glob", "grep", "list", "find"]) {
    expect(decidePermission("plan", { tool, patterns: [] }), tool).toBe("once")
  }
  for (const tool of ["bash", "edit", "write", "patch", "external_directory", "webfetch", "task", "totally_unknown_tool"]) {
    expect(decidePermission("plan", { tool, patterns: [] }), tool).toBe("reject")
  }
  expect(decidePermission("plan", { tool: "read", patterns: ["/root/.config/celly/opencode.env"] })).toBe("reject")
})

test("decidePermission buttons auto-allows read-only tools, asks for mutations, and still rejects deny-listed or unknown tools", () => {
  expect(decidePermission("buttons", { tool: "read", patterns: [] })).toBe("once")
  expect(decidePermission("buttons", { tool: "bash", patterns: ["npm test"] })).toBe("ask")
  expect(decidePermission("buttons", { tool: "edit", patterns: ["src/a.ts"] })).toBe("ask")
  expect(decidePermission("buttons", { tool: "bash", patterns: ["git push origin main"] })).toBe("reject")
  expect(decidePermission("buttons", { tool: "totally_unknown_tool", patterns: [] })).toBe("reject")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mode.test.ts test/config.test.ts`
Expected: FAIL — `approvalModeFor`/`isApprovalMode`/`PLAN_READ_ONLY_TOOLS` are not exported and `loadConfig(...).approvalMode` is undefined.

- [ ] **Step 3: Implement `src/mode.ts`**

```ts
export const APPROVAL_MODES = ["auto", "buttons", "plan"] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export function isApprovalMode(value: string | undefined): value is ApprovalMode {
  return value === "auto" || value === "buttons" || value === "plan"
}

export function approvalModeFor(settings: { get(key: string): string | undefined }, channelId?: string): ApprovalMode {
  const channel = channelId ? settings.get(`approval_mode:${channelId}`) : undefined
  if (isApprovalMode(channel)) return channel
  const global = settings.get("approval_mode")
  return isApprovalMode(global) ? global : "buttons"
}

export const PLAN_READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "find"])
```

- [ ] **Step 4: Implement the config changes**

In `src/config.ts` add:

```ts
import { APPROVAL_MODES, isApprovalMode } from "./mode.js"
import type { ApprovalMode } from "./mode.ts"
```

Add `approvalMode: ApprovalMode` to `Config` and extend `seedSettings`:

```ts
export function seedSettings(
  db: { settings: { get(key: string): string | undefined; set(key: string, value: string): void } },
  cfg: { defaultModel?: string; defaultAgent?: string; approvalMode?: string },
): void {
  if (cfg.defaultModel && db.settings.get("default_model") === undefined) db.settings.set("default_model", cfg.defaultModel)
  if (cfg.defaultAgent && db.settings.get("default_agent") === undefined) db.settings.set("default_agent", cfg.defaultAgent)
  if (cfg.approvalMode && db.settings.get("approval_mode") === undefined) db.settings.set("approval_mode", cfg.approvalMode)
}
```

In `loadConfig`, before the `return`:

```ts
  const approvalMode = str(env, "APPROVAL_MODE") ?? "buttons"
  if (!isApprovalMode(approvalMode)) throw new Error(`APPROVAL_MODE must be one of ${APPROVAL_MODES.join(", ")}, got "${approvalMode}"`)
```

and add `approvalMode,` to the returned object.

- [ ] **Step 5: Implement `decidePermission` in `src/runner.ts`**

Add to the imports:

```ts
import { PLAN_READ_ONLY_TOOLS } from "./mode.js"
import type { ApprovalMode } from "./mode.ts"
```

Add next to `evaluatePermission`:

```ts
export function decidePermission(mode: ApprovalMode, req: { tool: string; patterns: string[] }): "once" | "always" | "reject" | "ask" {
  if (mode === "auto") return evaluatePermission(req)
  if (evaluatePermission(req) === "reject") return "reject"
  if (PLAN_READ_ONLY_TOOLS.has(req.tool)) return "once"
  return mode === "plan" ? "reject" : "ask"
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/mode.test.ts test/config.test.ts test/runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mode.ts src/config.ts src/runner.ts test/mode.test.ts test/config.test.ts test/runner.test.ts
git commit -m "feat: add approval mode resolution and plan policy"
```

---

### Task 6: Runner integration — auto, plan, buttons, questions, cancel

**Files:**
- Modify: `src/runner.ts`
- Modify: `test/runner.test.ts`

**Interfaces:**
- Consumes: `decidePermission` (Task 5), `ApprovalManager` public methods (Task 4), `AuditDraft` (Task 1), the `permission.source`/`question`/`permission-replied` events (Task 2).
- Produces in `RunnerDeps`:
  - `approvalModeFor?(channelId: string): ApprovalMode`
  - `respondPermission?(input: PermissionReplyInput): Promise<void>` with `PermissionReplyInput = { source: "v1" | "v2"; threadId: string; sessionId: string; requestId: string; reply: "once" | "always" | "reject" }`
  - `approvals?: Pick<ApprovalManager, "requestPermission" | "askQuestion" | "cancel">`
  - `audit?(entry: AuditDraft): void`

- [ ] **Step 1: Update the existing permission test and add failing tests**

In `test/runner.test.ts`, change the existing permission test's event to include the source:

```ts
test("permission event responds with the evaluated decision", async () => {
  const responses: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {}, postSessionIdPermissionsPermissionId: async (a: any) => { responses.push(a) } }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4 })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", source: "v1", tool: "bash", patterns: ["git push origin main"] })
  expect(responses).toEqual([{ path: { id: "s1", permissionID: "p1" }, body: { response: "reject" } }])
})
```

Append:

```ts
test("v1 and v2 permission replies go through the injected responder", async () => {
  const replies: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "auto",
    respondPermission: async (input: any) => { replies.push(input) },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", source: "v1", tool: "bash", patterns: ["npm test"] })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p2", source: "v2", tool: "bash", patterns: ["npm test"] })
  expect(replies).toEqual([
    { source: "v1", threadId: "t1", sessionId: "s1", requestId: "p1", reply: "once" },
    { source: "v2", threadId: "t1", sessionId: "s1", requestId: "p2", reply: "once" },
  ])
})

test("buttons mode delegates non-read-only permissions to the approval manager", async () => {
  const asked: any[] = []
  const replies: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "buttons",
    respondPermission: async (input: any) => { replies.push(input) },
    approvals: {
      requestPermission: async (input: any) => { asked.push(input); return "once" },
      askQuestion: async () => null,
      cancel: () => {},
    },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "r1", source: "v2", tool: "bash", patterns: ["npm test"] })
  expect(asked).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "r1", source: "v2", tool: "bash", patterns: ["npm test"], exact: true }])
  expect(replies).toEqual([])
})

test("plan mode replies directly without asking", async () => {
  const asked: any[] = []
  const replies: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "plan",
    respondPermission: async (input: any) => { replies.push(input) },
    approvals: { requestPermission: async (input: any) => { asked.push(input); return "once" }, askQuestion: async () => null, cancel: () => {} },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "r1", source: "v1", tool: "read", patterns: ["src/a.ts"] })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "r2", source: "v1", tool: "write", patterns: ["src/a.ts"] })
  expect(replies).toEqual([
    { source: "v1", threadId: "t1", sessionId: "s1", requestId: "r1", reply: "once" },
    { source: "v1", threadId: "t1", sessionId: "s1", requestId: "r2", reply: "reject" },
  ])
  expect(asked).toEqual([])
})

test("policy decisions append an audit entry", async () => {
  const audits: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvalModeFor: () => "auto",
    respondPermission: async () => {},
    audit: (entry: any) => { audits.push(entry) },
  })
  await runner.onEvent("t1", { kind: "permission", sessionId: "s1", permissionId: "p1", source: "v1", tool: "bash", patterns: ["git push origin main"] })
  expect(audits).toEqual([{ kind: "permission", threadId: "t1", actorId: "policy", detail: "bash git push origin main", decision: "reject" }])
})

test("question events are routed to the approval manager", async () => {
  const asked: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject",
      askQuestion: async (input: any) => { asked.push(input); return null },
      cancel: () => {},
    },
  })
  const questions = [{ question: "Which DB?", header: "DB", options: [{ label: "sqlite", description: "" }] }]
  await runner.onEvent("t1", { kind: "question", sessionId: "s1", requestId: "q1", questions })
  expect(asked).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "q1", questions }])
})

test("permission.replied cancels a pending approval", async () => {
  const cancelled: any[] = []
  const { db } = makeDb()
  const runner = new Runner({ db,
    clientFor: () => ({ session: {} }) as any,
    createRenderer: async () => makeRenderer() as any,
    sessionFor: async () => "s1", log() {}, maxQueue: 2, maxConcurrentRuns: 4,
    approvals: {
      requestPermission: async () => "reject",
      askQuestion: async () => null,
      cancel: (sessionId: string, requestId: string) => { cancelled.push([sessionId, requestId]) },
    },
  })
  await runner.onEvent("t1", { kind: "permission-replied", sessionId: "s1", requestId: "r9" })
  expect(cancelled).toEqual([["s1", "r9"]])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — the new runner deps and event kinds are ignored (`asked`/`replies` stay empty, `cancel` is never called).

- [ ] **Step 3: Implement the Runner changes**

Add to `src/runner.ts` imports:

```ts
import type { ApprovalManager } from "./approvals.ts"
import type { AuditDraft } from "./audit.ts"
```

Add `PermissionReplyInput` above `RunnerDeps` and extend `RunnerDeps`:

```ts
export interface PermissionReplyInput {
  source: "v1" | "v2"
  threadId: string
  sessionId: string
  requestId: string
  reply: "once" | "always" | "reject"
}
export interface RunnerDeps {
  db: Db
  clientFor(threadId: string): OpencodeClient
  createRenderer(threadId: string, liveMessageId?: string | null, liveMessageIds?: string[] | null): Promise<Renderer>
  sessionFor(threadId: string): Promise<string>
  log(msg: string, fields?: Record<string, unknown>): void
  maxQueue: number
  maxConcurrentRuns: number
  onThreadIdle?(threadId: string): void
  approvalModeFor?(channelId: string): ApprovalMode
  respondPermission?(input: PermissionReplyInput): Promise<void>
  approvals?: Pick<ApprovalManager, "requestPermission" | "askQuestion" | "cancel">
  audit?(entry: AuditDraft): void
}
```

Add the private responder method to `Runner` (next to `clearAbortTimer`):

```ts
  private async respondToPermission(
    threadId: string,
    e: { sessionId: string; permissionId: string; source: "v1" | "v2"; tool: string; patterns: string[] },
    reply: "once" | "always" | "reject",
  ): Promise<void> {
    this.deps.audit?.({ kind: "permission", threadId, actorId: "policy", detail: `${e.tool} ${e.patterns.join(" ")}`.trim(), decision: reply })
    if (this.deps.respondPermission) {
      await this.deps.respondPermission({ source: e.source, threadId, sessionId: e.sessionId, requestId: e.permissionId, reply })
      return
    }
    const client = this.deps.clientFor(threadId)
    await client.postSessionIdPermissionsPermissionId({ path: { id: e.sessionId, permissionID: e.permissionId }, body: { response: reply } } as any)
  }
```

Replace the `else if (e.kind === "permission")` branch in `onEvent` with:

```ts
    else if (e.kind === "permission") {
      const thread = db.threads.get(threadId)
      const mode = this.deps.approvalModeFor?.(thread?.channelId ?? threadId) ?? "auto"
      const decision = decidePermission(mode, { tool: e.tool, patterns: e.patterns })
      if (decision === "ask") {
        if (this.deps.approvals) {
          await this.deps.approvals.requestPermission({
            threadId, sessionId: e.sessionId, requestId: e.permissionId, source: e.source,
            tool: e.tool, patterns: e.patterns, exact: e.patterns.length === 1,
          })
        } else {
          await this.respondToPermission(threadId, e, "reject")
        }
      } else {
        await this.respondToPermission(threadId, e, decision)
      }
    } else if (e.kind === "permission-replied") {
      this.deps.approvals?.cancel(e.sessionId, e.requestId)
    } else if (e.kind === "question") {
      try {
        await this.deps.approvals?.askQuestion({ threadId, sessionId: e.sessionId, requestId: e.requestId, questions: e.questions })
      } catch (err) {
        this.deps.log("question handling failed", { threadId, requestId: e.requestId, error: String(err) })
      }
    }
```

Do not add usage/cost/budget handling in this task; providers-and-cost owns it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS (all existing plus 6 new tests).

- [ ] **Step 5: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runner.ts test/runner.test.ts
git commit -m "feat: route permissions and questions through approval modes"
```

---

### Task 7: Approval and question interaction handlers

**Files:**
- Modify: `src/commands.ts`
- Modify: `test/commands.test.ts`

**Interfaces:**
- Consumes: `ApprovalManager` methods and custom-id builders (Task 4).
- Produces:
  - `interface ParsedCustomId { action: string; id?: string; extra?: string }`
  - `parseCustomIdFull(customId: string): ParsedCustomId`
  - `ANSWER_MODAL_INPUT = "answer"`
  - `handleButton`, `handleApprovalButton`, `handleAnswerButton`, `handleAnswerSelect`, `handleRejectQuestionButton`, `handleModalSubmit`, `customAnswerModal(requestId, questionIndex)`
  - `CommandDeps.approvals?: ApprovalManager`

- [ ] **Step 1: Write the failing tests**

In `test/commands.test.ts`, extend the `src/commands.ts` import with `ANSWER_MODAL_INPUT, handleApprovalButton, handleButton, handleModalSubmit, handleRejectQuestionButton, parseCustomIdFull`, then append:

```ts
test("parseCustomIdFull reads action, id, and extra", () => {
  expect(parseCustomIdFull("celly:resume:c1")).toEqual({ action: "resume", id: "c1", extra: undefined })
  expect(parseCustomIdFull("celly:approval:r1:once")).toEqual({ action: "approval", id: "r1", extra: "once" })
  expect(parseCustomIdFull("celly:answer:r1:2.3")).toEqual({ action: "answer", id: "r1", extra: "2.3" })
  expect(parseCustomIdFull("nope")).toEqual({ action: "" })
})

function fakeApprovals(over: any = {}) {
  const calls: any[] = []
  const manager = {
    calls,
    resolvePermission: (id: string, decision: string, actor: string) => { calls.push(["resolvePermission", id, decision, actor]); return over.permissionKnown ?? true },
    answerOption: (id: string, q: number, o: number, actor: string) => { calls.push(["answerOption", id, q, o, actor]); return over.optionKnown ?? true },
    answerQuestion: (id: string, q: number, answers: string[], actor: string) => { calls.push(["answerQuestion", id, q, answers, actor]); return over.questionKnown ?? true },
    rejectQuestion: (id: string, actor: string) => { calls.push(["rejectQuestion", id, actor]); return over.questionKnown ?? true },
    hasPending: () => over.pending ?? true,
    requestPermission: async () => "reject" as const,
    askQuestion: async () => null,
    cancel: () => {},
  }
  return { manager: manager as any, calls }
}

function button(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    customId: over.customId,
    channelId: over.channelId ?? "c",
    user: over.user ?? { id: "u1" },
    inGuild: () => true, member: {}, memberPermissions: {},
    calls,
    deferUpdate: async () => { calls.push({ kind: "deferUpdate" }) },
    showModal: async (m: any) => { calls.push({ kind: "showModal", m: m?.toJSON ? m.toJSON() : m }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
    editReply: async (c: any) => { calls.push({ kind: "edit", c }) },
  }
  return i
}

function modal(over: any = {}) {
  const calls: any[] = []
  const i: any = {
    customId: over.customId,
    user: over.user ?? { id: "u1" },
    inGuild: () => true, member: {}, memberPermissions: {},
    fields: { getTextInputValue: (_id: string) => over.value },
    calls,
    deferUpdate: async () => { calls.push({ kind: "deferUpdate" }) },
    reply: async (c: any) => { calls.push({ kind: "reply", c }) },
  }
  return i
}

test("approval buttons resolve the decision and acknowledge the interaction", async () => {
  const { manager, calls } = fakeApprovals()
  const i = button({ customId: "celly:approval:r1:once" })
  await handleApprovalButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["resolvePermission", "r1", "once", "u1"]])
  expect(i.calls).toEqual([{ kind: "deferUpdate" }])
})

test("stale approval buttons answer that the request is no longer active", async () => {
  const { manager } = fakeApprovals({ permissionKnown: false })
  const i = button({ customId: "celly:approval:r1:reject" })
  await handleApprovalButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "this request is no longer active", flags: 64 } })
})

test("option buttons map through the manager and custom buttons open a modal", async () => {
  const { manager, calls } = fakeApprovals()
  const option = button({ customId: "celly:answer:r1:0.2" })
  await handleButton(option, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["answerOption", "r1", 0, 2, "u1"]])
  expect(option.calls).toEqual([{ kind: "deferUpdate" }])

  const custom = button({ customId: "celly:answer:r1:1" })
  await handleButton(custom, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  const shown = custom.calls[0]
  expect(shown.kind).toBe("showModal")
  expect(shown.m.custom_id).toBe("celly:answer:r1:1")
  expect(shown.m.components[0].components[0].custom_id).toBe(ANSWER_MODAL_INPUT)
})

test("answer selects submit the selected values to the manager", async () => {
  const { manager, calls } = fakeApprovals()
  const i = select({ customId: "celly:answer:r1:1", values: ["b", "c"] })
  await handleSelect(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(i.calls[0]).toEqual({ kind: "deferUpdate" })
  expect(calls).toEqual([["answerQuestion", "r1", 1, ["b", "c"], "u1"]])
})

test("modal submits route the text input to the manager", async () => {
  const { manager, calls } = fakeApprovals()
  const i = modal({ customId: "celly:answer:r1:1", value: "  custom text  " })
  await handleModalSubmit(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["answerQuestion", "r1", 1, ["custom text"], "u1"]])
  expect(i.calls).toEqual([{ kind: "deferUpdate" }])
})

test("modal submits reject empty answers and stale requests", async () => {
  const { manager } = fakeApprovals({ questionKnown: false })
  const empty = modal({ customId: "celly:answer:r1:1", value: "   " })
  await handleModalSubmit(empty, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(empty.calls[0]).toMatchObject({ kind: "reply", c: { content: "answer cannot be empty", flags: 64 } })

  const staleButton = modal({ customId: "celly:answer:r1:1", value: "x" })
  await handleModalSubmit(staleButton, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(staleButton.calls[0]).toMatchObject({ kind: "reply", c: { content: "this request is no longer active", flags: 64 } })
})

test("question rejection resolves through the manager", async () => {
  const { manager, calls } = fakeApprovals()
  const i = button({ customId: "celly:reject-question:r1" })
  await handleRejectQuestionButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, approvals: manager })
  expect(calls).toEqual([["rejectQuestion", "r1", "u1"]])
  expect(i.calls).toEqual([{ kind: "deferUpdate" }])
})

test("unauthorized button interactions are rejected before any manager call", async () => {
  const { manager, calls } = fakeApprovals()
  const i = button({ customId: "celly:approval:r1:once" })
  await handleButton(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => false, approvals: manager })
  expect(calls).toEqual([])
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "You are not authorized.", flags: 64 } })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `parseCustomIdFull` and the handler exports are missing.

- [ ] **Step 3: Implement the handlers in `src/commands.ts`**

Update the imports:

```ts
import { ActionRowBuilder, ApplicationCommandOptionType, ComponentType, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js"
import { ANSWER_ACTION, APPROVAL_ACTION, REJECT_QUESTION_ACTION, answerCustomId } from "./approvals.js"
import type { ApprovalManager } from "./approvals.ts"
```

Add `approvals?: ApprovalManager` to `CommandDeps`.

After `parseCustomId`, add:

```ts
export interface ParsedCustomId { action: string; id?: string; extra?: string }
export function parseCustomIdFull(customId: string): ParsedCustomId {
  const parts = customId.split(":")
  if (parts[0] !== "celly" || parts.length < 2) return { action: "" }
  return { action: parts[1] ?? "", id: parts[2], extra: parts.length > 3 ? parts.slice(3).join(":") : undefined }
}
export const ANSWER_MODAL_INPUT = "answer"
```

In `handleSelect`, replace `const { action, id } = parseCustomId(interaction.customId ?? "")` with `parseCustomIdFull(interaction.customId ?? "")` and add this branch immediately after the `const value: string | undefined = interaction.values?.[0]` line:

```ts
    if (action === ANSWER_ACTION) return handleAnswerSelect(interaction, deps)
```

Append at the end of the file:

```ts
function stale(interaction: any): Promise<void> {
  return interaction.reply(noMentions("this request is no longer active", { flags: 64 }))
}

export function customAnswerModal(requestId: string, questionIndex: number): any {
  const input = new TextInputBuilder()
    .setCustomId(ANSWER_MODAL_INPUT)
    .setLabel("Your answer")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000)
  return new ModalBuilder()
    .setCustomId(answerCustomId(requestId, questionIndex))
    .setTitle("Custom answer")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
}

export async function handleButton(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action } = parseCustomIdFull(interaction.customId ?? "")
  if (action === APPROVAL_ACTION) return handleApprovalButton(interaction, deps)
  if (action === ANSWER_ACTION) return handleAnswerButton(interaction, deps)
  if (action === REJECT_QUESTION_ACTION) return handleRejectQuestionButton(interaction, deps)
}

export async function handleApprovalButton(interaction: any, deps: CommandDeps): Promise<void> {
  const { id, extra } = parseCustomIdFull(interaction.customId ?? "")
  const decision = extra === "once" || extra === "always" || extra === "reject" ? extra : undefined
  if (!id || !decision || !deps.approvals?.resolvePermission(id, decision, interaction.user?.id ?? "unknown")) {
    await stale(interaction)
    return
  }
  await interaction.deferUpdate()
}

export async function handleAnswerButton(interaction: any, deps: CommandDeps): Promise<void> {
  const { id, extra } = parseCustomIdFull(interaction.customId ?? "")
  if (!id || !extra || !deps.approvals?.hasPending(id)) { await stale(interaction); return }
  const [indexPart, optionPart] = extra.split(".")
  const questionIndex = Number(indexPart)
  if (!Number.isInteger(questionIndex) || questionIndex < 0) { await stale(interaction); return }
  if (optionPart !== undefined) {
    const optionIndex = Number(optionPart)
    if (!Number.isInteger(optionIndex) || optionIndex < 0
      || !deps.approvals.answerOption(id, questionIndex, optionIndex, interaction.user?.id ?? "unknown")) {
      await stale(interaction)
      return
    }
    await interaction.deferUpdate()
    return
  }
  await interaction.showModal(customAnswerModal(id, questionIndex))
}

export async function handleAnswerSelect(interaction: any, deps: CommandDeps): Promise<void> {
  const { id, extra } = parseCustomIdFull(interaction.customId ?? "")
  const questionIndex = Number(extra)
  const values: string[] = Array.isArray(interaction.values)
    ? interaction.values.slice(0, 25).filter((value: unknown): value is string => typeof value === "string" && !!value)
    : []
  const known = deps.approvals?.answerQuestion(id ?? "", questionIndex, values, interaction.user?.id ?? "unknown")
  if (!id || !Number.isInteger(questionIndex) || !values.length || !known) {
    return void await interaction.editReply({ content: "this request is no longer active", components: [], allowedMentions: { parse: [] } })
  }
}

export async function handleRejectQuestionButton(interaction: any, deps: CommandDeps): Promise<void> {
  const { id } = parseCustomIdFull(interaction.customId ?? "")
  if (!id || !deps.approvals?.rejectQuestion(id, interaction.user?.id ?? "unknown")) { await stale(interaction); return }
  await interaction.deferUpdate()
}

export async function handleModalSubmit(interaction: any, deps: CommandDeps): Promise<void> {
  if (!deps.authorized(interaction)) { await interaction.reply(noMentions("You are not authorized.", { flags: 64 })); return }
  const { action, id, extra } = parseCustomIdFull(interaction.customId ?? "")
  if (action !== ANSWER_ACTION) return
  const questionIndex = Number(extra)
  const value = String(interaction.fields?.getTextInputValue?.(ANSWER_MODAL_INPUT) ?? "").trim()
  if (!value) { await interaction.reply(noMentions("answer cannot be empty", { flags: 64 })); return }
  if (!id || !Number.isInteger(questionIndex)
    || !deps.approvals?.answerQuestion(id, questionIndex, [value], interaction.user?.id ?? "unknown")) {
    await stale(interaction)
    return
  }
  await interaction.deferUpdate()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "feat: handle approval, question, and modal interactions"
```

---

### Task 8: `/mode` command and index wiring

**Files:**
- Modify: `src/commands.ts`
- Modify: `src/index.ts`
- Modify: `src/opencode.ts` (question policy only)
- Modify: `test/commands.test.ts`
- Modify: `test/opencode.test.ts`

**Interfaces:**
- Consumes: `ApprovalManager` (Task 4), `approvalModeFor`/`isApprovalMode`/`APPROVAL_MODES` (Task 5), `resolveV2Client` (Task 3), runner/manager deps (Tasks 6/7).
- Produces:
  - `commandData()` includes `mode` with choices `auto|buttons|plan`.
  - `requiresOwner("mode", ...) === true`.
  - `handleCommand` writes `approval_mode:<projectChannelId>` and audits via `deps.audit?.(...)`.
  - `CommandDeps.audit?(entry: AuditDraft): void`.
  - `index.ts` constructs `ApprovalManager`, v2 clients, and dispatches `isButton`/`isModalSubmit` to `handleButton`/`handleModalSubmit`.
  - `cellyPolicy().permission.question === "allow"`.

- [ ] **Step 1: Write the failing tests**

Append to `test/commands.test.ts`:

```ts
test("mode is owner-only and declares the three approval modes", () => {
  const mode = commandData().find((c) => c.name === "mode")!
  expect(mode.options[0].choices.map((c: any) => c.value)).toEqual(["auto", "buttons", "plan"])
  expect(requiresOwner("mode", null)).toBe(true)
})

test("mode writes the channel setting and audits the change", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  const i = interaction({ commandName: "mode", channelId: "c", strings: { mode: "plan" } })
  const audits: any[] = []
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true, audit: (e: any) => audits.push(e) })
  expect(db.settings.get("approval_mode:c")).toBe("plan")
  expect(editOf(i)).toBe("approval mode set to plan")
  expect(audits).toEqual([{ kind: "mode", channelId: "c", threadId: "c", actorId: "u1", detail: "approval_mode:c", decision: "plan" }])
})

test("mode inside a thread writes the owning project setting", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj); db.projects.setReady("c", "C:\\p")
  db.threads.upsert(threadRow("t1"))
  const i = interaction({ commandName: "mode", channelId: "t1", strings: { mode: "auto" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db, authorized: () => true, isOwner: () => true })
  expect(db.settings.get("approval_mode:c")).toBe("auto")
})

test("non-owner mode is rejected before defer", async () => {
  const i = interaction({ commandName: "mode", channelId: "c", strings: { mode: "auto" } })
  await handleCommand(i, { projects: {} as any, runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => false })
  expect(i.calls).toHaveLength(1)
  expect(i.calls[0]).toMatchObject({ kind: "reply", c: { content: "This command is owner-only.", flags: 64 } })
})
```

Update the existing `"declares the v1 command set"` expectation:

```ts
  expect(names).toEqual(["abort", "agent", "mode", "model", "new", "project", "resume"])
```

In `test/opencode.test.ts`, change the policy expectation:

```ts
    external_directory: "deny", question: "allow",
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts test/opencode.test.ts`
Expected: FAIL — `/mode` is not declared and `cellyPolicy().permission.question` is still `"deny"`.

- [ ] **Step 3: Implement `/mode` in `src/commands.ts`**

Add to the imports:

```ts
import { APPROVAL_MODES, isApprovalMode } from "./mode.js"
import type { AuditDraft } from "./audit.ts"
```

Add `audit?(entry: AuditDraft): void` to `CommandDeps`.

In `commandData()`, add to the returned array after `/agent`:

```ts
    { name: "mode", description: "Set the approval mode for this session's project channel", options: [
      { type: ApplicationCommandOptionType.String, name: "mode", description: "How permission requests are handled", required: true,
        choices: APPROVAL_MODES.map((mode) => ({ name: mode, value: mode })) } ] },
```

In `requiresOwner`, add the mode rule:

```ts
export function requiresOwner(commandName: string, sub: string | null | undefined): boolean {
  if (commandName === "mode") return true
  return commandName === "project" && !!sub && OWNER_ONLY_PROJECT_SUBS.has(sub)
}
```

In `handleCommand`, add before the final `await interaction.editReply(noMentions("not implemented in this build"))`:

```ts
    if (interaction.commandName === "mode") {
      const requested = interaction.options.getString("mode", true)
      if (!isApprovalMode(requested)) return void await interaction.editReply(noMentions(`unknown mode: ${requested}`))
      const thread = deps.db.threads.get(interaction.channelId)
      const channelId = thread?.channelId ?? interaction.channelId
      if (!deps.db.projects.getByChannel(channelId)) return void await interaction.editReply(noMentions("this channel is not a project"))
      deps.db.settings.set(`approval_mode:${channelId}`, requested)
      deps.audit?.({
        kind: "mode", channelId, threadId: interaction.channelId,
        actorId: interaction.user?.id ?? "unknown", detail: `approval_mode:${channelId}`, decision: requested,
      })
      return void await interaction.editReply(noMentions(`approval mode set to ${requested}`))
    }
```

- [ ] **Step 4: Change the question policy in `src/opencode.ts`**

In `CellyPolicy.permission` change `question: "deny"` to `question: "allow"`, and in `cellyPolicy()` change `question: "deny"` to `question: "allow"`. The runner and manager reject questions in `auto` and `plan` modes, so `allow` only enables the `buttons` mode flow (spec §4.5 security posture).

- [ ] **Step 5: Wire `src/index.ts`**

Update imports:

```ts
import { commandData, handleButton, handleCommand, handleModalSubmit, handleSelect } from "./commands.js"
import { APPROVAL_TIMEOUT_MS, ApprovalManager } from "./approvals.js"
import { approvalModeFor } from "./mode.js"
import { resolveBaseUrl, resolveClient, resolveV2Client } from "./opencode.js"
```

After `clientFor`, add:

```ts
  const projectForThread = (threadId: string): Project => {
    const thread = db.threads.get(threadId)
    const project = thread ? db.projects.getByChannel(thread.channelId) : undefined
    if (!project) throw new Error(`unknown project for thread ${threadId}`)
    return project
  }
  const v2ClientFor = (threadId: string) => resolveV2Client(projectForThread(threadId))
```

After `runnerSvc` is constructed, add:

```ts
  const threadChannel = async (threadId: string): Promise<any> => {
    const channel = await client.channels.fetch(threadId)
    if (!channel) throw new Error(`thread channel ${threadId} unavailable`)
    return channel
  }
  const threadBucket = (threadId: string): string => {
    const thread = db.threads.get(threadId)
    return thread ? channelIdForBucket(thread) : threadId
  }
  const approvals = new ApprovalManager({
    send: async (threadId, content, components) => {
      const channel = await threadChannel(threadId)
      const sent = await scheduleWithBucket(threadBucket(threadId), () => (channel as any).send({ ...renderPayload(content), components }))
      return sent.id as string
    },
    edit: async (threadId, messageId, content, components) => {
      const channel = await threadChannel(threadId)
      const message = await (channel as any).messages.fetch(messageId)
      await scheduleWithBucket(threadBucket(threadId), () => message.edit({ ...renderPayload(content), components }))
    },
    replyPermission: async ({ threadId, sessionId, requestId, reply, source }) => {
      if (source === "v2") {
        await v2ClientFor(threadId).session.permission.reply({ sessionID: sessionId, requestID: requestId, reply })
        return
      }
      const sdk = resolveClient(projectForThread(threadId))
      await sdk.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: requestId }, body: { response: reply } } as any)
    },
    replyQuestion: async ({ threadId, sessionId, requestId, answers }) => {
      await v2ClientFor(threadId).session.question.reply({ sessionID: sessionId, requestID: requestId, questionV2Reply: { answers } })
    },
    rejectQuestion: async ({ threadId, sessionId, requestId }) => {
      await v2ClientFor(threadId).session.question.reject({ sessionID: sessionId, requestID: requestId })
    },
    modeFor: (threadId) => approvalModeFor(db.settings, db.threads.get(threadId)?.channelId ?? threadId),
    now: () => Date.now(),
    timeoutMs: APPROVAL_TIMEOUT_MS,
    log: (message, fields) => log.warn(message, fields),
  })
```

The SDK 1.18.32 session question reply body parameter is `questionV2Reply` (not a flat `answers` key); the call above matches the generated client.

Add to the `Runner` constructor deps in `index.ts`:

```ts
    approvalModeFor: (channelId) => approvalModeFor(db.settings, channelId),
    respondPermission: async ({ source, threadId, sessionId, requestId, reply }) => {
      if (source === "v2") {
        await v2ClientFor(threadId).session.permission.reply({ sessionID: sessionId, requestID: requestId, reply })
        return
      }
      const sdk = resolveClient(projectForThread(threadId))
      await sdk.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: requestId }, body: { response: reply } } as any)
    },
    approvals,
```

Add `approvals,` to the `commandDeps` object.

Replace `onInteraction`:

```ts
  const onInteraction = async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isButton()) { await handleButton(interaction, commandDeps); return }
      if (interaction.isModalSubmit()) { await handleModalSubmit(interaction, commandDeps); return }
      if (interaction.isStringSelectMenu()) { await handleSelect(interaction, commandDeps); return }
      if (!interaction.isChatInputCommand()) return
      await handleCommand(interaction, commandDeps)
    } catch (err) {
      log.error("interaction handler failed", { error: err instanceof Error ? err.stack ?? err.message : String(err) })
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/opencode.test.ts`
Expected: PASS.

- [ ] **Step 7: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/commands.ts src/index.ts src/opencode.ts test/commands.test.ts test/opencode.test.ts
git commit -m "feat: add /mode and wire approval interactions"
```

---

### Task 9: Audit wiring for decisions, questions, shell, and mode

**Files:**
- Modify: `src/handlers.ts`
- Modify: `src/index.ts`
- Modify: `test/handlers.test.ts`

**Interfaces:**
- Consumes: `createAuditLog`/`AuditDraft` (Task 1); `RunnerDeps.audit`, `ApprovalManagerDeps.audit`, `CommandDeps.audit` (Tasks 4/6/8).
- Produces:
  - `MessageHandlerDeps.audit?(entry: AuditDraft): void`; `!shell` appends `{ kind: "shell", detail: command, decision: "run" }`.
  - `index.ts` creates `data/audit.jsonl` and passes an adapter that fills `channelId` from the thread's project channel to the runner, manager, commands, and message handler.

Permission and question audit entries are already asserted in Tasks 4 and 6, and `/mode` audit in Task 8; this task adds the missing `!shell` producer and the shared adapter wiring.

- [ ] **Step 1: Write the failing test**

Append to `test/handlers.test.ts`:

```ts
test("!shell appends an audit entry with the verbatim command", async () => {
  const db = fresh(); db.projects.insertProvisioning(project()); db.projects.setReady("c", "C:\\p")
  const audits: any[] = []
  const deps = baseDeps(db, { runShell: vi.fn(async () => ["ok"]), audit: (e: any) => audits.push(e) })
  const { message } = fakeMessage({ content: "!echo hi" })
  await createMessageHandler(deps)(message)
  expect(audits).toEqual([{ kind: "shell", channelId: "c", threadId: "c", actorId: "u1", detail: "echo hi", decision: "run" }])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/handlers.test.ts`
Expected: FAIL — `audits` stays empty because the handler never calls `deps.audit`.

- [ ] **Step 3: Implement the shell audit entry**

In `src/handlers.ts`, add the import:

```ts
import type { AuditDraft } from "./audit.ts"
```

Add to `MessageHandlerDeps`:

```ts
  audit?(entry: AuditDraft): void
```

In the `if (text.startsWith("!"))` branch, after `if (!command) return`, add:

```ts
        deps.audit?.({ kind: "shell", channelId: project.channelId, threadId: message.channelId, actorId: message.author.id, detail: command, decision: "run" })
```

- [ ] **Step 4: Wire the audit log in `src/index.ts`**

Add the import:

```ts
import { createAuditLog, type AuditDraft } from "./audit.js"
```

After `seedSettings(db, cfg)` add:

```ts
  const auditLog = createAuditLog({ file: `${cfg.dataDir}/audit.jsonl` })
  const audit = (entry: AuditDraft): void => auditLog.append({
    ...entry,
    channelId: entry.channelId ?? db.threads.get(entry.threadId)?.channelId ?? entry.threadId,
  })
```

Pass `audit` to every producer:

1. In the `ApprovalManager` deps, add `audit,`.
2. In the `Runner` deps, add `audit,`.
3. In the `commandDeps` object, add `audit,`.
4. In the `createMessageHandler` deps object, add `audit,`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/handlers.test.ts`
Expected: PASS.

- [ ] **Step 6: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/handlers.ts src/index.ts test/handlers.test.ts
git commit -m "feat: wire the audit log into decisions and shell"
```

---

### Task 10: Docs and changeset

**Files:**
- Modify: `docs-site/reference/commands.mdx`
- Modify: `docs-site/reference/security.mdx`
- Modify: `docs-site/guides/configuration.mdx`
- Modify: `README.md`
- Modify: `.env.example`
- Create: `.changeset/approvals-and-questions.md`

**Interfaces:**
- Consumes: all behavior from Tasks 1–9.
- Produces: documentation of `/mode`, approval modes, the question flow, the audit log, and the updated `question: allow` posture; one minor changeset.

- [ ] **Step 1: Update `docs-site/reference/commands.mdx`**

In the Sessions table, after the `/agent` row, add:

```mdx
| `/mode mode:<auto\|buttons\|plan>` | owner | Set the approval mode for this project channel (stored as `approval_mode:<channelId>`). |
```

Add a new section after the Sessions table (before "Messages and shell"):

```mdx
## Approvals and questions

Approval mode is per project channel. `/mode` writes the override; the
`APPROVAL_MODE` environment value seeds the global default on first boot.

- `auto` — the bot answers every permission request from the enforced policy
  immediately, exactly like previous releases.
- `plan` — a dry run. Read-only tools (`read`, `glob`, `grep`, `list`, `find`)
  run; `bash`, `edit`, `write`, `patch`, `external_directory`, `webfetch`,
  unknown tools, and sensitive-path reads are rejected.
- `buttons` — read-only tools run; every other non-denied request posts an
  **Approve once / Always allow / Reject** message in the thread. Requests time
  out after 5 minutes and are rejected. Deny-listed commands, sensitive paths,
  and unknown tools are rejected without asking.

In `buttons` mode an agent question renders as buttons (one to five options), a
string select (six to twenty-five options), a **Custom answer** button that
opens a modal, and a **Reject** button. Multi-question requests collect answers
in order. Questions time out after 5 minutes and are rejected. `auto` and
`plan` modes reject questions rather than interrupting the run.

Clicking a button from a previous bot process answers "this request is no
longer active"; pending requests are not persisted across restarts.
```

In the "Deferred to v1.1" Features list, remove `permission-approval buttons,
question rendered as Discord components` from the threaded sentence so it reads:

```mdx
Features: worktree-per-thread, `/btw` forks, queue UI (`. queue`), voice
messages, image attachments, OpenCode web UI, tunnels/screenshare, multi-guild,
cloud sandboxes, `--clone` sandbox mode, OAuth subscription login, and
Linux/macOS deployment docs.
```

- [ ] **Step 2: Update `docs-site/reference/security.mdx`**

Replace the `question: deny` bullet:

```mdx
- `question: "allow"` lets the agent ask questions; Celly decides per approval
  mode. `auto` and `plan` reject them immediately, and `buttons` surfaces them
  to authorized members. There is no headless deadlock either way.
```

Add a section after "Bot-enforced permission policy":

```mdx
## Approval decisions

`buttons` mode turns mutating permission requests into Discord messages.
Decisions are bound to the pending request id and are only accepted while the
request is live; stale or post-restart clicks answer "this request is no longer
active". Read-only tools and every pattern already denied by the policy (bash
deny list, sensitive paths, unknown tools) are decided without asking.

Every permission decision, question answer or rejection, `!shell` command, and
`/mode` change is appended to `DATA_DIR/audit.jsonl` (mode 0600, one JSON object
per line) with timestamp, channel, thread, actor, kind, detail, and decision.
Audit appends are best-effort: a failure logs and never fails the interaction.
The log stores tool names, patterns, and shell commands verbatim and never
tokens or passwords.
```

- [ ] **Step 3: Update `docs-site/guides/configuration.mdx` and `.env.example`**

In the configuration Variables table, after the `DEFAULT_AGENT` row, add:

```mdx
| `APPROVAL_MODE` | `buttons` | `auto`, `buttons`, or `plan`. Seeded into `settings.approval_mode` on first boot; `/mode` writes a per-channel `approval_mode:<channelId>` override. |
```

Extend the note under the table:

```mdx
<Note>
`DEFAULT_MODEL`, `DEFAULT_AGENT`, and `APPROVAL_MODE` are seeded into the
`settings` table on the first boot only. Once a value exists there, it is
authoritative and re-reading `.env` will not overwrite it.
</Note>
```

In `.env.example`, add after the models block:

```
# # Approvals: auto | buttons | plan (seeded once into settings).
# APPROVAL_MODE=buttons
```

- [ ] **Step 4: Update `README.md`**

In the Features list, after the Abort bullet, add:

```md
- **Approvals.** `/mode` picks `auto`, `buttons`, or `plan`; `buttons` posts
  permission requests as Discord buttons and agent questions as
  buttons/selects/modals. Decisions are written to a best-effort audit log.
```

In the Commands table, after the `/agent` row, add:

```md
| `/mode <auto\|buttons\|plan>` | project channel or thread (owner) | Set the channel approval mode. |
```

In the roadmap Features, change the thread/conversation bullet to:

```md
- **Thread/conversation:** worktree-per-thread, `/btw` forks, queue UI.
```

- [ ] **Step 5: Create `.changeset/approvals-and-questions.md`**

```md
---
"celly": minor
---

Add approval modes (`auto`/`buttons`/`plan`), Discord permission approval
buttons, interactive agent questions with custom answer modals, and a
best-effort 0600 audit log at `DATA_DIR/audit.jsonl`.
```

- [ ] **Step 6: Validate the docs**

Run: `npm run docs:validate`
Expected: PASS — no Mintlify schema errors.

Run: `npm run docs:links`
Expected: PASS — no broken links.

- [ ] **Step 7: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add docs-site/reference/commands.mdx docs-site/reference/security.mdx docs-site/guides/configuration.mdx README.md .env.example .changeset/approvals-and-questions.md
git commit -m "docs: document approvals, questions, and /mode"
```

---

## Self-Review

**1. Spec coverage**

- §3.1 custom IDs / `parseCustomIdFull`: Tasks 4 (builders keep `celly:<action>:<id>[:<extra>]`) and 7 (`parseCustomIdFull`).
- §3.2 normalized events: Task 2 (`permission.source`, `question`, `permission-replied`); `tool.title`/`usage` are explicitly owned by conversation-ux/providers-and-cost (Global Constraints).
- §3.4 ApprovalManager: Task 4 (deps `send`, `edit`, `now`, `timeoutMs`, `modeFor`, `audit`, `log` plus injected reply callbacks; `requestPermission`, `askQuestion`, `resolvePermission`, `resolveQuestion`, `cancel`, timeout edits and never hangs a run).
- §3.5 audit log: Task 1 (0600, append/tail, JSONL schema) and Task 9 (wiring).
- §3.6 SDK facts: Task 3 (v2 client), Task 8 (`session.permission.reply`, `session.question.reply/reject`; note the verified SDK body key `questionV2Reply`).
- §4.5 config/mode/commands: Tasks 5 (`APPROVAL_MODE`, `approval_mode:<channelId>`), 8 (`/mode`, owner-only).
- §4.5 plan/buttons behavior: Tasks 5 (`decidePermission`) and 6 (runner branches).
- §4.5 question flow: Tasks 4 (rendering, ordering, timeout), 7 (button/select/modal/reject handlers), 8 (`isButton`/`isModalSubmit` wiring).
- §4.5 audit producers: Tasks 4 (questions/permissions), 6 (policy decisions), 8 (`/mode`), 9 (`!shell` + index adapter).
- §4.5 stale buttons and docs/security posture: Tasks 4/7 (stale replies, no persistence) and 10.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "add error handling", or "similar to Task N" remains. Every code step contains the full code; every test step contains the full test; every run step names the command and expected result.

**3. Type/identifier consistency**

`ApprovalMode`, `ApprovalDecision`, `ApprovalSource`, `PermissionAsk`, `QuestionAsk`, `PermissionReplyInput`, `decidePermission`, `approvalModeFor`, `respondPermission`, `celly:approval:<requestId>:<decision>`, `celly:answer:<requestId>:<questionIndex>[.<optionIndex>]`, `celly:reject-question:<requestId>`, `approval_mode:<channelId>`, and the `permission-replied` kind are used with the same names and shapes in every task. `ApprovalManager` method names match between Tasks 4, 6, 7, and 8. The manager's `modeFor` receives a thread id; `index.ts` resolves it to the owning project channel (`db.threads.get(threadId)?.channelId ?? threadId`) so per-channel overrides still apply.

