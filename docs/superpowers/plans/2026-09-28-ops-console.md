# Celly Ops Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Celly's text-list admin page with a loopback ops console: live project cards, usage/cost, audit trail, project detail with redacted logs and sessions, and project create/remove — using vendored htmx 4.0 (server-rendered fragments + SSE), no new npm dependencies, no build step.

**Architecture:** `src/admin.ts` keeps the public entry and HTTP routing. New `src/admin/views.ts` renders pure HTML fragments, `src/admin/assets.ts` serves an allowlist of files from `assets/admin/`, and `src/admin/sse.ts` is a small Server-Sent Events client registry. A 2s server tick broadcasts `<hx-partial hx-target="#...">` frames for regions whose source data changed; the browser runs one `hx-sse:connect="/events"` connection. The existing `/api/*` JSON contracts stay intact and gain parity routes.

**Tech Stack:** Node 24 (`node:http`, `node:fs`, `node:url`), TypeScript ESM, Vitest, htmx 4.0.0 + hx-sse (vendored), plain CSS.

**Spec:** `docs/superpowers/specs/2026-09-28-ops-console-design.md`

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process`.
- Only `src/opencode.ts` and `src/projects.ts` may match the template pattern `http://127.0.0.1:${`.
- Style: double quotes, no statement semicolons, 2-space indent.
- Tests: flat `test(...)` (no `describe`), `import { expect, test } from "vitest"`, `../src/x.ts` imports, temp dirs via `mkdtempSync(join(tmpdir(), "celly-admin-"))` with `try/finally rmSync`.
- No new npm dependencies; no build step; htmx + hx-sse are committed under `assets/admin/`.
- All dynamic text passes through `escapeHtml` (`& < > " '`).
- Logs always pass through `redact(text, deps.secrets)` before rendering.
- Never render `serverPassword` or `directory`.
- Verify with `npm test`, `npm run typecheck`, `npm run build` before each commit.

---

### Task 1: Vendored assets and the static asset route

**Files:**
- Create: `assets/admin/htmx.min.js` (downloaded, htmx 4.0.0)
- Create: `assets/admin/hx-sse.min.js` (downloaded, htmx 4.0.0)
- Create: `assets/admin/app.css`
- Create: `assets/admin/app.js`
- Create: `assets/admin/VERSIONS.md`
- Create: `src/admin/assets.ts`
- Test: `test/admin-assets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `readAsset(name: string): { body: Buffer; contentType: string } | undefined`
  - `isAllowedAsset(name: string): boolean`
  - `ALLOWED_ASSETS: string[]`

- [ ] **Step 1: Download the vendored libraries and record versions**

Run:

```bash
mkdir -p assets/admin
curl -fsSL "https://cdn.jsdelivr.net/npm/htmx.org@4.0.0/dist/htmx.min.js" -o assets/admin/htmx.min.js
curl -fsSL "https://cdn.jsdelivr.net/npm/htmx.org@4.0.0/dist/ext/hx-sse.min.js" -o assets/admin/hx-sse.min.js
sha256sum assets/admin/htmx.min.js assets/admin/hx-sse.min.js
wc -c assets/admin/htmx.min.js assets/admin/hx-sse.min.js
```

Expected: both files downloaded and non-empty. Copy the two SHA-256 values and byte counts into the next step.

- [ ] **Step 2: Write `assets/admin/VERSIONS.md`**

```markdown
# Vendored admin assets

Pinned copies served by the admin server. Refreshing is a deliberate change:
re-download, update the hash, and re-run the test suite.

| File | Package | Version | Source | SHA-256 | License |
|---|---|---|---|---|---|
| `htmx.min.js` | `htmx.org` | 4.0.0 | https://cdn.jsdelivr.net/npm/htmx.org@4.0.0/dist/htmx.min.js | `<paste sha256>` | BSD-2-Clause |
| `hx-sse.min.js` | `htmx.org` (ext) | 4.0.0 | https://cdn.jsdelivr.net/npm/htmx.org@4.0.0/dist/ext/hx-sse.min.js | `<paste sha256>` | BSD-2-Clause |

`app.css` and `app.js` are authored in this repository.
```

Replace both `<paste sha256>` placeholders with the values from Step 1.

- [ ] **Step 3: Write `assets/admin/app.js`**

```js
// Copy-to-clipboard for attach commands. Optional enhancement only.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-copy]") : null
  if (!target) return
  const value = target.getAttribute("data-copy") ?? ""
  if (!value) return
  void navigator.clipboard.writeText(value)
  const previous = target.textContent
  target.textContent = "Copied"
  setTimeout(() => { target.textContent = previous }, 1200)
})
```

- [ ] **Step 4: Write `assets/admin/app.css`**

```css
:root{
  --bg:#0F1219; --panel:#151A23; --panel2:#18202b; --muted:#1D242F;
  --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.12);
  --fg:#E6EAF0; --dim:#8C99AA; --faint:#5C6878;
  --green:#6FBF8B; --amber:#CEA65E; --blue:#6FA8CC; --red:#D98A8A;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1160px;margin:0 auto;padding:32px 22px 72px}
