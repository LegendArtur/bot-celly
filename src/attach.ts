// src/attach.ts
import type { CreateThreadInput } from "./commands.ts"
import type { Project } from "./types.ts"

export const ATTACH_URL = "http://127.0.0.1:4096"

/**
 * Spec §4.1: the exact terminal attach line for a project's sandbox and
 * session. The server password stays inside the sandbox env file, so this
 * command contains no secret.
 */
export function attachCommand(project: Pick<Project, "sandboxName">, sessionId: string): string {
  return `sbx exec -it ${project.sandboxName} bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach ${ATTACH_URL} -s ${sessionId}'`
}

export function sessionIdReply(project: Pick<Project, "sandboxName">, sessionId: string): string {
  return `\`${sessionId}\`\n||${attachCommand(project, sessionId)}||`
}

export function attachReply(project: Pick<Project, "sandboxName">, sessionId: string): string {
  return ["```", attachCommand(project, sessionId), "```"].join("\n")
}

export interface AutoThreadDeps {
  enabled: boolean
  sessionTitle(project: Project, sessionId: string): Promise<string | undefined>
  createThread(input: CreateThreadInput): Promise<{ threadId: string }>
  log: { warn(message: string, fields?: Record<string, unknown>): void }
}

/**
 * Spec §4.1: when ATTACH_AUTO_THREAD is on, an event for a session with no
 * Discord thread creates one first. Returns the new thread id, or undefined
 * (drop the event) when disabled, when the title lookup fails, or when thread
 * creation fails.
 */
export function createAutoThreadResolver(deps: AutoThreadDeps): (project: Project, sessionId: string) => Promise<string | undefined> {
  return async (project, sessionId) => {
    if (!deps.enabled) return undefined
    let title: string | undefined
    try {
      title = await deps.sessionTitle(project, sessionId)
    } catch (e) {
      deps.log.warn("auto-thread session lookup failed", { sessionId, error: String(e) })
      return undefined
    }
    try {
      const created = await deps.createThread({ channelId: project.channelId, title: title?.trim() || `session ${sessionId}`, sessionId })
      return created.threadId
    } catch (e) {
      deps.log.warn("auto-thread creation failed", { sessionId, error: String(e) })
      return undefined
    }
  }
}
