export const APPROVAL_MODES = ["auto", "buttons", "plan"] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]