header.top{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:18px}
.logo{width:24px;height:24px;border-radius:7px;background:#1F3A2C;border:1px solid rgba(111,191,139,.3);display:grid;place-items:center}
.logo svg{width:14px;height:14px}
.local{color:var(--faint);font-size:12px;font-family:var(--mono)}
.grow{flex:1}
.live{display:inline-flex;align-items:center;gap:7px;color:var(--dim);font-size:12px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block;flex:0 0 auto}
.dot.warn{background:var(--amber)} .dot.prov{background:var(--blue)}
.health{display:inline-flex;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--border);border-radius:999px;padding:6px 13px;font-size:12px;color:var(--dim)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.stat .k{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.7px}
.stat .v{font-size:22px;font-weight:650;font-family:var(--mono);margin-top:5px}
.stat .d{font-size:11.5px;color:var(--dim);margin-top:3px}
.layout{display:grid;grid-template-columns:1.5fr 1fr;gap:16px;align-items:start}
@media(max-width:980px){.layout{grid-template-columns:1fr}}
h2.section{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--faint);font-weight:600;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.count{background:var(--muted);border:1px solid var(--border);border-radius:999px;padding:1px 7px;font-size:10px;font-family:var(--mono);color:var(--dim)}
.projects{display:flex;flex-direction:column;gap:10px}
.project{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px}
.project[aria-current="true"]{border-color:var(--border2)}
.row1{display:flex;align-items:flex-start;gap:12px}
.name{font-weight:600;font-size:15px}
.meta{color:var(--dim);font-size:12px;font-family:var(--mono);margin-top:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;text-transform:capitalize;background:var(--muted);color:var(--dim);border:1px solid var(--border)}
.pill.ready{color:var(--green);border-color:rgba(111,191,139,.28)}
.pill.degraded{color:var(--amber);border-color:rgba(206,166,94,.28)}
.pill.provisioning{color:var(--blue);border-color:rgba(111,168,204,.28)}
.spacer{flex:1}
.actions{display:flex;gap:6px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--border2);color:var(--dim);border-radius:7px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--sans)}
.btn:hover{color:var(--fg);border-color:var(--faint)}
.btn.primary{color:var(--green);border-color:rgba(111,191,139,.32)}
.btn.danger{color:var(--red);border-color:rgba(217,138,138,.3)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--border2);border-top-color:var(--green)}
.htmx-indicator{opacity:0;transition:opacity .15s ease}
.htmx-request .htmx-indicator,.htmx-request.htmx-indicator{opacity:1}
.metrics{display:flex;gap:20px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border);flex-wrap:wrap}
.metric .k{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.6px}
.metric .v{font-size:13px;font-family:var(--mono);font-weight:600;margin-top:1px}
.new-project{margin:0 0 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel)}
.new-project>summary{cursor:pointer;padding:10px 14px;color:var(--dim);font-size:13px;font-weight:600}
.new-project[open]>summary{border-bottom:1px solid var(--border)}
.new-project form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;padding:14px}
.new-project label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.5px}
.new-project input,.new-project select{background:var(--bg);border:1px solid var(--border2);color:var(--fg);border-radius:6px;padding:7px 9px;font-size:13px;font-family:var(--sans)}
.side{display:flex;flex-direction:column;gap:16px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:8px}
.panel .head{padding:12px 15px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.panel .head .t{font-size:11px;text-transform:uppercase;letter-spacing:.9px;color:var(--faint);font-weight:600}
.panel .body{padding:15px}
.usage{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.u{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:11px 12px}
.u .k{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.6px}
.u .v{font-size:19px;font-weight:650;font-family:var(--mono);margin-top:3px}
.barrow{margin-top:13px}
.barrow .lab{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-bottom:5px;font-family:var(--mono)}
.bar{height:7px;background:var(--muted);border-radius:999px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:999px;background:#4E7A62}
.bar i.b{background:#46617A}
.tl{display:flex;gap:11px;padding:9px 0;border-bottom:1px solid var(--border)}
.tl:last-child{border-bottom:0}
.tl .ic{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:0 0 auto;background:var(--green)}
.tl.warn .ic{background:var(--amber)} .tl.err .ic{background:var(--red)} .tl.info .ic{background:var(--blue)}
.tl .txt{font-size:12.5px;color:var(--dim)}
.tl .time{font-size:11px;color:var(--faint);font-family:var(--mono);margin-top:2px}
.detail{margin-top:16px;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.detail.empty{display:none}
.dhead{padding:15px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.dbody{display:grid;grid-template-columns:1.6fr 1fr}
@media(max-width:760px){.dbody{grid-template-columns:1fr}}
.logs{background:#0B0E13;padding:14px;font-family:var(--mono);font-size:12px;max-height:230px;overflow:auto;white-space:pre-wrap}
.lg{color:var(--dim)}
.lg.err{color:var(--red)}
.sessions{padding:14px;border-left:1px solid var(--border)}
.sess{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:12.5px}
.sess:last-child{border-bottom:0}
.s-name{font-weight:600}
.s-sub{color:var(--faint);font-size:11px;font-family:var(--mono);margin-top:2px}
.empty{color:var(--faint);font-size:12.5px}
#notice{min-height:0}
.notice{margin-bottom:14px;padding:10px 13px;border-radius:7px;font-size:13px;border:1px solid var(--border2);color:var(--dim);background:var(--panel)}
.notice.error{border-color:rgba(217,138,138,.4);color:var(--red)}
footer{margin-top:30px;color:var(--faint);font-size:11px;text-align:center;font-family:var(--mono)}
@media(prefers-reduced-motion:reduce){*{transition:none !important}}
```

- [ ] **Step 5: Write the failing test**

Create `test/admin-assets.test.ts`:

```ts
import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { isAllowedAsset, readAsset } from "../src/admin/assets.ts"

test("the vendored admin assets are present and identifiable", () => {
  const htmx = readFileSync("assets/admin/htmx.min.js", "utf8")
  const sse = readFileSync("assets/admin/hx-sse.min.js", "utf8")
  expect(htmx).toContain("htmx")
  expect(sse.toLowerCase()).toContain("sse")
  expect(htmx.length).toBeGreaterThan(10_000)
  expect(sse.length).toBeGreaterThan(1_000)
})

test("readAsset serves only allowlisted files with content types", () => {
  expect(isAllowedAsset("app.css")).toBe(true)
  expect(isAllowedAsset("app.js")).toBe(true)
  expect(isAllowedAsset("htmx.min.js")).toBe(true)
  expect(isAllowedAsset("hx-sse.min.js")).toBe(true)
  expect(isAllowedAsset("package.json")).toBe(false)
  expect(isAllowedAsset("../package.json")).toBe(false)
  expect(isAllowedAsset("..%2Fpackage.json")).toBe(false)

  const css = readAsset("app.css")
  expect(css?.contentType).toBe("text/css; charset=utf-8")
  expect(css?.body.toString("utf8")).toContain("--bg")
  expect(readAsset("nope.js")).toBeUndefined()
  expect(readAsset("../package.json")).toBeUndefined()
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/admin-assets.test.ts`
Expected: FAIL — cannot resolve `../src/admin/assets.ts`.

- [ ] **Step 7: Write `src/admin/assets.ts`**

```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const CONTENT_TYPES: Record<string, string> = {
  "htmx.min.js": "application/javascript; charset=utf-8",
  "hx-sse.min.js": "application/javascript; charset=utf-8",
  "app.js": "application/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
}

export const ALLOWED_ASSETS = Object.keys(CONTENT_TYPES)

export function isAllowedAsset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, name)
}

export interface AssetFile {
  body: Buffer
  contentType: string
}

const ASSET_DIR = new URL("../../assets/admin/", import.meta.url)

export function readAsset(name: string): AssetFile | undefined {
  if (!isAllowedAsset(name)) return undefined
  try {
    const body = readFileSync(new URL(name, ASSET_DIR))
    return { body, contentType: CONTENT_TYPES[name]! }
  } catch {
    return undefined
  }
}

export const assetDirPath = fileURLToPath(ASSET_DIR)
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/admin-assets.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add assets/admin src/admin/assets.ts test/admin-assets.test.ts
git commit -m "feat(admin): vendor htmx 4 assets and add the asset allowlist"
```

---

### Task 2: View formatting helpers

**Files:**
- Create: `src/admin/views.ts`
- Test: `test/admin-views.test.ts`

**Interfaces:**
- Consumes: `UsageTotals`, `ProjectStatus` from `../types.ts`.
- Produces:
  - `escapeHtml(text: string): string`
  - `formatCost(cost: number): string`
  - `formatTokens(tokens: number): string`
  - `formatRelative(now: number, ts: number): string`
  - `formatClock(ts: number): string`
  - `formatUptime(ms: number): string`
  - `renderNotice(text: string, kind: "info" | "error"): string`

- [ ] **Step 1: Write the failing test**

Create `test/admin-views.test.ts`:

```ts
import { expect, test } from "vitest"
import { escapeHtml, formatClock, formatCost, formatRelative, formatTokens, formatUptime, renderNotice } from "../src/admin/views.ts"

test("escapeHtml neutralizes markup in every attribute context", () => {
  expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;")
})

test("formatCost renders sub-cent and empty values", () => {
  expect(formatCost(0)).toBe("$0.00")
  expect(formatCost(4.2)).toBe("$4.20")
  expect(formatCost(0.004)).toBe("<$0.01")
})

test("formatTokens abbreviates thousands and millions", () => {
  expect(formatTokens(0)).toBe("0")
  expect(formatTokens(640)).toBe("640")
  expect(formatTokens(12_300)).toBe("12k")
  expect(formatTokens(1_240_000)).toBe("1.2M")
})

test("formatRelative reports coarse recency", () => {
  const now = 1_000_000_000
  expect(formatRelative(now, now - 10_000)).toBe("just now")
  expect(formatRelative(now, now - 12 * 60_000)).toBe("12m ago")
  expect(formatRelative(now, now - 3 * 3_600_000)).toBe("3h ago")
  expect(formatRelative(now, 0)).toBe("never")
})

test("formatClock is zero padded HH:MM", () => {
  const ts = new Date(2026, 0, 1, 9, 5).getTime()
  expect(formatClock(ts)).toBe("09:05")
})

test("formatUptime reports hours and minutes", () => {
  expect(formatUptime(90_000)).toBe("1m")
  expect(formatUptime(3 * 3_600_000 + 42 * 60_000)).toBe("3h 42m")
})

test("renderNotice escapes text and toggles the error class", () => {
  expect(renderNotice("", "info")).toBe("")
  expect(renderNotice("<x>", "error")).toBe(`<div class="notice error">&lt;x&gt;</div>`)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-views.test.ts`
Expected: FAIL — cannot resolve `../src/admin/views.ts`.

- [ ] **Step 3: Write the helpers in `src/admin/views.ts`**

```ts
import type { UsageTotals } from "../types.ts"

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00"
  if (cost < 0.01) return "<$0.01"
  return `$${cost.toFixed(2)}`
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
  return String(Math.floor(tokens))
}

export function formatRelative(now: number, ts: number): string {
  if (!ts) return "never"
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function formatClock(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function renderNotice(text: string, kind: "info" | "error"): string {
  if (!text) return ""
  return `<div class="notice ${kind}">${escapeHtml(text)}</div>`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-views.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/admin/views.ts test/admin-views.test.ts
git commit -m "feat(admin): add view formatting helpers"
```

---

### Task 3: Card, list, stats, usage, and audit renderers

**Files:**
- Modify: `src/admin/views.ts`
- Test: `test/admin-views.test.ts`

**Interfaces:**
- Consumes: helpers from Task 2.
- Produces:
  - `interface ProjectView { channelId; name; status: ProjectStatus; hostPort; sandboxName; lastActiveAt; spend; tokens; sessions; selected?: boolean }`
  - `renderProjectCard(p: ProjectView, now: number): string`
  - `renderProjects(projects: ProjectView[], now: number): string`
  - `interface StatsView { total; ready; degraded; provisioning; cost; tokens; uptimeMs }`
  - `renderStats(s: StatsView): string`
  - `renderUsage(totals: UsageTotals): string`
  - `interface AuditView { time: string; kind: string; detail: string; decision: string }`
  - `renderAudit(entries: AuditView[]): string`

- [ ] **Step 1: Write the failing test**

Append to `test/admin-views.test.ts`:

```ts
import { renderAudit, renderProjectCard, renderProjects, renderStats, renderUsage } from "../src/admin/views.ts"
import type { ProjectView } from "../src/admin/views.ts"

const project: ProjectView = {
  channelId: "c1", name: "<b>demo</b>", status: "ready", hostPort: 3001,
  sandboxName: "sbx-demo", lastActiveAt: 0, spend: 2.4, tokens: 640_000, sessions: 3,
}

test("renderProjectCard escapes names and wires actions to fragments", () => {
  const html = renderProjectCard(project, 1_000_000)
  expect(html).toContain(`id="project-c1"`)
  expect(html).toContain("&lt;b&gt;demo&lt;/b&gt;")
  expect(html).not.toContain("<b>demo</b>")
  expect(html).toContain(`hx-post="/partials/projects/c1/restart"`)
  expect(html).toContain(`hx-post="/partials/projects/c1/stop"`)
  expect(html).toContain(`hx-post="/partials/projects/c1/delete"`)
  expect(html).toContain("$2.40")
  expect(html).toContain("640k")
})

test("renderProjectCard only offers Start when degraded and disables while provisioning", () => {
  const degraded = renderProjectCard({ ...project, status: "degraded" }, 1_000_000)
  expect(degraded).toContain(`/partials/projects/c1/start`)
  expect(degraded).toContain(`/partials/projects/c1/stop`)
  const provisioning = renderProjectCard({ ...project, status: "provisioning" }, 1_000_000)
  expect(provisioning).toContain("Starting…")
  expect(provisioning).not.toContain(`/partials/projects/c1/start`)
  expect(provisioning).not.toContain(`/partials/projects/c1/stop`)
})

test("renderProjects shows an empty state and joins cards", () => {
  expect(renderProjects([], 0)).toContain("No projects yet")
  const html = renderProjects([project, { ...project, channelId: "c2", name: "two" }], 1_000_000)
  expect(html).toContain(`id="project-c1"`)
  expect(html).toContain(`id="project-c2"`)
})

test("renderStats summarizes counts, spend, tokens, and uptime", () => {
  const html = renderStats({ total: 4, ready: 2, degraded: 1, provisioning: 1, cost: 4.21, tokens: 1_240_000, uptimeMs: 3 * 3_600_000 + 42 * 60_000 })
  expect(html).toContain("$4.21")
  expect(html).toContain("1.2M")
  expect(html).toContain("3h 42m")
  expect(html).toContain("2 ready")
})

test("renderUsage splits prompt and completion and guards divide by zero", () => {
  const html = renderUsage({ cost: 4.21, tokensIn: 820_000, tokensOut: 420_000, cacheRead: 0, cacheWrite: 0 })
  expect(html).toContain("820k")
  expect(html).toContain("420k")
  expect(html).toContain("width:66%")
  expect(renderUsage({ cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })).toContain("$0.00")
})

test("renderAudit escapes entries and maps kinds to a class", () => {
  const html = renderAudit([{ time: "18:42", kind: "permission", detail: "<x> allowed", decision: "allow" }])
  expect(html).toContain("&lt;x&gt; allowed")
  expect(html).toContain("tl warn")
  expect(renderAudit([])).toContain("No audit entries yet")
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-views.test.ts`
Expected: FAIL — `renderProjectCard` is not exported.

- [ ] **Step 3: Add the renderers to `src/admin/views.ts`**

Add the import and code:

```ts
import type { ProjectStatus, UsageTotals } from "../types.ts"

export interface ProjectView {
  channelId: string
  name: string
  status: ProjectStatus
  hostPort: number
  sandboxName: string
  lastActiveAt: number
  spend: number
  tokens: number
  sessions: number
  selected?: boolean
}

function metric(k: string, v: string): string {
  return `<div class="metric"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`
}

function actionButton(p: ProjectView, action: "start" | "stop" | "restart", label: string, confirm: boolean): string {
  const id = escapeHtml(p.channelId)
  const danger = action === "stop" ? " danger" : ""
  const confirmAttr = confirm ? ` hx-confirm="Stop #${escapeHtml(p.name)}?"` : ""
  return `<button class="btn${danger}" hx-post="/partials/projects/${id}/${action}" hx-target="#project-${id}" hx-swap="outerHTML" hx-disabled-elt="find button"${confirmAttr}>${label}</button>`
}

export function renderProjectCard(p: ProjectView, now: number): string {
  const id = escapeHtml(p.channelId)
  const current = p.selected ? ` aria-current="true"` : ""
  const actions: string[] = []
  if (p.status === "degraded") actions.push(actionButton(p, "start", "Start", false))
  if (p.status === "ready" || p.status === "degraded") {
    actions.push(actionButton(p, "restart", "Restart", false))
    actions.push(actionButton(p, "stop", "Stop", true))
  }
  if (p.status === "provisioning") actions.push(`<button class="btn" disabled>Starting…</button>`)
  actions.push(`<button class="btn" hx-get="/partials/projects/${id}/detail" hx-target="#detail" hx-swap="innerHTML" hx-disabled-elt="find button">Logs</button>`)
  actions.push(`<button class="btn danger" hx-post="/partials/projects/${id}/delete" hx-target="#projects" hx-swap="innerHTML" hx-confirm="Remove #${escapeHtml(p.name)}? This stops the sandbox and deletes the Discord channel. The host directory is kept.">Remove</button>`)
  return `<article id="project-${id}" class="project ${p.status}"${current}>
    <div class="row1">
      <div>
        <div class="name">#${escapeHtml(p.name)}</div>
        <div class="meta"><span class="pill ${p.status}"><span class="dot"></span>${escapeHtml(p.status)}</span> :${p.hostPort} · ${escapeHtml(p.sandboxName)} · active ${escapeHtml(formatRelative(now, p.lastActiveAt))}</div>
      </div>
      <div class="spacer"></div>
      <div class="actions">${actions.join("")}<span class="spinner htmx-indicator"></span></div>
    </div>
    <div class="metrics">${metric("Spend", formatCost(p.spend))}${metric("Tokens", formatTokens(p.tokens))}${metric("Sessions", String(p.sessions))}</div>
  </article>`
}

export function renderProjects(projects: ProjectView[], now: number): string {
  if (projects.length === 0) return `<p class="empty">No projects yet. Use “New project” to create one.</p>`
  return projects.map((p) => renderProjectCard(p, now)).join("")
}

export interface StatsView {
  total: number
  ready: number
  degraded: number
  provisioning: number
  cost: number
  tokens: number
  uptimeMs: number
}

export function renderStats(s: StatsView): string {
  return `<div class="stat"><div class="k">Projects</div><div class="v">${s.total}</div><div class="d">${s.ready} ready · ${s.degraded} degraded · ${s.provisioning} starting</div></div>
  <div class="stat"><div class="k">Spend</div><div class="v">${formatCost(s.cost)}</div><div class="d">cumulative</div></div>
  <div class="stat"><div class="k">Tokens</div><div class="v">${formatTokens(s.tokens)}</div><div class="d">cumulative</div></div>
  <div class="stat"><div class="k">Uptime</div><div class="v">${formatUptime(s.uptimeMs)}</div><div class="d">since console start</div></div>`
}

export function renderUsage(totals: UsageTotals): string {
  const sum = totals.tokensIn + totals.tokensOut
  const promptPct = sum > 0 ? Math.round((totals.tokensIn / sum) * 100) : 0
  const completionPct = sum > 0 ? 100 - promptPct : 0
  return `<div class="usage">
    <div class="u"><div class="k">Total spend</div><div class="v">${formatCost(totals.cost)}</div></div>
    <div class="u"><div class="k">Total tokens</div><div class="v">${formatTokens(sum)}</div></div>
  </div>
  <div class="barrow"><div class="lab"><span>prompt</span><span>${formatTokens(totals.tokensIn)}</span></div><div class="bar"><i style="width:${promptPct}%"></i></div></div>
  <div class="barrow"><div class="lab"><span>completion</span><span>${formatTokens(totals.tokensOut)}</span></div><div class="bar"><i class="b" style="width:${completionPct}%"></i></div></div>
  <div class="barrow"><div class="lab"><span>cache read / write</span><span>${formatTokens(totals.cacheRead)} / ${formatTokens(totals.cacheWrite)}</span></div></div>`
}

export interface AuditView {
  time: string
  kind: string
  detail: string
  decision: string
}

function auditClass(kind: string): string {
  if (kind === "permission") return "warn"
  if (kind === "question") return "info"
  if (kind === "shell") return "err"
  return ""
}

export function renderAudit(entries: AuditView[]): string {
  if (entries.length === 0) return `<p class="empty">No audit entries yet.</p>`
  return entries.map((e) => {
    const cls = auditClass(e.kind)
    return `<div class="tl ${cls}"><span class="ic"></span><div><div class="txt">${escapeHtml(e.detail)}</div><div class="time">${escapeHtml(e.time)} · ${escapeHtml(e.kind)} · ${escapeHtml(e.decision)}</div></div></div>`
  }).join("")
}
```

Note: Task 2's file starts with `import type { UsageTotals } from "../types.ts"`. Replace that line with `import type { ProjectStatus, UsageTotals } from "../types.ts"` in this step.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-views.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/admin/views.ts test/admin-views.test.ts
git commit -m "feat(admin): add card, stats, usage, and audit renderers"
```

---

### Task 4: Page shell and detail renderers

**Files:**
- Modify: `src/admin/views.ts`
- Test: `test/admin-views.test.ts`

**Interfaces:**
- Consumes: Task 2-3 renderers and `ProjectView`, `StatsView`, `AuditView`.
- Produces:
  - `interface SessionView { threadId; title; sessionId; model; agent; renderState; lastActiveAt; attach }`
  - `interface DetailView { project: ProjectView; logs: string[]; sessions: SessionView[] }`
  - `renderLogLines(lines: string[]): string`
  - `renderDetail(d: DetailView, now: number): string`
  - `interface PageState { now: number; uptimeMs: number; projects: ProjectView[]; stats: StatsView; usage: UsageTotals; audit: AuditView[]; guildIds: string[] }`
  - `renderPage(s: PageState): string`

- [ ] **Step 1: Write the failing test**

Append to `test/admin-views.test.ts`:

```ts
import { renderDetail, renderLogLines, renderPage } from "../src/admin/views.ts"
import type { DetailView, SessionView } from "../src/admin/views.ts"

test("renderLogLines marks error lines", () => {
  const html = renderLogLines(["[out] ok", "[err] boom"])
  expect(html).toContain(`<div class="lg">[out] ok</div>`)
  expect(html).toContain(`<div class="lg err">[err] boom</div>`)
  expect(renderLogLines([])).toContain("no logs yet")
})

test("renderDetail wires the log target, sessions, and copy commands", () => {
  const session: SessionView = { threadId: "t1", title: "work", sessionId: "s1", model: "m", agent: null, renderState: "idle", lastActiveAt: 0, attach: "sbx exec x" }
  const detail: DetailView = { project, logs: ["[out] hi"], sessions: [session] }
  const html = renderDetail(detail, 1_000_000)
  expect(html).toContain(`id="logs-c1"`)
  expect(html).toContain("role=\"log\"")
  expect(html).toContain("data-copy=\"sbx exec x\"")
  expect(html).toContain("thread/t1")
  expect(html).toContain(`hx-get="/partials/projects/c1/detail"`)
})

test("renderPage includes the asset scripts, SSE connection, and create form", () => {
  const html = renderPage({
    now: 1_000_000, uptimeMs: 60_000, projects: [project],
    stats: { total: 1, ready: 1, degraded: 0, provisioning: 0, cost: 2.4, tokens: 640_000, uptimeMs: 60_000 },
    usage: { cost: 2.4, tokensIn: 400_000, tokensOut: 240_000, cacheRead: 0, cacheWrite: 0 },
    audit: [], guildIds: ["g1"],
  })
  expect(html).toContain("/assets/app.css")
  expect(html).toContain("/assets/htmx.min.js")
  expect(html).toContain("/assets/hx-sse.min.js")
  expect(html).toContain(`hx-sse:connect="/events"`)
  expect(html).toContain(`id="projects"`)
  expect(html).toContain(`id="notice"`)
  expect(html).toContain(`hx-post="/partials/projects"`)
  expect(html).toContain(`name="guildId" value="g1"`)
})

test("renderPage never renders the server password", () => {
  const html = renderPage({
    now: 0, uptimeMs: 0, projects: [project],
    stats: { total: 1, ready: 1, degraded: 0, provisioning: 0, cost: 0, tokens: 0, uptimeMs: 0 },
    usage: { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
    audit: [], guildIds: ["g1"],
  })
  expect(html).not.toContain("serverPassword")
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-views.test.ts`
Expected: FAIL — `renderDetail` is not exported.

- [ ] **Step 3: Add the page and detail renderers to `src/admin/views.ts`**

```ts
export interface SessionView {
  threadId: string
  title: string
  sessionId: string
  model: string | null
  agent: string | null
  renderState: string
  lastActiveAt: number
  attach: string
}

export interface DetailView {
  project: ProjectView
  logs: string[]
  sessions: SessionView[]
}

export function renderLogLines(lines: string[]): string {
  if (lines.length === 0) return `<div class="lg empty">no logs yet</div>`
  return lines.map((line) => `<div class="lg${line.startsWith("[err]") ? " err" : ""}">${escapeHtml(line)}</div>`).join("")
}

export function renderDetail(d: DetailView, now: number): string {
  const p = d.project
  const id = escapeHtml(p.channelId)
  const sessions = d.sessions.length === 0
    ? `<div class="sess empty">no sessions yet</div>`
    : d.sessions.map((s) => {
        const bits = [s.model, s.agent].filter((x): x is string => !!x).map(escapeHtml).join(" · ")
        return `<div class="sess"><div><div class="s-name">${escapeHtml(s.title)}</div><div class="s-sub">thread/${escapeHtml(s.threadId)}${bits ? ` · ${bits}` : ""}</div></div><div><div class="s-sub">${escapeHtml(s.renderState)} · ${escapeHtml(formatRelative(now, s.lastActiveAt))}</div><button class="btn" data-copy="${escapeHtml(s.attach)}">Copy attach</button></div></div>`
      }).join("")
  const actions: string[] = []
  if (p.status === "degraded") actions.push(actionButton(p, "start", "Start", false))
  if (p.status === "ready" || p.status === "degraded") {
    actions.push(actionButton(p, "restart", "Restart", false))
    actions.push(actionButton(p, "stop", "Stop", true))
  }
  return `<div class="dhead">
    <div><div class="name">#${escapeHtml(p.name)}</div><div class="meta"><span class="pill ${p.status}"><span class="dot"></span>${escapeHtml(p.status)}</span> :${p.hostPort} · ${escapeHtml(p.sandboxName)} · active ${escapeHtml(formatRelative(now, p.lastActiveAt))}</div></div>
    <div class="spacer"></div>
    <div class="actions">${actions.join("")}<span class="spinner htmx-indicator"></span></div>
  </div>
  <div class="dbody">
    <div id="logs-${id}" class="logs" role="log" aria-live="polite">${renderLogLines(d.logs)}</div>
    <div class="sessions">${sessions}</div>
  </div>`
}

export interface PageState {
  now: number
  uptimeMs: number
  projects: ProjectView[]
  stats: StatsView
  usage: UsageTotals
  audit: AuditView[]
  guildIds: string[]
}

export function renderPage(s: PageState): string {
  const guildField = s.guildIds.length > 1
    ? `<label>Guild<select name="guildId">${s.guildIds.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("")}</select></label>`
    : `<input type="hidden" name="guildId" value="${escapeHtml(s.guildIds[0] ?? "")}">`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Celly ops console</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/htmx.min.js"></script>
<script src="/assets/hx-sse.min.js"></script>
<script src="/assets/app.js" defer></script>
</head><body>
<div class="wrap">
  <header class="top">
    <div class="brand"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#6FBF8B" stroke-width="2.4"><path d="M4 14a8 8 0 0 1 16 0"/><circle cx="12" cy="19" r="1.6" fill="#6FBF8B" stroke="none"/></svg></span>Celly</div>
    <div class="live"><span class="dot"></span> live</div>
    <div class="grow"></div>
    <div class="local">127.0.0.1 · local only</div>
  </header>
  <div id="notice" role="status" aria-live="polite"></div>
  <section class="stats" id="stats">${renderStats(s.stats)}</section>
  <div class="layout">
    <section>
      <h2 class="section">Projects <span class="count" id="project-count">${s.projects.length}</span></h2>
      <details class="new-project"><summary>New project</summary>
        <form hx-post="/partials/projects" hx-target="this" hx-swap="outerHTML" hx-disabled-elt="find button">
          <label>Name<input name="name" required maxlength="64" pattern="[A-Za-z0-9._-]+"></label>
          ${guildField}
          <label>Clone URL (optional)<input name="cloneUrl" type="url" placeholder="https://..."></label>
          <label>Branch (optional)<input name="branch"></label>
          <button class="btn primary" type="submit">Create</button>
        </form>
      </details>
      <div class="projects" id="projects">${renderProjects(s.projects, s.now)}</div>
    </section>
    <aside class="side">
      <div class="panel"><div class="head"><span class="t">Usage &amp; cost</span></div><div class="body" id="usage">${renderUsage(s.usage)}</div></div>
      <div class="panel"><div class="head"><span class="t">Audit trail</span></div><div class="body" id="audit">${renderAudit(s.audit)}</div></div>
    </aside>
  </div>
  <section class="detail empty" id="detail"></section>
  <footer>Celly ops console · loopback only, no authentication by design · can create and remove projects</footer>
</div>
<div id="events" hx-sse:connect="/events" hx-swap="none" hidden></div>
</body></html>`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-views.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add src/admin/views.ts test/admin-views.test.ts
git commit -m "feat(admin): add page shell and detail renderers"
```

---

### Task 5: Expand AdminDeps, build view models, serve the page

**Files:**
- Modify: `src/admin.ts`
- Test: `test/admin.test.ts`
- Test: `test/admin-ui.test.ts` (create)

**Interfaces:**
- Consumes: `src/admin/views.ts`, `src/admin/assets.ts`, `src/attach.ts` (`attachCommand`).
- Produces:
  - `interface AdminCreateInput { guildId: string; name: string; cloneUrl?: string; branch?: string }`
  - `AdminDeps` with `db: Pick<Db, "projects" | "threads" | "usage">`, `guildIds`, `restart`, `create`, `remove`, `liveTickMs?`, `log?`
  - `GET /` renders `renderPage(...)`.

- [ ] **Step 1: Update the existing tests to the new deps and expected page**

In `test/admin.test.ts`, replace the `admin()` factory (lines 13-28) with:

```ts
async function admin(over: any = {}) {
  const db = over.db ?? fresh()
  if (!over.skipProject) { db.projects.insertProvisioning(proj); db.projects.setReady("c1", "C:\\p") }
  const calls: string[] = []
  const svr = await createAdminServer({
    port: 0,
    db,
    secrets: over.secrets ?? [],
    guildIds: over.guildIds ?? ["g1"],
    logFileFor: over.logFileFor ?? (() => undefined),
    start: async (channelId: string) => { calls.push(`start:${channelId}`) },
    stop: async (channelId: string) => { calls.push(`stop:${channelId}`) },
    restart: async (channelId: string) => { calls.push(`restart:${channelId}`) },
    create: async (input: any) => { calls.push(`create:${input.name}`) },
    remove: async (channelId: string) => { calls.push(`remove:${channelId}`) },
    auditTail: over.auditTail,
    now: over.now,
  })
  return { svr, db, calls, base: `http://127.0.0.1:${svr.port}` }
}
```

Replace the first test ("the admin server binds loopback and renders the HTML status page") with:

```ts
test("the admin server binds loopback and renders the ops console", async () => {
  const { svr, db, base } = await admin()
  db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "<b>bold</b>", sandboxName: "celly-bold", hostPort: 4301 })
  try {
    expect(svr.address).toBe("127.0.0.1")
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("demo")
    expect(body).toContain("&lt;b&gt;bold&lt;/b&gt;")
    expect(body).toContain("/assets/htmx.min.js")
    expect(body).toContain('hx-sse:connect="/events"')
    expect(body).not.toContain("pw")
  } finally {
    svr.close()
  }
})
```

The failing-action test ("a failing project action returns a JSON 500") must also supply the new deps:

```ts
test("a failing project action returns a JSON 500", async () => {
  const db = fresh(); db.projects.insertProvisioning(proj)
  const svr = await createAdminServer({ port: 0, db, secrets: [], guildIds: [], logFileFor: () => undefined,
    start: async () => { throw new Error("boom") }, stop: async () => {}, restart: async () => {},
    create: async () => {}, remove: async () => {} })
  try {
    const res = await fetch(`http://127.0.0.1:${svr.port}/api/projects/c1/start`, { method: "POST" })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "boom" })
  } finally {
    svr.close()
  }
})
```

- [ ] **Step 2: Run the existing suite to verify it fails**

Run: `npx vitest run test/admin.test.ts`
Expected: FAIL — `createAdminServer` rejects unknown deps once typed, and `/` does not yet serve `/assets/htmx.min.js`.

- [ ] **Step 3: Expand `src/admin.ts`**

Replace the imports and `AdminDeps`/`escapeHtml` region (lines 1-28) with:

```ts
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import type { Db } from "./db.ts"
import type { Project, Thread, UsageTotals } from "./types.ts"
import { redact } from "./log.js"
import { attachCommand } from "./attach.ts"
import { readAsset } from "./admin/assets.ts"
import {
  escapeHtml, formatClock, renderAudit, renderPage, renderProjects,
  renderStats, renderUsage,
} from "./admin/views.ts"
import type { AuditView, DetailView, ProjectView, SessionView, StatsView } from "./admin/views.ts"

export const ADMIN_HOST = "127.0.0.1"

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
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
}
```

Add builders after `tailLines`:

```ts
function projectViewFor(p: Project, deps: AdminDeps, now: number, selected = false): ProjectView {
  const usage = deps.db.usage.channel(p.channelId)
  return {
    channelId: p.channelId, name: p.name, status: p.status, hostPort: p.hostPort,
    sandboxName: p.sandboxName, lastActiveAt: p.lastActiveAt,
    spend: usage.cost, tokens: usage.tokensIn + usage.tokensOut,
    sessions: deps.db.threads.byChannel(p.channelId).length,
    ...(selected ? { selected: true } : {}),
  }
}

function buildProjects(deps: AdminDeps, now: number): ProjectView[] {
  return deps.db.projects.list().map((p) => projectViewFor(p, deps, now))
}

function buildStats(projects: ProjectView[], totals: UsageTotals, uptimeMs: number): StatsView {
  return {
    total: projects.length,
    ready: projects.filter((p) => p.status === "ready").length,
    degraded: projects.filter((p) => p.status === "degraded").length,
    provisioning: projects.filter((p) => p.status === "provisioning").length,
    cost: totals.cost,
    tokens: totals.tokensIn + totals.tokensOut,
    uptimeMs,
  }
}

function toAuditView(raw: unknown): AuditView {
  const e = (raw ?? {}) as Record<string, unknown>
  const ts = typeof e.ts === "string" ? Date.parse(e.ts) : Number.NaN
  return {
    time: Number.isFinite(ts) ? formatClock(ts) : "",
    kind: typeof e.kind === "string" ? e.kind : "event",
    detail: typeof e.detail === "string" ? e.detail : "",
    decision: typeof e.decision === "string" ? e.decision : "",
  }
}

function buildAudit(deps: AdminDeps): AuditView[] {
  return (deps.auditTail?.(20) ?? []).map(toAuditView)
}

function buildDetail(deps: AdminDeps, channelId: string): DetailView | undefined {
  const project = deps.db.projects.getByChannel(channelId)
  if (!project) return undefined
  const nowMs = deps.now?.() ?? Date.now()
  const file = deps.logFileFor(channelId)
  const logs = file && existsSync(file) ? tailLines(redact(readFileSync(file, "utf8"), deps.secrets), 200) : []
  const projectView = projectViewFor(project, deps, nowMs)
  const sessions: SessionView[] = deps.db.threads.byChannel(channelId).map((t: Thread) => ({
    threadId: t.threadId, title: t.title ?? `session ${t.sessionId}`, sessionId: t.sessionId,
    model: t.model, agent: t.agent, renderState: t.renderState, lastActiveAt: t.lastActiveAt,
    attach: attachCommand(project, t.sessionId),
  }))
  return { project: projectView, logs, sessions }
}
```

Replace the `/` handler (lines 55-60) with:

```ts
if (parts.length === 0 && method === "GET") {
  const nowMs = now()
  const totals = deps.db.usage.totals()
  const projectViews = buildProjects(deps, nowMs)
  sendHtml(res, 200, renderPage({
    now: nowMs,
    uptimeMs: Math.max(0, nowMs - startedAt),
    projects: projectViews,
    stats: buildStats(projectViews, totals, Math.max(0, nowMs - startedAt)),
    usage: totals,
    audit: buildAudit(deps),
    guildIds: deps.guildIds,
  }))
  return
}
```

Note: `ProjectStatus` is imported for future tasks; if TypeScript reports it unused, drop it from the import list until Task 6 needs it. Keep the import only if used.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npx vitest run test/admin.test.ts test/admin-assets.test.ts test/admin-views.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts test/admin.test.ts
git commit -m "feat(admin): serve the ops console page from view models"
```

---

### Task 6: Fragment routes and the asset route

**Files:**
- Modify: `src/admin.ts`
- Create: `test/admin-ui.test.ts`

**Interfaces:**
- Consumes: Task 5 builders.
- Produces:
  - `GET /assets/:file`
  - `GET /partials/projects`, `/partials/stats`, `/partials/usage`, `/partials/audit`

- [ ] **Step 1: Write the failing test**

Create `test/admin-ui.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createAdminServer } from "../src/admin.ts"
import { openDb } from "../src/db.ts"

const proj = { channelId: "c1", guildId: "g1", name: "demo", directory: "C:\\p",
  sandboxPath: null, sandboxName: "sbx-demo", hostPort: 4300, serverPassword: "pw-secret", createdAt: 1 }

async function ui(over: any = {}) {
  const db = over.db ?? openDb(":memory:")
  if (!over.db) db.migrate()
  if (!over.skipProject) { db.projects.insertProvisioning(proj); db.projects.setReady("c1", "C:\\p") }
  const calls: string[] = []
  let progress: ((stage: string) => void) | undefined
  const svr = await createAdminServer({
    port: 0, db, secrets: over.secrets ?? ["pw-secret"], guildIds: over.guildIds ?? ["g1"],
    logFileFor: over.logFileFor ?? (() => undefined),
    start: async (id: string) => { calls.push(`start:${id}`) },
    stop: async (id: string) => { calls.push(`stop:${id}`) },
    restart: async (id: string) => { calls.push(`restart:${id}`) },
    create: async (input: any, onProgress?: (stage: string) => void) => { calls.push(`create:${input.name}:${input.guildId}`); progress = onProgress },
    remove: async (id: string) => { calls.push(`remove:${id}`) },
    auditTail: over.auditTail,
    now: over.now, liveTickMs: over.liveTickMs ?? 20,
  })
  return { svr, db, calls, base: `http://127.0.0.1:${svr.port}`, getProgress: () => progress }
}

test("GET /partials/projects renders cards and action wiring", async () => {
  const { svr, base } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`id="project-c1"`)
    expect(body).toContain(`hx-post="/partials/projects/c1/restart"`)
  } finally { svr.close() }
})

test("GET /partials/stats, usage, and audit render injected data", async () => {
  const { svr, base } = await ui({ auditTail: (limit: number) => [{ ts: new Date(2026, 0, 1, 9, 5).toISOString(), kind: "permission", detail: "allowed", decision: "allow", limit }] })
  try {
    expect(await (await fetch(`${base}/partials/stats`)).text()).toContain("Projects")
    expect(await (await fetch(`${base}/partials/usage`)).text()).toContain("Total spend")
    const audit = await (await fetch(`${base}/partials/audit`)).text()
    expect(audit).toContain("allowed")
    expect(audit).toContain("09:05")
  } finally { svr.close() }
})

test("fragment routes reject the wrong method", async () => {
  const { svr, base } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects`, { method: "POST" })
    expect(res.status).toBe(405)
  } finally { svr.close() }
})

test("GET /assets serves allowlisted files and 404s anything else", async () => {
  const { svr, base } = await ui()
  try {
    const css = await fetch(`${base}/assets/app.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get("content-type")).toContain("text/css")
    const js = await fetch(`${base}/assets/htmx.min.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toContain("application/javascript")
    expect((await fetch(`${base}/assets/package.json`)).status).toBe(404)
    expect((await fetch(`${base}/assets/..%2Fpackage.json`)).status).toBe(404)
  } finally { svr.close() }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: FAIL — `/partials/projects` returns 404.

- [ ] **Step 3: Add the routes to `src/admin.ts`**

Insert before the `/api/projects` GET handler:

```ts
if (parts[0] === "assets" && parts.length === 2 && method === "GET") {
  const asset = readAsset(parts[1]!)
  if (!asset) return sendJson(res, 404, { error: "not found" })
  res.writeHead(200, { "content-type": asset.contentType, "content-length": asset.body.byteLength, "cache-control": "no-store" })
  res.end(asset.body)
  return
}
if (parts[0] === "partials" && parts.length === 2 && (parts[1] === "projects" || parts[1] === "stats" || parts[1] === "usage" || parts[1] === "audit")) {
  if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
  const nowMs = now()
  const totals = deps.db.usage.totals()
  if (parts[1] === "projects") return sendHtml(res, 200, renderProjects(buildProjects(deps, nowMs), nowMs))
  if (parts[1] === "stats") {
    const projects = buildProjects(deps, nowMs)
    return sendHtml(res, 200, renderStats(buildStats(projects, totals, Math.max(0, nowMs - startedAt))))
  }
  if (parts[1] === "usage") return sendHtml(res, 200, renderUsage(totals))
  return sendHtml(res, 200, renderAudit(buildAudit(deps)))
}
```

Add `cache-control: no-store` to `sendHtml`:

```ts
function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts test/admin-ui.test.ts
git commit -m "feat(admin): add fragment and asset routes"
```

---

### Task 7: Action routes and JSON restart parity

**Files:**
- Modify: `src/admin.ts`
- Test: `test/admin-ui.test.ts`

**Interfaces:**
- Consumes: `renderProjectCard`, `renderUsage`, `renderAudit`, `buildProjects`, `buildAudit`.
- Produces: `POST /partials/projects/:id/start|stop|restart`, `POST /api/projects/:id/restart`.

- [ ] **Step 1: Write the failing test**

Append to `test/admin-ui.test.ts`:

```ts
test("fragment actions call the injected function and return the card plus partials", async () => {
  const { svr, base, calls } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects/c1/restart`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(calls).toEqual(["restart:c1"])
    expect(body).toContain(`id="project-c1"`)
    expect(body).toContain(`hx-partial hx-target="#stats"`)
    expect(body).toContain(`hx-partial hx-target="#usage"`)
    expect(body).toContain(`hx-partial hx-target="#audit"`)
  } finally { svr.close() }
})

test("fragment action on an unknown project is a 404 and a throwing action renders an error card", async () => {
  const { svr, base } = await ui()
  try {
    expect((await fetch(`${base}/partials/projects/nope/start`, { method: "POST" })).status).toBe(404)
    expect((await fetch(`${base}/partials/projects/c1/start`, { method: "GET" })).status).toBe(405)
  } finally { svr.close() }
  const failing = await createAdminServer({
    port: 0, db: (() => { const d = openDb(":memory:"); d.migrate(); d.projects.insertProvisioning(proj); return d })(),
    secrets: [], guildIds: [], logFileFor: () => undefined,
    start: async () => { throw new Error("boom") }, stop: async () => {}, restart: async () => {},
    create: async () => {}, remove: async () => {},
  })
  try {
    const res = await fetch(`http://127.0.0.1:${failing.port}/partials/projects/c1/start`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("id=\"project-c1\"")
    expect(body).toContain("boom")
  } finally { failing.close() }
})

test("POST /api/projects/:id/restart mirrors the JSON action shape", async () => {
  const { svr, base, calls } = await ui()
  try {
    const res = await fetch(`${base}/api/projects/c1/restart`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, action: "restart", channelId: "c1" })
    expect(calls).toEqual(["restart:c1"])
  } finally { svr.close() }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: FAIL — `/partials/projects/c1/restart` returns 404.

- [ ] **Step 3: Add partial `actionError` rendering and the routes**

Add `renderProjectCard` to the `./admin/views.ts` value imports in `src/admin.ts`.

Add a helper in `src/admin.ts`:

```ts
function renderCardWithError(deps: AdminDeps, channelId: string, message: string): string | undefined {
  const project = deps.db.projects.getByChannel(channelId)
  if (!project) return undefined
  const card = renderProjectCard(projectViewFor(project, deps, deps.now?.() ?? Date.now()), deps.now?.() ?? Date.now())
  return card.replace("</article>", `<div class="notice error">${escapeHtml(message)}</div></article>`)
}
```

Extend the existing JSON action route to accept `restart`. Change the condition `(parts[3] === "start" || parts[3] === "stop")` to include `"restart"`, and replace the action dispatch:

```ts
const action = parts[3]
const run = action === "start" ? deps.start : action === "stop" ? deps.stop : deps.restart
try {
  await run(channelId)
  sendJson(res, 200, { ok: true, action, channelId })
} catch (e) {
  sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
}
```

Add the fragment action route after the fragment GET block:

```ts
if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 4 && (parts[3] === "start" || parts[3] === "stop" || parts[3] === "restart")) {
  if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
  const channelId = parts[2]!
  if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
  const action = parts[3]
  const nowMs = now()
  try {
    await (action === "start" ? deps.start(channelId) : action === "stop" ? deps.stop(channelId) : deps.restart(channelId))
    const totals = deps.db.usage.totals()
    const projects = buildProjects(deps, nowMs)
    const body = renderProjectCard(projectViewFor(deps.db.projects.getByChannel(channelId)!, deps, nowMs), nowMs)
      + `\n<hx-partial hx-target="#stats">${renderStats(buildStats(projects, totals, Math.max(0, nowMs - startedAt)))}</hx-partial>`
      + `\n<hx-partial hx-target="#usage">${renderUsage(totals)}</hx-partial>`
      + `\n<hx-partial hx-target="#audit">${renderAudit(buildAudit(deps))}</hx-partial>`
    sendHtml(res, 200, body)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const body = renderCardWithError(deps, channelId, message) ?? ""
    sendHtml(res, 200, body)
  }
  return
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts test/admin-ui.test.ts
git commit -m "feat(admin): add fragment action routes and restart parity"
```

---

### Task 8: SSE hub module

**Files:**
- Create: `src/admin/sse.ts`
- Test: `test/admin-sse.test.ts`

**Interfaces:**
- Consumes: `node:http` `ServerResponse`.
- Produces:
  - `encodeFrame(html: string): string`
  - `interface SseHub { add(res: ServerResponse): void; broadcast(html: string): void; clientCount(): number; closeAll(): void }`
  - `createSseHub(opts?: { heartbeatMs?: number }): SseHub`

- [ ] **Step 1: Write the failing test**

Create `test/admin-sse.test.ts`:

```ts
import { createServer } from "node:http"
import { expect, test } from "vitest"
import { createSseHub, encodeFrame } from "../src/admin/sse.ts"

test("encodeFrame prefixes every line and terminates the event", () => {
  expect(encodeFrame("a\nb")).toBe("data: a\ndata: b\n\n")
  expect(encodeFrame("<x>")).toBe("data: <x>\n\n")
})

test("the hub streams frames to connected clients and drops closed ones", async () => {
  const hub = createSseHub({ heartbeatMs: 10_000 })
  const server = createServer((req, res) => { hub.add(res) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as any).port
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal })
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  await reader.read()
  expect(hub.clientCount()).toBe(1)
  hub.broadcast(`<hx-partial hx-target="#projects">hi</hx-partial>`)
  let text = ""
  while (!text.includes("#projects")) {
    const chunk = await reader.read()
    text += decoder.decode(chunk.value, { stream: true })
  }
  expect(text).toContain(`hx-target="#projects"`)
  controller.abort()
  await new Promise((r) => setTimeout(r, 20))
  expect(hub.clientCount()).toBe(0)
  hub.closeAll()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-sse.test.ts`
Expected: FAIL — cannot resolve `../src/admin/sse.ts`.

- [ ] **Step 3: Write `src/admin/sse.ts`**

```ts
import type { ServerResponse } from "node:http"

export function encodeFrame(html: string): string {
  return `${html.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`
}

export interface SseHub {
  add(res: ServerResponse): void
  broadcast(html: string): void
  clientCount(): number
  closeAll(): void
}

export function createSseHub(opts: { heartbeatMs?: number } = {}): SseHub {
  const clients = new Set<ServerResponse>()
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(": ping\n\n") } catch { clients.delete(res) }
    }
  }, opts.heartbeatMs ?? 15_000)
  if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref()
  return {
    add(res) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      })
      res.write(": connected\n\n")
      clients.add(res)
      res.on("close", () => clients.delete(res))
    },
    broadcast(html) {
      const frame = encodeFrame(html)
      for (const res of clients) {
        try { res.write(frame) } catch { clients.delete(res) }
      }
    },
    clientCount() { return clients.size },
    closeAll() {
      clearInterval(heartbeat)
      for (const res of clients) { try { res.end() } catch {} }
      clients.clear()
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-sse.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/admin/sse.ts test/admin-sse.test.ts
git commit -m "feat(admin): add the SSE hub"
```

---

### Task 9: `/events` snapshot, tick, log streaming, and action broadcasts

**Files:**
- Modify: `src/admin.ts`
- Test: `test/admin-ui.test.ts`

**Interfaces:**
- Consumes: `createSseHub`, `renderProjects`, `renderStats`, `renderUsage`, `renderAudit`, `renderLogLines`, builders.
- Produces: `GET /events`; `partial(target, html): string` helper; the hub instance local to `createAdminServer`.

- [ ] **Step 1: Write the failing test**

Append to `test/admin-ui.test.ts`:

```ts
test("GET /events sends a snapshot, then a changed project update", async () => {
  const { svr, db, base } = await ui({ liveTickMs: 25 })
  const controller = new AbortController()
  try {
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + 2000
    let text = ""
    while (!text.includes(`hx-target="#projects"`) && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain(`hx-partial hx-target="#projects"`)
    expect(text).toContain(`hx-partial hx-target="#stats"`)
    db.projects.insertProvisioning({ ...proj, channelId: "c2", name: "celly-second", sandboxName: "sbx-second", hostPort: 4302 })
    while (!text.includes("celly-second") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain("celly-second")
  } finally { controller.abort(); svr.close() }
})

test("a changed log file streams into the #logs-c1 target with secrets redacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-admin-"))
  const file = join(dir, "sbx-demo.log")
  writeFileSync(file, "[out] first\n")
  const { svr, base } = await ui({ logFileFor: () => file, secrets: ["pw-secret"] })
  const controller = new AbortController()
  try {
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    const deadline = Date.now() + 1500
    writeFileSync(file, "[out] first\n[err] pw-secret leaked\n")
    while (!text.includes("#logs-c1") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain(`hx-target="#logs-c1"`)
    expect(text).toContain("[redacted]")
    expect(text).not.toContain("pw-secret")
  } finally { controller.abort(); svr.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("a fragment action broadcasts fresh regions over SSE", async () => {
  const { svr, base, calls } = await ui()
  try {
    const controller = new AbortController()
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    await reader.read()
    await fetch(`${base}/partials/projects/c1/restart`, { method: "POST" })
    let text = ""
    const deadline = Date.now() + 1500
    while (!text.includes("#audit") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(calls).toEqual(["restart:c1"])
    expect(text).toContain(`hx-target="#projects"`)
    controller.abort()
  } finally { svr.close() }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: FAIL — `/events` returns 404.

- [ ] **Step 3: Add the hub, tick, and `/events` route to `src/admin.ts`**

Add to imports:

```ts
import { createSseHub } from "./admin/sse.ts"
import { renderLogLines } from "./admin/views.ts"
```

Inside `createAdminServer`, before `createServer`, add:

```ts
const sse = createSseHub()
const signatures = new Map<string, string>()
const partial = (target: string, html: string) => `<hx-partial hx-target="${target}">${html}</hx-partial>`

function region(target: string, html: string, signature: string): void {
  if (signatures.get(target) === signature) return
  signatures.set(target, signature)
  sse.broadcast(partial(target, html))
}

function snapshot(): string {
  const nowMs = now()
  const projects = buildProjects(deps, nowMs)
  const totals = deps.db.usage.totals()
  return [
    partial("#projects", renderProjects(projects, nowMs)),
    partial("#stats", renderStats(buildStats(projects, totals, Math.max(0, nowMs - startedAt)))),
    partial("#usage", renderUsage(totals)),
    partial("#audit", renderAudit(buildAudit(deps))),
  ].join("\n")
}

function broadcastAll(): void {
  signatures.clear()
  sse.broadcast(snapshot())
}

const tick = setInterval(() => {
  try {
    const nowMs = now()
    const list = deps.db.projects.list()
    const projects = buildProjects(deps, nowMs)
    const totals = deps.db.usage.totals()
    const auditRaw = deps.auditTail?.(20) ?? []
    region("#projects", renderProjects(projects, nowMs), JSON.stringify(list.map((p) => [p.channelId, p.status, p.hostPort, p.lastActiveAt])))
    region("#stats", renderStats(buildStats(projects, totals, Math.max(0, nowMs - startedAt))), JSON.stringify([list.length, projects.filter((p) => p.status === "ready").length, totals.cost, totals.tokensIn + totals.tokensOut, Math.floor((nowMs - startedAt) / 60_000)]))
    region("#usage", renderUsage(totals), JSON.stringify(totals))
    region("#audit", renderAudit(buildAudit(deps)), JSON.stringify(auditRaw))
    for (const p of list) {
      if (p.status !== "ready") continue
      const file = deps.logFileFor(p.channelId)
      const tail = file && existsSync(file) ? tailLines(redact(readFileSync(file, "utf8"), deps.secrets), 200).join("\n") : ""
      region(`#logs-${p.channelId}`, renderLogLines(tail ? tail.split("\n") : []), tail)
    }
  } catch (e) {
    deps.log?.warn?.("admin tick failed", { error: String(e) })
  }
}, deps.liveTickMs ?? 2000)
if (typeof (tick as any).unref === "function") (tick as any).unref()
```

Add the route before the `sendJson(res, 404, ...)` fallthrough:

```ts
if (parts[0] === "events" && parts.length === 1 && method === "GET") {
  sse.add(res)
  res.write(encodeFrame(snapshot()))
  return
}
```

Import `encodeFrame` alongside `createSseHub`.

In the fragment action handler from Task 7, after `sendHtml(res, 200, body)` and after the error `sendHtml`, call `broadcastAll()` so connected clients refresh immediately:

```ts
sendHtml(res, 200, body)
broadcastAll()
```

Add the same `broadcastAll()` after the successful JSON action and after JSON restart (optional; SSE clients are the same page). Add it only to the fragment action handler.

In `close()`, call `sse.closeAll()` and `clearInterval(tick)` before `server.close()`:

```ts
close() {
  clearInterval(tick)
  sse.closeAll()
  server.closeAllConnections()
  server.close()
},
```

Note: `region` uses the DOM target string as the signature key; log regions use `#logs-<id>`. On the first tick after a snapshot, signatures are empty and each region re-broadcasts once; this is harmless and keeps the logic simple.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts test/admin-ui.test.ts
git commit -m "feat(admin): stream live region updates over SSE"
```

---

### Task 10: Create and remove routes, JSON parity, and index wiring

**Files:**
- Modify: `src/admin.ts`
- Modify: `src/index.ts:470-493`
- Test: `test/admin-ui.test.ts`

**Interfaces:**
- Consumes: `deps.create`, `deps.remove`, `deps.guildIds`, `deps.log`.
- Produces:
  - `POST /partials/projects` (204)
  - `POST /partials/projects/:id/delete`
  - `POST /api/projects` (201)
  - `DELETE /api/projects/:id`
  - index wiring for `restart`, `create`, `remove`, `guildIds`, `log`

- [ ] **Step 1: Write the failing test**

Append to `test/admin-ui.test.ts`:

```ts
test("POST /partials/projects validates fields and kicks off create", async () => {
  const { svr, base, calls } = await ui()
  try {
    const form = new URLSearchParams({ name: "newproj", guildId: "g1", cloneUrl: "https://example.com/x.git", branch: "main" })
    const res = await fetch(`${base}/partials/projects`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } })
    expect(res.status).toBe(204)
    expect(calls).toEqual(["create:newproj:g1"])
    const bad = await fetch(`${base}/partials/projects`, { method: "POST", body: new URLSearchParams({ name: "x", guildId: "g1", branch: "main" }) })
    expect(bad.status).toBe(400)
    const noguild = await fetch(`${base}/partials/projects`, { method: "POST", body: new URLSearchParams({ name: "x", guildId: "nope" }) })
    expect(noguild.status).toBe(400)
  } finally { svr.close() }
})

test("create progress and completion are streamed into #notice", async () => {
  const { svr, base, getProgress } = await ui()
  try {
    const controller = new AbortController()
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    await reader.read()
    await fetch(`${base}/partials/projects`, { method: "POST", body: new URLSearchParams({ name: "newproj", guildId: "g1" }) })
    getProgress?.("creating sandbox…")
    let text = ""
    const deadline = Date.now() + 1500
    while (!text.includes("creating sandbox") && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain(`hx-target="#notice"`)
    expect(text).toContain("creating sandbox")
    controller.abort()
  } finally { svr.close() }
})

test("POST /partials/projects/:id/delete removes the project and clears the detail", async () => {
  const { svr, base, calls } = await ui()
  try {
    const res = await fetch(`${base}/partials/projects/c1/delete`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(calls).toEqual(["remove:c1"])
    const body = await res.text()
    expect(body).toContain(`hx-partial hx-target="#detail"`)
  } finally { svr.close() }
})

test("JSON create, delete, and delete 404 mirror the fragment behavior", async () => {
  const { svr, base, calls } = await ui()
  try {
    expect((await fetch(`${base}/api/projects`, { method: "POST", body: new URLSearchParams({ name: "newproj", guildId: "g1" }) })).status).toBe(201)
    expect((await fetch(`${base}/api/projects/c1`, { method: "DELETE" })).status).toBe(200)
    expect((await fetch(`${base}/api/projects/nope`, { method: "DELETE" })).status).toBe(404)
    expect(calls).toEqual(["create:newproj:g1", "remove:c1"])
  } finally { svr.close() }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: FAIL — `POST /partials/projects` returns 404.

- [ ] **Step 3: Add body parsing and the routes**

Add a helper in `src/admin.ts`:

```ts
async function readForm(req: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.byteLength
    if (size > 8192) break
    chunks.push(buf)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
}
```

Add `parseCreateInput`:

```ts
function parseCreateInput(form: URLSearchParams, deps: AdminDeps): { input: AdminCreateInput } | { error: string } {
  const name = (form.get("name") ?? "").trim()
  const guildId = (form.get("guildId") ?? "").trim()
  const cloneUrl = (form.get("cloneUrl") ?? "").trim() || undefined
  const branch = (form.get("branch") ?? "").trim() || undefined
  if (!name) return { error: "name required" }
  if (!deps.guildIds.includes(guildId)) return { error: "unknown guild" }
  if (branch && !cloneUrl) return { error: "branch requires clone" }
  return { input: { guildId, name, ...(cloneUrl ? { cloneUrl } : {}), ...(branch ? { branch } : {}) } }
}
```

Add the fragment create and delete routes before the fragment action route:

```ts
if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 2) {
  if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
  const parsed = parseCreateInput(await readForm(req), deps)
  if ("error" in parsed) return sendJson(res, 400, { error: parsed.error })
  void deps.create(parsed.input, (stage) => sse.broadcast(partial("#notice", renderNotice(stage, "info"))))
    .then(() => sse.broadcast(partial("#notice", "")))
    .catch((e) => {
      deps.log?.warn?.("admin create failed", { error: String(e) })
      sse.broadcast(partial("#notice", renderNotice(e instanceof Error ? e.message : String(e), "error")))
    })
  res.writeHead(204); res.end()
  return
}
if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 4 && parts[3] === "delete") {
  if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
  const channelId = parts[2]!
  if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
  try {
    await deps.remove(channelId)
    const nowMs = now()
    const body = renderProjects(buildProjects(deps, nowMs), nowMs) + `\n<hx-partial hx-target="#detail"></hx-partial>`
    broadcastAll()
    return sendHtml(res, 200, body)
  } catch (e) {
    deps.log?.warn?.("admin remove failed", { error: String(e) })
    sse.broadcast(partial("#notice", renderNotice(e instanceof Error ? e.message : String(e), "error")))
    return sendJson(res, 200, { ok: false })
  }
}
```

Add the JSON create and delete routes next to the existing `/api/projects` GET handler:

```ts
if (parts[0] === "api" && parts[1] === "projects" && parts.length === 2 && method === "POST") {
  const parsed = parseCreateInput(await readForm(req), deps)
  if ("error" in parsed) return sendJson(res, 400, { error: parsed.error })
  try {
    await deps.create(parsed.input)
    broadcastAll()
    return sendJson(res, 201, { ok: true, name: parsed.input.name })
  } catch (e) {
    return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}
if (parts[0] === "api" && parts[1] === "projects" && parts.length === 3 && method === "DELETE") {
  const channelId = parts[2]!
  if (!deps.db.projects.getByChannel(channelId)) return sendJson(res, 404, { error: "unknown project" })
  try {
    await deps.remove(channelId)
    broadcastAll()
    return sendJson(res, 200, { ok: true, channelId })
  } catch (e) {
    return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}
```

Import `renderNotice` from `./admin/views.ts`.

- [ ] **Step 4: Wire the new deps in `src/index.ts`**

Replace the `createAdminServer({...})` call (lines 473-488) with:

```ts
admin = await createAdminServer({
  port: cfg.adminPort,
  db,
  secrets,
  guildIds: cfg.guildIds,
  log,
  logFileFor: (channelId) => {
    const project = db.projects.getByChannel(channelId)
    return project ? join(cfg.dataDir, "logs", `${project.sandboxName}.log`) : undefined
  },
  start: async (channelId) => { await projects.start(channelId); startSubscription(channelId) },
  stop: async (channelId) => {
    await runnerSvc.resetChannel(channelId, { notify: true })
    stopSubscription(channelId)
    await projects.stop(channelId)
  },
  restart: async (channelId) => {
    stopSubscription(channelId)
    await projects.restartServer(channelId)
    startSubscription(channelId)
  },
  remove: async (channelId) => {
    await runnerSvc.resetChannel(channelId, { notify: true })
    stopSubscription(channelId)
    await projects.remove(channelId)
  },
  create: async (input, onProgress) => {
    if (input.branch && !input.cloneUrl) throw new Error("branch requires clone")
    const directory = await projects.createProjectDirectory(input.name)
    const clone = input.cloneUrl ? { url: input.cloneUrl, ...(input.branch ? { branch: input.branch } : {}) } : undefined
    await projects.addProject({ guildId: input.guildId, name: input.name, directory, ...(clone ? { clone } : {}) }, onProgress)
  },
  auditTail: (limit) => auditLog.tail(limit),
})
```

If `log` does not structurally satisfy `{ warn(message, fields?) }`, pass `log` directly only if its `warn` signature matches; otherwise pass `{ warn: (message, fields) => log.warn(message, fields) }`. Confirm with `npm run typecheck`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/admin-ui.test.ts test/admin.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin.ts src/index.ts test/admin-ui.test.ts
git commit -m "feat(admin): add project create and remove with JSON parity"
```

---

### Task 11: Detail route and copy script behavior

**Files:**
- Modify: `src/admin.ts`
- Test: `test/admin-ui.test.ts`

**Interfaces:**
- Consumes: `buildDetail`, `renderProjectCard`, `renderDetail`.
- Produces: `GET /partials/projects/:id/detail`.

- [ ] **Step 1: Write the failing test**

Append to `test/admin-ui.test.ts`:

```ts
test("GET /partials/projects/:id/detail renders logs, sessions, and marks the card selected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celly-admin-"))
  const file = join(dir, "sbx-demo.log")
  writeFileSync(file, "[out] booted\n[err] pw-secret leaked\n")
  const { svr, db, base } = await ui({ logFileFor: () => file })
  db.threads.upsert({ threadId: "t1", channelId: "c1", sessionId: "s1", title: "work", model: "m", agent: null,
    worktreePath: null, liveMessageId: null, renderState: "idle", createdAt: 1, lastActiveAt: 2 })
  try {
    const res = await fetch(`${base}/partials/projects/c1/detail`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`id="logs-c1"`)
    expect(body).toContain("thread/t1")
    expect(body).toContain("[redacted]")
    expect(body).not.toContain("pw-secret")
    expect(body).toContain(`hx-partial hx-target="#project-c1"`)
    expect(body).toContain(`aria-current="true"`)
    expect((await fetch(`${base}/partials/projects/nope/detail`)).status).toBe(404)
  } finally { svr.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("app.js exposes the copy-to-clipboard behavior", async () => {
  const { svr, base } = await ui()
  try {
    const body = await (await fetch(`${base}/assets/app.js`)).text()
    expect(body).toContain("data-copy")
    expect(body).toContain("navigator.clipboard")
  } finally { svr.close() }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-ui.test.ts`
Expected: FAIL — detail route returns 404.

- [ ] **Step 3: Add the detail route to `src/admin.ts`**

Insert before the fragment action route. Add `renderDetail` to the `./admin/views.ts` value imports in `src/admin.ts` (Task 5 removed it); `buildDetail` already returns `DetailView | undefined`, so pass it straight to `renderDetail`:

```ts
if (parts[0] === "partials" && parts[1] === "projects" && parts.length === 4 && parts[3] === "detail") {
  if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" })
  const channelId = parts[2]!
  const detail = buildDetail(deps, channelId)
  if (!detail) return sendJson(res, 404, { error: "unknown project" })
  const nowMs = now()
  const selectedCard = renderProjectCard(projectViewFor(deps.db.projects.getByChannel(channelId)!, deps, nowMs, true), nowMs)
  sendHtml(res, 200, renderDetail(detail, nowMs) + `\n<hx-partial hx-target="#project-${channelId}">${selectedCard}</hx-partial>`)
  return
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/admin-ui.test.ts test/admin.test.ts test/admin-views.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts test/admin-ui.test.ts
git commit -m "feat(admin): add the project detail fragment"
```

---

### Task 12: Wiring test, docs, changeset, and final verification

**Files:**
- Modify: `test/wiring.test.ts`
- Modify: `README.md`
- Modify: `docs-site/guides/configuration.mdx`
- Modify: `docs-site/reference/security.mdx`
- Create: `.changeset/ops-console.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation and a changeset.

- [ ] **Step 1: Extend the wiring test**

Append to `test/wiring.test.ts` (adjust the existing admin test block):

```ts
test("index wires project create, remove, and restart into the admin server", () => {
  const source = readFileSync("src/index.ts", "utf8")
  expect(source).toContain("guildIds: cfg.guildIds")
  expect(source).toContain("restart: async (channelId)")
  expect(source).toContain("remove: async (channelId)")
  expect(source).toContain("create: async (input, onProgress)")
  expect(source).toContain("projects.restartServer(channelId)")
})
```

Ensure `readFileSync` and `expect`/`test` are already imported in that file (they are used by existing tests).

- [ ] **Step 2: Run the wiring test to verify it fails, then passes**

Run: `npx vitest run test/wiring.test.ts`
Expected: PASS after Task 10 wiring; FAIL before it. If it passes immediately, the assertion text must match `src/index.ts` exactly — verify by reading the file.

- [ ] **Step 3: Update the docs**

In `README.md`, replace the admin bullet text that describes a "status page" with:

```markdown
  `127.0.0.1:4560` (`ADMIN_PORT`, `0` disables) for a loopback ops console:
  live project cards with start/stop/restart, project create/remove, usage and
  cost, the audit trail, and per-project logs and sessions. No authentication by
  design — loopback only.
```

In `docs-site/guides/configuration.mdx`, extend the admin section to list the console features and note that create/remove delete or create the corresponding Discord channel and sandbox.

In `docs-site/reference/security.mdx`, add a sentence to the admin bullet: the console can create and remove projects (removal deletes the Discord channel and the sandbox, and keeps the host directory), and it remains unauthenticated and loopback-only.

- [ ] **Step 4: Add the changeset**

Create `.changeset/ops-console.md`:

```markdown
---
"celly": minor
---

Rebuild the loopback admin page as an ops console: live project cards, usage
and cost, audit trail, per-project logs and sessions, and project create/remove,
served with vendored htmx 4 and server-sent events. The existing JSON API is
unchanged and gains restart, create, and delete routes.
```

- [ ] **Step 5: Run the full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all green. Fix any failures before committing.

- [ ] **Step 6: Commit**

```bash
git add test/wiring.test.ts README.md docs-site .changeset/ops-console.md docs/superpowers/specs/2026-09-28-ops-console-design.md
git commit -m "docs(admin): document the ops console and add a changeset"
```

---

## Self-review notes

- **Spec coverage:** assets/pipeline (Task 1), views and visual system (Tasks 2-4), page and fragments (Tasks 5-6), actions (Task 7), SSE (Tasks 8-9), create/remove + JSON parity + wiring (Task 10), detail + copy (Task 11), docs/tests/changeset (Task 12). Out-of-scope items from the spec are intentionally not tasked.
- **Data mapping:** CPU/mem/sparklines and daily rollups are absent by design; usage is cumulative; audit renders real kinds.
- **Naming consistency:** `partial()`, `region()`, `broadcastAll()`, `buildProjects`, `buildStats`, `buildAudit`, `buildDetail`, `projectViewFor`, `renderProjectCard`, `renderProjects`, `renderStats`, `renderUsage`, `renderAudit`, `renderDetail`, `renderLogLines`, `renderPage`, `readAsset`, `createSseHub`, `encodeFrame` are used with the same signatures throughout.