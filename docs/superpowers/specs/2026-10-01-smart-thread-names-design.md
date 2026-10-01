# Smart Thread Names — Design

Date: 2026-10-01
Status: approved (brainstorming complete)

## Goal

Make Discord thread names carry a live status signal and let the agent itself
give the session a short, accurate name once it understands the task. The
descriptive title is authored once, in-band, by the session model and then
frozen; a status prefix keeps updating afterward.

This replaces the current behavior where the thread name is set once at
creation from the raw first prompt and never updated
(`src/handlers.ts:83`, `src/index.ts:538`, `src/render.ts:116`).

## Behavior

A managed thread's Discord name is composed as:

```
{statusPrefix} · {title}
```

Example: `🟢 working · Fix auth redirect loop`.

- **Status prefix** — the only part that keeps changing after the title locks.
- **Title** — seeded at creation from the first prompt (today's
  `sanitizeThreadName`); the agent may replace it once; after that it is hard
  locked for the thread's life. If the agent never names the thread, the seeded
  title stands.

### Status states

| Source signal | Prefix |
| --- | --- |
| `RenderState.running` | `🟢 working` |
| a permission or question pending in the approval flow | `⛔ blocked` |
| `RenderState.idle` | `⏸️ idle` |
| `RenderState.errored` | `❌ error` |
| `RenderState.aborting` | `⏹️ stopping` |

`blocked` is derived in the runner: emitted when a permission request or agent
question enters the approval flow, cleared on `permission-replied` /
`question-replied` (back to `working`, or `idle` on the terminal event).

## Marker protocol

The agent names the session by emitting a single line in the assistant text:

```
:::celly-name <title>
```

- Parsing is line-anchored: `^:::celly-name[ \t]+(.+)$` (multiline; a
  trailing end-of-part also counts as a terminator).
- On the first valid marker for a thread, the title is extracted, normalized,
  stored, and the thread is locked. Later markers are ignored.
- The marker line is stripped from the user-visible reply on every text update,
  including an incomplete trailing marker, so users never see it.
- Extraction for locking happens on the final assistant text (at `session.idle`
  / `finalize`), so a partially streamed title cannot lock early. Stripping for
  display happens on every text event.

### Title normalization

- Strip quotes, surrounding markdown emphasis/backticks, and trailing
  punctuation.
- Collapse all whitespace runs to single spaces.
- Cap at 10 words and 80 characters (truncate on word/char boundary).
- Reject an empty result (no lock).

## Instruction injection

Celly already manages the sandbox bootstrap and writes global opencode config.
We add a global rules file at `~/.config/opencode/AGENTS.md` (opencode loads it
for every session; confirmed in opencode docs "Rules → Global"). It is written
by the sandbox user via the existing stdin bootstrap script, so `$HOME`
expands in the shell and no path needs to be embedded in the JSON config.

The directive:

- Explains the session's topic appears as the Discord thread name.
- Tells the agent to emit `:::celly-name <title>` exactly once, after it
  understands the task (for example, after gathering requirements or writing a
  spec).
- Constrains the title to at most 10 words, no trailing punctuation, no quotes.
- States the line is removed before the user sees it and must not be mentioned.

If `~/.config/opencode/AGENTS.md` cannot be written on an existing sandbox
(bootstrap only runs on create), the rename still works for newly created
sandboxes; existing sandboxes simply never receive a name (seeded title
stands). This is acceptable and documented as a limitation.

## Rate limiting and coalescing

Discord permits roughly two channel-name edits per ten minutes per channel, so
renames are coalesced and throttled:

- Status/title changes only update an in-memory **desired** value.
- A flush is scheduled after the desired state has been stable for
  `SETTLE_MS` (default 20s).
- A per-thread token bucket: capacity 2, refill 1 every `REFILL_MS`
  (default 5 min). A flush consumes a token only when the composed name differs
  from the last applied name.
- If no token is available, or the rename fails, the desired state is kept and
  the flush is rescheduled.
- A `429`/`retry_after` response sets `blockedUntil`.
- All renames are fire-and-forget; they never block or fail a run.

## Persistence

New `threads` columns (migration v10):

- `name_locked INTEGER NOT NULL DEFAULT 0` — the agent has named it (hard lock).
- `name_manual INTEGER NOT NULL DEFAULT 0` — a human renamed it; stop all
  auto-renaming for this thread.
- `last_thread_name TEXT` — the exact last name Celly wrote, used to tell our
  own edit apart from a human's in the `ThreadUpdate` event.

`Thread` gains `nameLocked: boolean`, `nameManual: boolean`,
`lastThreadName: string | null`. `rowToThread` and `upsert` include them.

## Manual rename detection

On `Events.ThreadUpdate`, if the thread is known, not archived, and
`newThread.name !== thread.lastThreadName`, mark the thread manual and cancel
pending renames. Celly's own writes set `lastThreadName` (via the DB) before the
event arrives, so they are not mistaken for manual edits.

## Components

### New module `src/thread-name.ts`

Pure functions:

- `type ThreadStatus = "working" | "blocked" | "idle" | "error" | "stopping"`
- `statusPrefix(status: ThreadStatus): string`
- `composeThreadName(status, title): string` — Discord 100-char safe.
- `normalizeTitle(raw: string): string | null`
- `parseNameMarker(text: string): string | null` — returns the raw captured
  title (normalized) or null.
- `stripNameMarker(text: string): string`

`ThreadNamer` class (deps injected for testability):

```ts
interface ThreadNamerDeps {
  enabled(): boolean
  rename(threadId: string, name: string): Promise<void>
  getTitle(threadId: string): string | null
  isLocked(threadId: string): boolean
  markLocked(threadId: string): void
  setLastThreadName(threadId: string, name: string): void
  setStatus?(threadId: string, status: ThreadStatus): void
  now(): number
  log(msg: string, fields?: Record<string, unknown>): void
  settleMs?: number
  bucketCapacity?: number
  refillMs?: number
}
```

Public methods:

- `setStatus(threadId, status)` — store desired status, schedule settle.
- `noteFinalText(threadId, text)` — parse marker; if first and unlocked,
  normalize, `markLocked`, set title, schedule settle.
- `onManualRename(threadId)` — mark manual, cancel timers (persisted by caller).
- `flush(threadId)` (internal, timer-driven) — compose, compare to last,
  consume token, `rename`, update last, catch/backoff.
- `cancel(threadId)` — clear timers on thread removal.

`ThreadNamer` does not touch Discord or the DB directly; the caller wires those
via deps.

### Wiring

- `src/runner.ts`: add `onThreadState?(threadId, status)` to `RunnerDeps`. Call
  it wherever `setRenderState` is invoked (running/aborting/errored/idle), and
  emit `blocked` when a permission/question enters the approval flow;
  clear on `permission-replied`/`question-replied`. In `onEvent`, strip markers
  from `text` events before pushing to the renderer; at `idle`, call
  `namer.noteFinalText(threadId, renderer.plainText())`.
- `src/render.ts`: add `Renderer.plainText(): string` returning the
  concatenation of `text` segments.
- `src/index.ts`: construct `ThreadNamer`; `rename` fetches the thread channel
  and calls `setName`; persist via `db.threads`; hook `ThreadUpdate` for manual
  rename; pass `onThreadState` to the runner; seed `last_thread_name` on thread
  creation; rename once to apply an initial status prefix.
- `src/opencode.ts`: extend `buildBootstrapInstallScript` to write the global
  `AGENTS.md` directive.

### Config

`SMART_THREAD_NAMES` — boolean, default `true` (same `bool(env, ...)` helper as
`ATTACH_AUTO_THREAD`). Gates the whole feature. Storage doc + README.

## Error handling

- Marker parse failure / non-compliance → seeded title stands; no error.
- Rename failure (permissions, `429`, unknown channel) → desired state kept,
  logged at warn, retried after backoff; never blocks the run.
- Unknown thread / removed project → namer cancels timers and no-ops.
- Disabled flag → namer never schedules or renames.

## Testing

- Pure: `statusPrefix`, `composeThreadName`, `normalizeTitle` (word/char cap,
  quotes, punctuation, empty), `parseNameMarker` (terminated, end-of-text,
  partial, multiple), `stripNameMarker`.
- `ThreadNamer`: one-shot lock and later markers ignored; coalesces multiple
  status changes into one rename; token bucket throttles; skips when composed
  name is unchanged; keeps desired on rename failure; manual rename stops
  future renames; disabled flag no-ops. Fake timers (`vi.useFakeTimers`).
- `Renderer.plainText`.
- Runner: emits `onThreadState`; strips markers from text events; calls
  `noteFinalText` at idle.
- DB: migration v10 adds columns and round-trips through `upsert`/`get`.
- opencode bootstrap script writes the global AGENTS.md with the marker.

## Docs and release

- `docs-site/guides/configuration.mdx` + README: `SMART_THREAD_NAMES`.
- `docs-site/reference/limitations.mdx` + README: Discord rename rate limit;
  existing sandboxes need recreation to receive the naming instruction; the
  agent may never name a thread.
- `docs-site/reference/architecture.mdx`: `thread-name.ts` module.
- Changeset: **minor** (new subsystem + default-behavior change).

## Risks

- Discord rename limits and thread-rename permissions.
- Model compliance with the marker (mitigated: seeded title fallback, and the
  instruction is a persistent global rule).
- `ThreadUpdate` self-vs-manual detection across restarts depends on
  `last_thread_name`; a thread renamed before this feature ships has a null
  baseline and will be treated as manual on its first human edit.

## Decisions log

- Title authored once by the session model, in-band (marker), then hard locked.
- Status prefix stays live after the lock.
- Fallback when unnamed: seeded prompt-derived title.
- Manual rename stops all auto-renaming.
- Status prefix does not count toward the 10-word title budget.
- Injection via global `~/.config/opencode/AGENTS.md`, not per-prompt text.
- `SMART_THREAD_NAMES` default on; failures never block runs.

## Out of scope

- A custom opencode tool / MCP server for naming (considered; the marker is
  enough for phase 1).
- Per-reply title regeneration and ephemeral model calls.
- A user command to lock/unlock a thread name.
- Showing status anywhere other than the thread name.
