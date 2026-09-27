import type { UsageTotals } from "./types.ts"

function scaled(value: number): number {
  return Math.round(value * 10) / 10
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) {
    const m = scaled(n / 1_000_000)
    if (m < 1000) return `${m}M`
  }
  if (n >= 1000) {
    const k = scaled(n / 1000)
    if (k < 1000) return `${k}k`
  }
  return String(Math.round(n))
}

export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return "$0.0000"
  return "$" + (Math.round(n * 10_000) / 10_000).toFixed(4)
}

export function formatUsageFooter(t: UsageTotals): string {
  return `${formatCost(t.cost)} · ${formatTokens(t.tokensIn)} in / ${formatTokens(t.tokensOut)} out`
}

export function formatUsageSummary(label: string, t: UsageTotals): string {
  return `${label}: ${formatUsageFooter(t)}`
}

export function resolveBudget(
  settings: { get(key: string): string | undefined },
  channelId: string,
  envBudget: number,
): number {
  const raw = settings.get(`budget_usd:${channelId}`)
  if (raw !== undefined) {
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return envBudget
}
