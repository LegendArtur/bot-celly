# Celly vNext (A–F) Design Spec

**Date:** 2026-09-27
**Status:** Approved design (from the 2026-09-27 planning session)
**Plans:** `docs/superpowers/plans/2026-09-27-{terminal-attach,idle-auto-stop,admin-and-ops,multi-guild,approvals-and-questions,worktrees-and-forks,conversation-ux,providers-and-cost}.md`

This spec fixes the requirements and interfaces for eight independent plans. Each
plan must produce working, testable software on its own. Executors read this spec
plus their own plan task.

## 1. Execution Model

- Each plan runs in its own git worktree from `main`, using
  `superpowers:subagent-driven-development` (fresh subagent per task, review
  between tasks).
- Merge order (recommended): terminal-attach → idle-auto-stop → admin-and-ops →
  multi-guild → approvals-and-questions → worktrees-and-forks → conversation-ux →
  providers-and-cost. Merge each worktree before starting the next when they
  touch the same hotspot files.
- Safe parallel pairs (disjoint new modules, merge conflicts limited to wiring):
  `terminal-attach` + `idle-auto-stop`; `admin-and-ops` + `multi-guild`;
  `approvals-and-questions` + `worktrees-and-forks`; `conversation-ux` +
  `providers-and-cost`.
- **Conflict hotspots** (every plan touches one or more): `src/index.ts`,
  `src/commands.ts`, `src/config.ts`, `src/db.ts`, `src/runner.ts`,
  `docs-site/docs.json`, `docs-site/reference/commands.mdx`,
  `docs-site/guides/configuration.mdx`, `README.md`.
- **Migrations are append-only and explicitly numbered.** Never insert into or
  reorder `MIGRATIONS` in `src/db.ts`; append new entries at the end. The runner
  skips any entry with `version <= user_version` (`src/db.ts:88-89`), so two
  plans reusing a version would silently drop one migration. Reserved versions
  by merge order: **idle-auto-stop = 5, admin-and-ops = 6,
  providers-and-cost = 7**. Do not renumber; if these plans merge in a
  different order, coordinate and use the next free numbers. Tests assert
  behavior, not `user_version` values.
- Each plan adds one changeset (`npx changeset` equivalent: a new
  `.changeset/<name>.md` with a minor bump and a short summary) and commits it
  with the final task.

## 2. Global Constraints (every plan)

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (guarded by
  `test/imports.test.ts`). Only `src/opencode.ts` and `src/projects.ts` may
  build `http://127.0.0.1:${...}` URLs.
- argv-only spawning: `shell: false`, `windowsHide: true`; never interpolate
  user input into a shell string sent to the host.
