export type ProjectStatus = "provisioning" | "ready" | "degraded"
export interface Project {
  channelId: string; guildId: string; name: string
  directory: string; sandboxPath: string | null
  sandboxName: string; hostPort: number; serverPassword: string
  status: ProjectStatus; createdAt: number
}
export type RenderState = "idle" | "running" | "aborting" | "errored"
export interface Thread {
  threadId: string; channelId: string; sessionId: string
  title: string | null; model: string | null; agent: string | null
  worktreePath: string | null; liveMessageId: string | null
  renderState: RenderState; createdAt: number; lastActiveAt: number
}
