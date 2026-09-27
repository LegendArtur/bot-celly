// src/attach.ts
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