- Secrets (Discord token, server passwords, provider keys) never in argv, logs,
  audit entries, or Discord messages. Redact through `src/log.ts`.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat
  `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and
  `../src/x.ts` imports. Temp dirs via
  `mkdtempSync(join(tmpdir(), "celly-...-")); try { } finally { rmSync(...) }`.
- Command changes update `docs-site/reference/commands.mdx` and the README
  commands table; config changes update `docs-site/guides/configuration.mdx` and
  `.env.example`; security-relevant changes update
  `docs-site/reference/security.mdx`. New docs pages register in
  `docs-site/docs.json`.
- Run `npm test`, `npm run typecheck`, `npm run build` before each commit.

## 3. Shared Conventions

### 3.1 Custom IDs

Wire format stays `celly:<action>:<id>[:<extra>]`. Add to `src/commands.ts`:

```ts
export interface ParsedCustomId { action: string; id?: string; extra?: string }
export function parseCustomIdFull(customId: string): ParsedCustomId
```

Keep `selectCustomId(action, id)` and `parseCustomId` unchanged for selects.
New actions (reserved): `approval`, `answer`, `reject-question`, `queue-remove`,
`queue-clear`, `mode`, `worktree`, `login-method`. `extra` holds the decision or
index (`once|always|reject`, queue index, mode name).

**Ownership (merge-order rule):** approvals-and-questions merges first and owns
the canonical `parseCustomIdFull` — it validates the `celly` prefix (returning
`{ action: "" }` for malformed ids) and keeps `extra` as
`parts.slice(3).join(":")`; `parseCustomId` delegates to it. It also owns the
single `handleButton(interaction, deps)` dispatcher and the `isButton` /
`isModalSubmit` branches in `src/index.ts`. Later plans (conversation-ux,
worktrees-and-forks) must extend that dispatcher with their own dedicated
`handle*` function instead of redefining it; only when a later plan executes
against a tree where the helpers are absent does it add them with the canonical
behavior above.

### 3.2 Normalized events (`src/events.ts`)

Extend `NormalizedEvent` with (keep existing kinds byte-compatible):

```ts
| { kind: "tool"; sessionId: string; messageId: string; partId: string; name: string; status: string; title?: string }
| { kind: "usage"; sessionId: string; messageId: string; cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }
| { kind: "question"; sessionId: string; requestId: string; questions: QuestionInfo[] }
```

- `tool.title` comes from `ToolStateRunning.title` / `ToolStateCompleted.title`.
- `usage` is emitted **only** from `step-finish` parts (`part.type ===
  "step-finish"`, `cost`, `tokens.{input,output,cache.read,cache.write}`).
  `message.updated` is ignored so cumulative assistant totals never double-count
  against the per-step deltas.
- Existing `permission` event gains `source: "v1" | "v2"`: `permission.updated`
  → `v1`; `permission.asked` (v2) → `v2` with `requestId` in `permissionId`.
- `question.asked` (v2) maps to `question`. `QuestionInfo` is imported from
  `@opencode-ai/sdk/v2` (`{ question, header, options: { label, description? }[], multiple?, custom? }`).

### 3.3 Renderer

Add to `Renderer` (used by conversation-ux and providers-and-cost):

```ts
setFooter(text: string): void   // appended as a final "-# <text>" line to body()
```

The renderer records `startedAt` on the first `push` and `endedAt` on
`finalize`; plans that need duration read `renderer.elapsedMs()`.

### 3.4 Approvals module (approvals-and-questions)

New `src/approvals.ts` exports
`class ApprovalManager` with constructor deps
`{ send, edit, now, timeoutMs, modeFor(channelId), audit, log }` and methods:

```ts
requestPermission(input: { threadId: string; sessionId: string; requestId: string; source: "v1" | "v2"; tool: string; patterns: string[]; exact: boolean }): Promise<"once" | "always" | "reject">
askQuestion(input: { threadId: string; sessionId: string; requestId: string; questions: QuestionInfo[] }): Promise<string[][] | null>  // null = rejected
resolvePermission(requestId: string, decision: "once" | "always" | "reject", actorId: string): boolean
resolveQuestion(requestId: string, answers: string[][], actorId: string): boolean
cancel(sessionId: string, requestId: string): void   // e.g. on permission.replied
```

Timeout resolves `reject`/`null`, edits the message to say it timed out, and
never leaves a run waiting forever. Decision replies go through injected
`replyPermission` / `replyQuestion` callbacks so the manager stays free of SDK
types.

### 3.5 Audit log

New `src/audit.ts`: `createAuditLog({ file, clock? })` → `{ append(entry), tail(limit) }`.
File `data/audit.jsonl`, created with mode 0600, one JSON object per line:
`{ ts, guildId?, channelId, threadId, actorId, kind: "permission"|"question"|"shell"|"mode"|"task", detail, decision }`.
`detail` must never contain secret values; shell commands are included verbatim.

### 3.6 Verified SDK facts (do not re-guess)

- `opencode attach <url>` flags: `-c/--continue`, `-s/--session <id>`,
  `-p/--password` (defaults to `OPENCODE_SERVER_PASSWORD`), `--dir`, `--fork`.
- Session endpoints accept `query: { directory?: string }` (create, prompt,
  promptAsync, abort, messages, diff, summarize, fork, revert, unrevert, share).
- v1 SDK has `session.revert`, `session.unrevert`, `session.share`,
  `session.unshare`, `session.diff`, `session.summarize`, `session.fork`.
- OAuth (v1): `provider.auth()` → `{ [providerId]: { type: "oauth"|"api"; label }[] }`;
  `provider.oauth.authorize({ path: { id }, body: { method: <index> } })` →
  `{ url, method: "auto"|"code", instructions }`;
  `provider.oauth.callback({ path: { id }, body: { method, code? } })` →
  `boolean` — the **server persists the credentials**, so OAuth flows must not
  call `auth.set` afterwards. `auth.set({ path: { id }, body: Auth })` exists
  for API-key/well-known credentials only (`Auth = OAuth | ApiAuth | WellKnownAuth`).
- v2 client: `import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"`.
  Session-scoped replies take the OpenAPI parameters object:
  `client.session.permission.reply({ sessionID, requestID, reply })` and
  `client.session.question.reply({ sessionID, requestID, questionV2Reply: { answers } })`,
  `client.session.question.reject({ sessionID, requestID })`. The top-level
  `client.question.reply({ requestID, answers })` uses a flat `answers` field;
  Celly uses the session-scoped form.
