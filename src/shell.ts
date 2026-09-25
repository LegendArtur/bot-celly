import type { Sbx } from "./sbx.ts"
import type { Project } from "./types.ts"
import { chunkMessage } from "./render.js"
export async function runShell(deps: { sbx: Sbx; project: Project }, command: string): Promise<string[]> {
  const r = await deps.sbx.exec(deps.project.sandboxName, ["bash", "-lc", command], { timeoutMs: 120_000 })
  const output = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")) || `(exit ${r.code})`
  const chunks = chunkMessage(output, 1900)
  if (chunks.length <= 3) return chunks
  return [...chunks.slice(0, 3), `[output truncated: ${output.length} bytes total]`]
}
