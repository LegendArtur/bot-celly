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