- `ToolStateCompleted` = `{ status, input, output, title, metadata, time }`.
- `Model.limit.context` is available from `config.providers()`.

## 4. Plan Requirements

### 4.1 F — Terminal attach (`terminal-attach`)

**Commands:** `/attach` (ephemeral; current thread's session) and
`/session-id` (ephemeral; bare session id). Both require a known thread.
`/attach` replies with a code block:

```text
sbx exec -it <sandboxName> bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s <sessionId>'
```

`/session-id` replies with `` `<sessionId>` `` plus the same command behind a
spoiler. Non-ephemeral fallback: if the interaction cannot be deferred, reply
ephemeral anyway; failures report `error: <message>`.

**Terminal-started sessions:** new config `ATTACH_AUTO_THREAD` (boolean,
default `false`). When true, events for an unknown session whose project
channel is known auto-create a Discord thread titled after the session title
(fetched with `session.get`), then route events normally. Unknown sessions
with no project are dropped as today.

**Web UI:** deliberately not exposed. `sbx` publishes one host mapping per
sandbox port; re-publishing `4096` publicly would break the loopback-only
invariant. Document terminal attach as the supported path in
`docs-site/guides/terminal-attach.mdx` and record the decision in the spec's
open-items section.

**Acceptance:** `/attach` output is exact for the current sandbox/session;
`ATTACH_AUTO_THREAD=false` keeps current drop behavior; docs updated; tests
cover command output, missing-thread errors, and the auto-thread gate.

### 4.2 E1 — Idle auto-stop (`idle-auto-stop`)

- Config `IDLE_STOP_MINUTES` (int ≥ 0, default `30`, `0` disables).
- Migration input: add `last_active_at INTEGER NOT NULL DEFAULT 0` to
  `projects`; `db.projects.touch(channelId, at)`, `db.projects.idleSince(now)`
  selection helper.
- Touch project activity on: message ingest, shell run, thread prompt start,
  and `onProjectReady`.
- New `src/idle.ts`: `createIdleSweeper({ listProjects, activeThreads, now, stop, notify, idleMs, intervalMs })`
  with `start()`/`stop()`/`tick()`. Skips `provisioning` and projects with
  active runs; calls `stop(channelId)` then `notify(channelId, minutes)`.
- Wire in `src/index.ts`: sweeper interval unref'd; `notify` posts a plain
  channel message via `renderPayload`; `stop` calls `runner.resetChannel` if
  needed, `stopSubscription`, `projects.stop`.
- **Acceptance:** fake-clock tests cover idle stop, active-run skip,
  provisioning skip, `0` disabled, and touch-on-activity; docs + `.env.example`
  updated; boot log line states the configured threshold.

### 4.3 E2 — Admin and ops (`admin-and-ops`)

- **Admin page** `src/admin.ts`: `createAdminServer(deps): Promise<{ close(): void }>`,
  binds `127.0.0.1` only. Config `ADMIN_PORT` (int ≥ 0, default `4560`,
  `0` disables). Routes: `GET /` (HTML status page), `GET /api/projects`,
  `GET /api/health`, `POST /api/projects/:channelId/start|stop`,
  `GET /api/logs/:channelId?lines=200` (tail, redacted), `GET /api/audit?limit=100`
  (when `src/audit.ts` exists). No auth (loopback); JSON errors `{ error }`.
- **Log rotation** `src/rotate.ts`:
  `rotateIfNeeded(file, { maxBytes, maxFiles, now? }): boolean` shifting
  `file` → `file.1` → … ; `createLogger` gains `maxBytes`/`maxFiles` and calls
  it on each append (throttled to once per flush); project server logs use it
  too. Config `LOG_MAX_BYTES` (default `5000000`), `LOG_MAX_FILES` (default `3`).
- **DB backup** `src/backup.ts`:
  `createBackupScheduler({ db, dir, intervalMs, keep, now })` writing
  `data/backups/bot-<ISO>.db` via `VACUUM INTO` (escape single quotes; validate
  path), pruning to `keep`. Config `BACKUP_INTERVAL_HOURS` (default `24`),
  `BACKUP_KEEP` (default `7`); `0` hours disables.
- **Scheduled tasks** migration + `src/tasks.ts`:
  table `scheduled_tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, prompt TEXT NOT NULL, every_minutes INTEGER NOT NULL, next_run_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`;
  `db.tasks` CRUD; `createTaskRunner({ db, now, everyMs, prompt, log })` whose
  `tick()` enqueues due prompts through `runner.prompt(threadId, ...)` using the
  most recent thread for the channel (or creates one via injected
  `ensureThread(channelId)`); commands `/task add channel prompt every_minutes`
  (owner-only), `/task list`, `/task remove id` (owner-only).
- **Deploy docs:** new `docs-site/guides/deployment-linux.mdx` (systemd unit,
  `nvm`/`fnm` Node 24, `sbx` install, backups, log rotation) and nav entry;
  Windows deployment page gains a backup/rotation section.
- **Acceptance:** real-HTTP tests for admin routes; rotation tests with temp
  files; backup test asserting `VACUUM INTO` output opens as SQLite; task runner
  fake-clock tests; docs validate + broken-links pass.

### 4.4 E3 — Multi-guild (`multi-guild`)

- Config: `DISCORD_GUILD_IDS` (comma-separated) added; `DISCORD_GUILD_ID`
  remains supported (used when the plural var is absent). `Config` gains
  `guildIds: string[]` (validated non-empty) and keeps `guildId` as
  `guildIds[0]` for compatibility.
- `src/index.ts`: deploy `commandData()` per guild and run `ClientReady`
  subscribe/reconcile for all configured guilds; readiness awaits every guild
  fetch; startup banner lists each guild id.
- Guild-scoped state: `ProjectService.addProject` already takes `guildId`;
  ensure handlers pass `interaction.guildId` / `message.guildId` (fall back to
  the owning project row for messages in threads).
- Access control stays global (env roles) in this plan; per-guild roles are a
  follow-up. Document this limitation.
- **Acceptance:** config tests for plural/singular parsing and validation;
  wiring test with two fake guilds asserting two `commands.set` calls and
  per-guild deploy errors isolated (one failing guild must not abort startup);
  docs + `.env.example` updated.

### 4.5 C — Approvals and questions (`approvals-and-questions`)

- Config `APPROVAL_MODE` (`auto` | `buttons` | `plan`, default `buttons`) seeded
  into `settings.approval_mode`; per-channel override key
  `approval_mode:<channelId>`; `/mode auto|buttons|plan` command (owner-only)
  writes the channel setting.
  - `auto`: current `evaluatePermission` behavior, replies immediately.
  - `plan` (read-only): auto-allow read-only tools (`read`, `glob`, `grep`,
    `list`, `find`, `webfetch`? no — `webfetch` denied), auto-reject
    `bash`, `edit`, `write`, `patch`, `external_directory`, unknown tools.
  - `buttons`: allow read-only tools automatically; post an approval message
    for everything else using `ApprovalManager`.
- New v2 client in `src/opencode.ts`:
  `createV2Client(project)` and `resolveV2Client(project)` using
  `@opencode-ai/sdk/v2/client` with the same `baseUrl`/Basic auth.
  `Runner` replies to v1 permissions via the v1 endpoint and v2 permissions via
  `client.session.permission.reply`.
- `question.asked` → `ApprovalManager.askQuestion` → Discord message with
  buttons for options (≤5, single-select) or a string select (≤25), a custom
  answer modal when `custom !== false`, and a Reject button. Multi-question
  requests render one row group per question and collect answers in order.
  Timeout rejects.
- `cellyPolicy().permission.question` changes from `"deny"` to `"allow"` when
  the approval mode is `buttons` (otherwise the server never emits
  `question.asked`); the bridge still auto-rejects questions in `auto` and
  `plan` modes.
- Audit: every permission decision, question answer/rejection, `!shell`
  command, and `/mode` change appends an audit entry (best effort; failures log
  and never fail the interaction).
- Buttons remain live after restart only as stale-message cleanup (clicking an
  old button reports "this request is no longer active"); no persistence.
- **Acceptance:** fake-clock timeout tests; decision-reply routing tests for
  v1 and v2; plan-mode allow/deny table tests; modal + select + button
  interaction tests; audit file tests; docs for `/mode`, approval flow, and
  updated security posture (`question` no longer permanently denied when
  buttons mode is on).

### 4.6 B — Worktrees and forks (`worktrees-and-forks`)

- **Worktrees:** the worktree root is `<project>/.celly/worktrees/<slug>`
  (inside the sandbox mount). On first use, append `.celly/` to the project's
  `.gitignore` when missing (log, don't fail, when unwritable). New
  `src/worktrees.ts` pure helpers:
  `worktreeSlug(text): string`, `worktreeBranch(threadId): string` (`celly/<short>`),
  `parseWorktreeList(stdout): { path: string; branch?: string }[]`,
  `mergeOutcome(stdout, stderr, code): { ok: boolean; conflicts: string[] }`.
  Commands run inside the sandbox via `sbx.exec` (git is in the opencode
  template): `git -C <projectSandboxPath> worktree add -b celly/<slug> .celly/worktrees/<slug> HEAD`,
  `git worktree list --porcelain`, `git merge --no-ff` in the project root,
  `git worktree remove --force`.
  `/worktree` (status), `/worktree new [name]`, `/worktree merge` (owner-only,
  refuses with a dirty check `git status --porcelain`), `/worktree remove
  [--force]`. Store the sandbox worktree path in the existing `threads.worktree_path`.
- **Directory routing:** `RunnerDeps` gains `directoryFor(threadId): string | undefined`;
  every session call (`create`, `promptAsync`, `abort`, `messages`, `diff`,
  `summarize`) passes `query: { directory }` when defined.
- **Forks:** `/fork [prompt]` creates a new Discord thread and session via
  `session.fork({ path: { id: sessionId }, query: { directory } })`, copying
  model/agent/worktree from the source thread; `/btw <prompt>` is `/fork` with
  a `btw · ` title prefix; `/last-sessions [count]` lists recent DB threads
  (ephemeral, max 10).
- **`--clone`:** `/project create` gains optional `clone` (https-only) and
  `branch` options. After sandbox create and bootstrap, run
  `git -C <projectSandboxPath> clone --branch <branch|default> <url> .`; failure
  rolls back the project like other create failures. Validate the URL with a
  strict `https://` regex before any spawn.
- **Acceptance:** pure-helper tests (slug/branch/parse/merge outcome), command
  wiring tests asserting exact argv, dirty-check refusal, clone rollback,
  directory propagation into prompt/abort payloads.

### 4.7 A — Conversation UX (`conversation-ux`)

- **Queue UI:** `Runner` queue entries gain `createdAt`; methods
  `queuedFor(threadId)`, `removeQueued(threadId, index): boolean`,
  `clearQueued(threadId): number`. `/queue` posts an ephemeral list (first 10)
  with `Remove` buttons per row (`celly:queue-remove:<threadId>:<index>`) and a
  `Clear` button (`celly:queue-clear:<threadId>`); refresh after each action.
  Stale/out-of-range index answers "queue changed; run /queue again".
- **Session utilities** (all require a known thread and a ready sandbox):
  - `/undo` — `session.messages` to find the last `user` message id, then
    `session.revert({ path: { id: sessionId }, body: { messageID }, query: { directory } })`.
  - `/redo` — `session.unrevert(...)`.
  - `/diff` — `session.diff(...)`; render up to 10 files as
    `status path (+adds/-dels)` plus totals; chunked via `chunkMessage`.
  - `/share` — `session.share(...)`; post the share URL.
  - `/compact` — `session.summarize({ path, body: { providerID, modelID }, query })`
    using the thread's model; if unset, `error: set a model with /model first`.
  - `/context-usage` — last assistant message tokens (`session.messages`) plus
    `Model.limit.context` from `config.providers()`; render `used/limit (pct%)`
    with a 20-cell bar; ephemeral.
- **Autocomplete:** `onInteraction` gains `interaction.isAutocomplete()`.
  `/resume`, `/model`, `/agent`, and `/task add`-style channel options use
  `.setAutocomplete(true)`. New `src/autocomplete.ts`:
  `createSuggestionCache({ ttlMs, load, now })` with
  `suggest(query): Promise<string[]>` reading a stale-while-revalidate cache;
  autocomplete handlers answer within Discord's 3s budget and return `[]` on
  cache miss while a background refresh runs. `/model` autocomplete values are
  `provider/model`, `/agent` values are agent names.
- **Per-channel defaults:** settings keys `default_model:<channelId>` and
  `default_agent:<channelId>`. `/model` and `/agent` invoked in a project
  channel (not a thread) set the channel default; in a thread they keep the
  per-thread override. New threads seed from channel default, then global
  `settings.default_model|default_agent`.
- **Streaming polish:** tool lines render as
  `> [name] status · title` (title truncated to 120 chars) via the extended
  `tool` event. Token/duration footer is providers-and-cost's responsibility
  (renderer `setFooter`); conversation-ux only adds `startedAt`/`elapsedMs`.
- **Acceptance:** queue index/staleness tests; revert/unrevert payload tests;
  diff/context formatting tests with fixture data; autocomplete cache TTL and
  empty-cache behavior; channel-vs-thread default precedence; renderer tool-line
  tests.

### 4.8 D — Providers and cost (`providers-and-cost`)

- **Cost tracking:** migration adds `threads.cost REAL NOT NULL DEFAULT 0`,
  `threads.tokens_in INTEGER NOT NULL DEFAULT 0`, `threads.tokens_out INTEGER
  NOT NULL DEFAULT 0`, `threads.tokens_cache_read INTEGER NOT NULL DEFAULT 0`,
  `threads.tokens_cache_write INTEGER NOT NULL DEFAULT 0`; `db.threads.addUsage(threadId, delta)`
  and a `db.usage` namespace (`thread`, `channel`, `totals` returning
  `{ cost, tokensIn, tokensOut, cacheRead, cacheWrite }`).
  `Runner.onEvent` handles `usage` by persisting and calling
  `renderer.setFooter(...)` with `$0.0123 · 1.2k in / 3.4k out`.
- **Budget:** config `SESSION_BUDGET_USD` (number ≥ 0, default `0` = off).
  When a run's accumulated `cost` reaches the budget, the runner aborts it,
  appends `[budget] session budget reached ($X of $Y)`, and posts a channel
  warning. Tested with fake usage events.
- **Commands:** `/cost` (thread totals + channel total + budget, ephemeral;
  works in thread or channel) and `/budget show|set <usd>` (owner-only, channel
  scope; stored as `budget_usd:<channelId>` setting overriding the env seed).
- **OAuth login:** `/login <provider>` (owner-only) reads `provider.auth()`,
  picks the `oauth` method (`error` when none), calls
  `provider.oauth.authorize({ path: { id }, body: { method } })`, and posts an
  ephemeral message with the URL and instructions. `/login-code <provider> <code>`
  calls `provider.oauth.callback(...)` (a `true` result means the server
  persisted the credentials; `auth.set` is not used for OAuth) and confirms. `auto`-method flows instruct the user to finish in the browser
  and then run `/login <provider>` again to verify via `provider.auth()`/config
  list. Credentials transit the sandbox server only; never logged.
- **Deferred (documented, not implemented here):** `sbx secret` management from
  Discord requires a host spike on `sbx secret ls/set-custom` output and stdin
  behavior. Record it in the spec open items and in
  `docs-site/guides/providers.mdx` as host-only.
- **Acceptance:** usage parsing tests (step-finish + message.updated),
  persistence/totals tests, budget abort test, footer rendering test, OAuth
  flow tests with fake SDK clients (authorize → code → callback → auth.set),
  owner-only gating, docs updated.

## 5. Open Items (host verification required, not blocking plans)

1. Whether the 1.18.32 server emits `permission.updated` (v1) or
   `permission.asked`/`question.asked` (v2); implementations handle both.
2. `sbx secret ls/set-custom` output shape and stdin support (D deferred item).
3. Windows terminal behavior of `sbx exec -it` + `opencode attach` (TUI).
4. Publishing the OpenCode web UI (rejected in F; revisit only with a tunnel).
5. Whether `session.revert`/`summarize` require a configured model when the
   thread has none (A returns a clear error).
