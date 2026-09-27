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
