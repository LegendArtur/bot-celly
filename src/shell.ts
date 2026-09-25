import type { Sbx } from "./sbx.ts"
import type { Project } from "./types.ts"
import { chunkMessage } from "./render.js"

export function openFenceLength(text: string): number {
  let open = 0
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,})(.*)$/.exec(line)
    if (!m) continue
    const run = (m[1] ?? "").length
    if (open === 0) open = run
    else if (run >= open && (m[2] ?? "").trim() === "") open = 0
  }
  return open
}

export async function runShell(deps: { sbx: Sbx; project: Project }, command: string): Promise<string[]> {
  const r = await deps.sbx.exec(deps.project.sandboxName, ["bash", "-lc", command], { timeoutMs: 120_000 })
  const body = r.stdout + (r.stderr ? `\n${r.stderr}` : "")
  const output = body === "" ? `(exit ${r.code})` : body + (r.code !== 0 ? `\nexit ${r.code}` : "")
  const chunks = chunkMessage(output, 1900)
  if (chunks.length <= 3) return chunks
  const head = chunks.slice(0, 3)
  const open = openFenceLength(head.join("\n"))
  if (open > 0) head[2] = `${head[2]}\n${"`".repeat(open)}`
  return [...head, `[output truncated: ${output.length} chars total, exit ${r.code}]`]
}
