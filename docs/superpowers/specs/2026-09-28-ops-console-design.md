# Celly Ops Console Design Spec

**Date:** 2026-09-28
**Status:** Approved design (2026-09-28 brainstorming session)
**Plan:** to be generated from this spec via `superpowers:writing-plans`

This spec replaces the text-list admin page at `src/admin.ts` with a local ops
console: live project cards, usage and cost, an audit trail, a project detail
panel with redacted logs and sessions, and project create/remove. It keeps the
existing JSON API and loopback-only, no-auth posture.

## 1. Goals

- A single page served by the existing `node:http` admin server at
  `http://127.0.0.1:<ADMIN_PORT>` that shows live project state without manual
  refreshes.
- Act on projects from the page: start, stop, restart, and (new) create/remove.
- See per-project detail: status, port, sandbox, sessions, and a redacted log
  tail.
- Show aggregate usage/cost and the real audit trail.
- Zero new npm dependencies, no build step, offline-safe. Htmx and its SSE
  extension are vendored as committed static files.
- Keep every existing `/api/*` JSON contract working; extend it with parity
  routes for the new actions.
- Keep all existing tests green and add HTTP-level tests for the new surface.

## 2. Non-goals (v1)

- Authentication or any non-loopback binding.
- Editing project settings, secrets, or scheduled tasks from the console.
- Real-time CPU/memory metrics, sparklines, or historical charts (no data
  source exists).
- Daily usage rollups (usage is cumulative per thread; there is no daily
  breakdown to show).
- Admin-action audit entries (the audit model has no admin kind; see §11).
- Theme toggle, mobile navigation, drag interactions.

## 3. Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (`test/imports.test.ts`).
- Only `src/opencode.ts` and `src/projects.ts` may build
  `http://127.0.0.1:${...}` template URLs (`test/imports.test.ts`). New admin
  modules must not match that pattern.
- Style: double quotes, no statement semicolons, 2-space indent. Tests use flat
  `test(...)` (no `describe`) with `import { expect, test } from "vitest"` and
  `../src/x.ts` imports.
- The admin server stays dependency-free in spirit: `node:http`, `node:fs`,
  `node:path`, `node:url` only. No web framework, no bundler, no CDN at runtime.
- All dynamic text rendered into HTML goes through one shared escaping helper.
- Logs are always passed through `redact(text, deps.secrets)` before rendering.

## 4. Stack decision

- **htmx 4.0.0** core plus the **hx-sse** extension, vendored:
  - `assets/admin/htmx.min.js` from `htmx.org@4.0.0/dist/htmx.min.js`
  - `assets/admin/hx-sse.min.js` from `htmx.org@4.0.0/dist/ext/hx-sse.min.js`
  - `assets/admin/VERSIONS.md` records version, source URL, SHA-256, and license
    for each file plus a refresh procedure.
- htmx 4 is tagged `next` on npm (2.0.11 is `latest`), so the version is pinned
  exactly and the files are committed. Upgrade only deliberately.
- Fallback if htmx 4 blocks implementation (see §15): switch to htmx 2.0.11 +
  `htmx-ext-sse@2.2.4`, which changes only the SSE attributes and asset files.
- No custom client JavaScript except `assets/admin/app.js`, limited to
  copy-to-clipboard for attach commands (§9.4). Everything else is declarative
  HTML attributes.
- Styles live in `assets/admin/app.css` (plain CSS custom properties, no
  framework).

## 5. Architecture

### 5.1 Files

| File | Responsibility |
|---|---|
| `src/admin.ts` | Public entry: `ADMIN_HOST`, `AdminDeps`, `AdminServer`, `createAdminServer`, `tailLines`. Owns HTTP routing, request parsing, SSE registration, tick loop. Re-exports nothing else. |
| `src/admin/views.ts` | Pure render functions returning HTML strings; owns `escapeHtml`. No I/O. |
| `src/admin/assets.ts` | Allowlisted static file serving; resolves `assets/admin/` and maps filenames to content types. |
| `src/admin/sse.ts` | SSE client registry: `add(res)`, `broadcast(html)`, `clientCount()`, `closeAll()`. Frame encoding only, no rendering. |
| `assets/admin/` | Vendored `htmx.min.js`, `hx-sse.min.js`, `app.css`, `app.js`, `VERSIONS.md` |
| `test/admin.test.ts` | Existing JSON tests, extended |
| `test/admin-ui.test.ts` | New page/fragment/asset/SSE tests |

