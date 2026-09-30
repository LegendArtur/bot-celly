import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function resolveCellyHome(env: NodeJS.ProcessEnv = process.env, home: () => string = homedir): string {
  const override = env.CELLY_HOME?.trim()
  return override && override.length > 0 ? override : join(home(), ".bot-celly")
}

export interface ApplyHomeDeps {
  env: NodeJS.ProcessEnv
  resolveHome?: (env: NodeJS.ProcessEnv) => string
  loadEnvFile?: (path: string) => void
  mkdir?: (path: string, options: { recursive: true; mode: number }) => void
}

export interface ApplyHomeResult {
  home: string
  envFile: string
  dataDir: string
  envFileLoaded: boolean
}

export function applyHome(deps: ApplyHomeDeps): ApplyHomeResult {
  const env = deps.env
  const resolveHome = deps.resolveHome ?? resolveCellyHome
  const mkdir = deps.mkdir ?? ((path, options) => { mkdirSync(path, options) })
  const loadEnvFile = deps.loadEnvFile ?? ((path) => { process.loadEnvFile?.(path) })

  const home = resolveHome(env)
  mkdir(home, { recursive: true, mode: 0o700 })
  const envFile = join(home, ".env")
  env.CELLY_ENV_FILE = envFile
  let envFileLoaded = false
  try { loadEnvFile(envFile); envFileLoaded = true } catch { envFileLoaded = false }
  if (!env.DATA_DIR?.trim()) env.DATA_DIR = join(home, "data")
  return { home, envFile, dataDir: env.DATA_DIR!, envFileLoaded }
}
