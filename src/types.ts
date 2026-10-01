export type ProjectStatus = "provisioning" | "ready" | "degraded"
export interface Project {
  channelId: string; guildId: string; name: string
  directory: string; sandboxPath: string | null
  sandboxName: string; hostPort: number; serverPassword: string
  status: ProjectStatus; createdAt: number; lastActiveAt: number
}
export interface UsageTotals {
  cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number
}
export type RenderState = "idle" | "running" | "aborting" | "errored"
export interface Thread {
  threadId: string; channelId: string; sessionId: string
  title: string | null; model: string | null; agent: string | null; variant: string | null
  worktreePath: string | null; liveMessageId: string | null
  originMessageId?: string | null; archiveNoticeAt?: number | null
  renderState: RenderState; createdAt: number; lastActiveAt: number
}
export interface ScheduledTask {
  id: number; channelId: string; prompt: string; everyMinutes: number
  nextRunAt: number; enabled: boolean; createdAt: number
}