`src/admin.ts` stays the import path the tests use. `src/admin/` is a new
directory; both resolve assets with `new URL("../../assets/admin/", import.meta.url)`
from the module in `src/admin/assets.ts` (same relative layout under `dist/`).

### 5.2 AdminDeps

```ts
export interface AdminCreateInput {
  guildId: string
  name: string
  cloneUrl?: string
  branch?: string
}

export interface AdminDeps {
  port: number
  db: Pick<Db, "projects" | "threads" | "usage">
  secrets: string[]
  guildIds: string[]
  logFileFor(channelId: string): string | undefined
  start(channelId: string): Promise<void>
  stop(channelId: string): Promise<void>
  restart(channelId: string): Promise<void>
  create(input: AdminCreateInput, onProgress?: (stage: string) => void): Promise<void>
  remove(channelId: string): Promise<void>
  auditTail?(limit: number): unknown[]
  now?(): number
  liveTickMs?: number
}
```

- `liveTickMs` defaults to `2000`; tests set a small value for determinism.
- `guildIds` drives the guild selector in the create form (rendered only when
  more than one).

### 5.3 `src/index.ts` wiring

Mirror the Discord command semantics in `src/commands.ts:283-345`:

- `restart`: `stopSubscription(channelId)` → `projects.restartServer(channelId)`
  → `startSubscription(channelId)`.
- `remove`: `runnerSvc.resetChannel(channelId, { notify: true })` →
  `stopSubscription(channelId)` → `projects.remove(channelId)`.
- `start`/`stop`: unchanged from today's wiring (`src/index.ts:481-486`).
- `create`:
  ```ts
  create: async (input, onProgress) => {
    if (input.branch && !input.cloneUrl) throw new Error("branch requires clone")
    const directory = await projects.createProjectDirectory(input.name)
    const clone = input.cloneUrl ? { url: input.cloneUrl, ...(input.branch ? { branch: input.branch } : {}) } : undefined
    await projects.addProject({ guildId: input.guildId, name: input.name, directory, ...(clone ? { clone } : {}) }, onProgress)
  }
  ```
  Subscription happens through the existing `onProjectReady` wiring
  (`src/index.ts:177`).
- `guildIds: cfg.guildIds`.

`test/wiring.test.ts` gains source-level assertions that these five deps are
passed to `createAdminServer` (same style as the existing admin assertions).

## 6. HTTP interface

### 6.1 Routes

HTML page and fragments (all loopback):

| Method | Path | Response |
|---|---|---|
| GET | `/` | Full console page |
| GET | `/events` | `text/event-stream` snapshot + live updates |
| GET | `/partials/projects` | Project list fragment |
| GET | `/partials/stats` | Stat card row fragment |
| GET | `/partials/usage` | Usage & cost panel fragment |
| GET | `/partials/audit` | Audit panel fragment |
| GET | `/partials/projects/:id/detail` | Detail panel fragment (logs, sessions, attach) |
| POST | `/partials/projects` | Start async create; `204` |
| POST | `/partials/projects/:id/start` | Updated card + extra partials |
| POST | `/partials/projects/:id/stop` | Updated card + extra partials |
| POST | `/partials/projects/:id/restart` | Updated card + extra partials |
| POST | `/partials/projects/:id/delete` | Refreshed project list; clears detail |
| GET | `/assets/:file` | Allowlisted static file |

JSON API (existing rows unchanged in shape and status codes):

| Method | Path | Response |
|---|---|---|
| GET | `/api/projects` | unchanged |
| POST | `/api/projects` | `201 { ok: true, name }`; awaits the full create |
| GET | `/api/health` | unchanged |
| POST | `/api/projects/:id/start` | unchanged |
| POST | `/api/projects/:id/stop` | unchanged |
| POST | `/api/projects/:id/restart` | `200 { ok, action, channelId }` |
| DELETE | `/api/projects/:id` | `200 { ok, channelId }` |
| GET | `/api/logs/:id` | unchanged |
| GET | `/api/audit` | unchanged |

Any unmatched route keeps returning `{ "error": "not found" }` with `404`;
wrong methods on matched API routes keep returning `405` JSON. Fragment routes
return `404` JSON for unknown projects and `405` JSON for wrong methods.

