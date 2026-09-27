import { existsSync, renameSync, rmSync, statSync } from "node:fs"

export interface RotateOptions {
  maxBytes: number
  maxFiles: number
  now?: () => number
}

export function rotateIfNeeded(file: string, opts: RotateOptions): boolean {
  if (!existsSync(file)) return false
  if (statSync(file).size < opts.maxBytes) return false
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles))
  for (let i = maxFiles; i >= 1; i--) {
    const target = `${file}.${i}`
    const source = i === 1 ? file : `${file}.${i - 1}`
    if (existsSync(target)) rmSync(target, { force: true })
    if (existsSync(source)) renameSync(source, target)
  }
  return true
}