`AdminCreateInput` validation (shared by the form and JSON route):
- `name` required, trimmed, non-empty.
- `branch` without `cloneUrl` → `400 { error: "branch requires clone" }` on the
  JSON route; on the form route this is prevented client-side and re-checked in
  `create`.
- `guildId` must be one of `deps.guildIds`.

### 6.2 Fragment and action response conventions

- A card fragment root is `<article id="project-<channelId>" class="project ...">`.
  Action responses swap `outerHTML` of that element.
- Action responses append `<hx-partial hx-target="#stats">…</hx-partial>`,
  `#usage`, and `#audit` fragments so aggregates update without waiting for the
  tick.
- Delete responses target `#projects` (`innerHTML`) and include
  `<hx-partial hx-target="#detail"></hx-partial>` to clear the open detail.
- Detail responses target `#detail` (`innerHTML`) and include a partial for
  `#project-<channelId>` carrying `aria-current="true"` on the selected card.
- Every fragment response is complete HTML for its target (no client templating).
- Fragment responses set `cache-control: no-store`.

### 6.3 Assets

- `deps` allowlist: `htmx.min.js`, `hx-sse.min.js`, `app.js`
  → `application/javascript; charset=utf-8`; `app.css` → `text/css; charset=utf-8`.
- Exact filename match against the allowlist; any other value → `404`.
- Read from `assets/admin/` resolved relative to the module; `cache-control: no-store`.
- The page loads `htmx.min.js` before `hx-sse.min.js`, then `app.js` deferred.

## 7. SSE design

- The page contains a hidden connection element:
  `<div id="events" hx-sse:connect="/events" hx-swap="none" hidden></div>`.
  `hx-swap="none"` prevents raw message content from swapping into the hidden div.
- Every server frame is an unnamed SSE event whose `data:` payload is one or
  more swap commands, using `<hx-partial hx-target="#...">…</hx-partial>` for
  each region. htmx 4 extracts partials before the normal (empty) swap.
- On connect the server immediately sends a snapshot frame containing partials
  for `#projects`, `#stats`, `#usage`, and `#audit` (no log partials). This
  makes reconnect self-healing without `Last-Event-ID` replay; every broadcast is
  full-state, so replay is never needed.
- The tick (every `liveTickMs`, default 2000) computes a signature per region
  from the source data; a region is broadcast only when its signature changed.
  Signatures are `JSON.stringify` of the minimal source data (project rows,
  usage totals, audit tail), not of rendered HTML.
- Log broadcasting: for each project with status `ready`, read
  `logFileFor(channelId)` if it exists, take the last 200 lines after `redact`,
  and compare with the previous tail. On change, broadcast
  `<hx-partial hx-target="#logs-<channelId>">…lines…</hx-partial>`. The log pane
  only exists in the DOM while its detail panel is open, so partials for other
  projects are dropped by the client; the server keeps no per-client selection
  state.
- Heartbeat comment (`: ping`) every 15 seconds.
- Actions call `broadcastSnapshot()` after mutating so the UI updates
  immediately rather than waiting for the next tick.
- `close()` clears the tick and heartbeat timers and ends all client responses.
- Frame encoding: a helper splits multi-line HTML on `\n` and writes one
  `data:` line per line (SSE spec joins with `\n` on the client). Injecting
  raw newlines into a single `data:` line is invalid and must not be done.

## 8. Views and visual system

### 8.1 Calm, flat direction

The console UI is **authored from scratch** as server-rendered htmx fragments in
`src/admin/views.ts` with `assets/admin/app.css`. No static mockup is carried
forward. The brief below sets the direction; exact values may be tuned during
implementation as long as the contrast and accessibility requirements hold.

- Flat surfaces, thin borders, no gradients, no glows, no glass, no shadows
  beyond at most a subtle hairline.
- Muted status palette: green `#6FBF8B`, amber `#CEA65E`, blue `#6FA8CC`, red
  `#D98A8A` on `#0F1219` / panels `#151A23`, text `#E6EAF0`, dim `#8C99AA`,
  faint `#5C6878`.
- System sans stack for text; `ui-monospace` for ports, costs, tokens,
  timestamps, log lines.
- Layout: header (brand, live dot, health summary, local-only note), stat row,
  two-column main (projects + side panels) collapsing to one column under
  980px, detail panel below.
- Motion: only `opacity`/`background` transitions on hover/focus, 120-180ms;
  `prefers-reduced-motion: reduce` disables them.

### 8.2 Data mapping (real data only)

| UI element | Source | Formatting |
|---|---|---|
| Project status pill | `Project.status` | ready/degraded/provisioning with dot + label |
| Port | `Project.hostPort` | `:3001` |
| Sandbox | `Project.sandboxName` | mono, secondary line |
| Last active | `Project.lastActiveAt` | relative ("12m ago") |
| Per-project spend | `db.usage.channel(id).cost` | `$0.00`, cumulative |
| Per-project tokens | `usage.channel(id)` in+out | `640k` |
| Sessions count | `db.threads.byChannel(id).length` | integer |
| Stat row | see below | |
| Usage panel | `db.usage.totals()` | total cost, total tokens, prompt/completion split bars, cache read/write line |
| Audit panel | `deps.auditTail(20)` | `HH:MM`, kind label, detail, decision |
| Detail logs | `deps.logFileFor(id)` + `redact` | last 200 lines, mono, colored level prefixes |
| Detail sessions | `db.threads.byChannel(id)` | title, `thread/<id>`, model/agent, renderState, relative last active |
| Attach command | `attachCommand(project, thread.sessionId)` | mono code line + copy button |

Stat row (four cards): `Projects` (count + ready/degraded/provisioning
breakdown from `db.projects.list()`), `Spend` (cumulative `usage.totals().cost`),
`Tokens` (cumulative in+out), `Uptime` (`now() - startedAt`).

Never rendered: `serverPassword`, `directory`, log contents before redaction.

### 8.3 Accessibility

- All controls are real `<button>`/`<a>`/`<form>` elements; no div buttons.
- Visible `:focus-visible` outline on all interactive elements.
- `#notice` is `role="status" aria-live="polite"`.
- The log pane is `role="log" aria-live="polite"`.
- Selected card carries `aria-current="true"`.
- Status is conveyed by text label in addition to color.
- Color contrast target: body text and muted text ≥ 4.5:1 against their
  backgrounds; verify the palette before merge.
- `prefers-reduced-motion: reduce` removes transitions.

## 9. Feature behavior

### 9.1 Project cards

Each card shows name, status pill, port, sandbox, last active, per-project
spend/tokens/sessions, and actions:

- `Start` (only when status is `degraded`)
- `Stop` and `Restart` (when `ready` or `degraded`)
- `Logs` (opens detail, §9.3; always shown)
- `Remove` (danger, §9.5; always shown)
- While `provisioning`: no actions, just a disabled "Starting…" placeholder

htmx attributes on action buttons:
`hx-post="/partials/projects/:id/<action>"`,
`hx-target="#project-:id"`, `hx-swap="outerHTML"`,
`hx-disabled-elt="find button"`. `Stop` and `Remove` also have `hx-confirm`.
The card shows a spinner span with `.htmx-indicator` while a request is in
flight.

### 9.2 Aggregates

Stats, usage, and audit fragments are server-rendered from the DB and audit tail
on every render, broadcast on change (§7), and otherwise refreshed by their own
`GET /partials/...` routes (usable manually; no polling is configured).

### 9.3 Detail panel

- Clicking `Logs` on a card issues
  `GET /partials/projects/:id/detail` with `hx-target="#detail"` and
  `hx-swap="innerHTML"`.
- The response contains: header (name, status pill, port, sandbox, last active),
  Restart/Stop/Copy-attach actions, the log pane
  `<pre id="logs-<channelId>" role="log">`, and the session list.
- Sessions show title (or `session <id>`), `thread/<threadId>`, model/agent when
  present, render state, and relative last-active time. Each session has a copy
  button carrying the attach command in a `data-command` attribute.
- Empty states: "no logs yet" and "no sessions yet".

### 9.4 Copy attach

`assets/admin/app.js` is at most ~25 lines: one delegated `click` listener for
`[data-copy]` that writes the attribute value with `navigator.clipboard.writeText`,
briefly swaps the button label to "Copied". No other script. Without JS, the
command is visible as selectable monospace text.

### 9.5 Create and remove

Create:

- A `<details class="new-project">` in the Projects header contains the form:
  `name` (required), `guildId` select (only when `deps.guildIds.length > 1`; a
  hidden input carries the only guild otherwise), `cloneUrl` (optional,
  `type="url"`), `branch` (optional).
- `hx-post="/partials/projects"`, `hx-disabled-elt="find button"`, target the
  form itself with `hx-swap="outerHTML"`; the handler responds `204` (no swap) so
  the form stays available.
- The POST handler starts `deps.create(input, onProgress)` without awaiting it.
  `onProgress(stage)` broadcasts `<hx-partial hx-target="#notice">stage</hx-partial>`.
  On completion the handler broadcasts an empty `#notice` and the tick picks up
  the new row; on failure it broadcasts the error text into `#notice` styled as
  an error and logs a warning. The handler never rejects on create failure.
- Validation failure (bad guild, branch without clone) returns `400` JSON; the
  form re-checks `branch requires clone` client-side via the browser's
  `required`/`minlength` only where possible; the server check is authoritative.

Remove:

- `Remove` posts to `/partials/projects/:id/delete` with
  `hx-confirm="Remove #<name>? This stops the sandbox and deletes the Discord channel. The host directory is kept."`
- Handler resolves the project, calls `deps.remove(channelId)`, then returns the
  refreshed project list plus the empty `#detail` partial.
- Unknown project → `404` JSON. Failure → `200` with the list unchanged plus an
  error notice in `#notice` (the action does not throw to htmx).

## 10. Error handling

| Situation | Behavior |
|---|---|
| Fragment action on unknown project | `404 { "error": "unknown project" }` |
| Fragment action throws | `200`, card rendered with an inline error note; `log.warn` server-side |
| JSON action throws | `500 { "error": message }` (unchanged) |
| Create validation failure | JSON route `400`; form route `400`; nothing started |
| Create runtime failure | `#notice` error text; DB rollback handled by `addProject` |
| Remove failure | `#notice` error text; list re-rendered unchanged |
| Log file missing/unreadable | "no logs yet" placeholder; no error |
| Asset not allowlisted/missing | `404`, no filesystem probing |
| SSE client write fails | client dropped from the registry; server keeps running |
| Tick render throws | caught, logged at `warn` once per tick, other regions still broadcast |

## 11. Security

- Loopback-only (`ADMIN_HOST = "127.0.0.1"`), no authentication by design.
  The console can now create and remove projects (removal deletes the Discord
  channel and sandbox), so this must be stated in the page footer and in
  `docs-site/reference/security.mdx`.
- All interpolated text is escaped with `escapeHtml` (`& < > " '`).
- `serverPassword` and `directory` are never rendered; sandbox name and port
  are considered non-secret.
- Create always places the project directory under `PROJECTS_ROOT` through
  `projects.createProjectDirectory(name)`; the web form cannot pass a path.
  `ProjectService.validateDirectory` remains the second line of defense.
- Attach commands are built with `attachCommand` and contain no secret.
- Logs pass through `redact(text, deps.secrets)`; the index wiring already
  includes project server passwords in `secrets` on ready.
- Assets are allowlisted by exact filename; no path joining with user input.
- Route params used for DB lookups are opaque ids; unknown ids never reach the
  filesystem.
- No new outbound network calls.

## 12. Testing

All tests are HTTP-level against a real server bound to port 0, following the
existing `test/admin.test.ts` style. A shared factory constructs the server with
injected fakes and returns `{ svr, db, calls, base }`.

`test/admin.test.ts` (existing, updated):
- All nine existing tests keep passing with the new required deps supplied as
  no-op fakes (`restart`, `create`, `remove`, `guildIds: []`).

`test/admin-ui.test.ts` (new):
1. `GET /` renders the console shell: links `/assets/app.css`, loads
   `htmx.min.js` and `hx-sse.min.js`, includes `hx-sse:connect="/events"`,
   renders a project name, and escapes a `<b>bold</b>` project name.
2. `GET /` never contains the project's `serverPassword`.
3. `GET /partials/projects` renders cards with status classes and action
   buttons for a ready project.
4. `GET /partials/stats`, `/partials/usage`, `/partials/audit` render expected
   values from injected usage and `auditTail`.
5. `POST /partials/projects/:id/start|stop|restart` call the injected function
   once with the channel id and return the updated card plus
   `<hx-partial hx-target="#stats">` (and `#usage`, `#audit`).
6. Fragment action on an unknown project returns 404 JSON; wrong method returns
   405 JSON.
7. A throwing fragment action returns 200 with an inline error note.
8. `POST /partials/projects` parses form-encoded fields, calls `create` with
   `{ guildId, name, cloneUrl, branch }`, and returns 204; `branch` without
   `cloneUrl` returns 400 and does not call `create`.
9. Invoking the captured `onProgress` writes a notice into the SSE stream.
10. `POST /partials/projects/:id/delete` calls `remove`, returns a list without
    the project and an empty `#detail` partial.
11. `GET /partials/projects/:id/detail` renders the log pane with the
    `logs-<channelId>` id, redacts a secret from a temp log file, and renders
    sessions from `db.threads`.
12. `GET /assets/htmx.min.js` and the other three assets return 200 with the
    right content type; `GET /assets/nope.js` and
    `GET /assets/..%2F..%2Fpackage.json` return 404.
13. `GET /events` returns `text/event-stream`, then an initial snapshot
    containing `<hx-partial hx-target="#projects">`; closing the stream does not
    error the server.
14. With `liveTickMs` set small, a DB mutation produces a further `#projects`
    partial within the test timeout.
15. A changed temp log file produces a `#logs-<channelId>` partial with the
    secret redacted.
16. JSON parity: `POST /api/projects` awaits `create` and returns 201;
    `DELETE /api/projects/:id` calls `remove`; `POST .../restart` calls
    `restart`; validation failures return 400.

`test/wiring.test.ts`: source assertions that the five new deps are wired.

`test/imports.test.ts`: unchanged; new `src/admin/*.ts` files must not import
`node:child_process` or build loopback template URLs.

Verification per commit: `npm test`, `npm run typecheck`, `npm run build`.

## 13. Implementation slices

Each slice is independently reviewable and leaves the suite green.

1. **Assets + shell.** Vendor htmx 4.0.0 and hx-sse, add `VERSIONS.md`, the
   asset allowlist route, `app.css`, `views.ts` page shell with static data,
   and tests 12 + the page-shell parts of test 1.
2. **Fragments + API parity.** All `/partials/*` GET routes, action POST routes
   with card + partials, `/api` parity including restart/delete/create, the
   `AdminDeps` expansion, and the `index.ts` wiring. Tests 3-7, 10, 16 and the
   existing-test updates.
3. **SSE + live regions.** `sse.ts` hub, snapshot on connect, tick with
   signatures, action broadcasts, heartbeat, notices. Tests 8 (progress), 13-15.
4. **Detail panel + logs + copy.** Detail route, sessions, log pane, copy
   script. Tests 11 and 2.
5. **Create/remove UI + docs.** `<details>` form, confirm on remove, README and
   docs-site updates, security note, changeset, full verification pass.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| htmx 4.0 is a one-month-old major, tagged `next`, docs still settling | Pin 4.0.0, commit the files, validate `hx-sse:connect` + `<hx-partial>` in slice 3 before building on them. Fallback to 2.0.11 + `htmx-ext-sse` is contained to SSE attributes and two files. |
| `hx-partial` behavior inside normal (non-SSE) responses | Slice 2 verifies with an HTTP test before the pattern spreads. If unavailable, substitute `hx-swap-oob` with stable ids (same rendering functions). |
| Multi-line HTML in SSE `data:` frames | Frame encoder emits one `data:` line per HTML line; tested in slice 3 with a multi-line log fragment. |
| Create saga runs minutes; request times out in the browser | Fragment create returns 204 immediately and streams progress into `#notice`; JSON create awaits by design and is documented as slow. |
| SSE stream paused while tab hidden (`pauseOnBackground`) | Snapshot on (re)connect covers missed changes; tick only sends changes, snapshot fills gaps. |
| Long-lived SSE during server shutdown | `close()` ends all clients and clears timers; `test/admin.test.ts` additionally verifies no unhandled errors. |

## 15. Out of scope / future

- Scheduled task panel (`db.tasks.list()` is already available).
- Per-project detail tabs (sessions/usage split) and log search.
- Admin-action audit entries (needs an audit kind or a separate log).
- Daily usage rollups (needs time-series data; today only cumulative exists).
- Charts/sparklines (needs history), CPU/memory (no source).
- Auth, TLS, non-loopback binding, multi-user concerns.
