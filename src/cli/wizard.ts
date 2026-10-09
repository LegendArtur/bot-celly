import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { emitKeypressEvents } from "node:readline"
import { createInterface } from "node:readline/promises"
import { loadConfig, parseGuildIds } from "../config.js"
import type { Ui } from "./ui.js"

export interface Prompter {
  ask(question: string): Promise<string>
  askSecret(question: string): Promise<string>
  close(): void
}

export interface WizardDeps {
  env: NodeJS.ProcessEnv
  envFile: string
  ui: Ui
  prompter: Prompter
  readFile?: (path: string) => string
  writeFile?: (path: string, data: string, options: { mode: number }) => void
}

export interface WizardResult {
  token: string
  guilds: string[]
  githubToken?: string
}

const GUILD_RE = /^\d{17,20}$/

const defaultWriteFile = (path: string, data: string, options: { mode: number }): void => {
  writeFileSync(path, data, options)
  try { chmodSync(path, options.mode) } catch {}
}

export function mergeEnv(existing: string, updates: Record<string, string>, remove: string[] = []): string {
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : []
  const removed = new Set(remove)
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=/.exec(line)
    const key = match?.[1]
    if (key && removed.has(key)) continue
    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key)
      out.push(`${key}=${updates[key]}`)
      continue
    }
    out.push(line)
  }
  const missing = Object.keys(updates).filter((key) => !seen.has(key))
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("")
    for (const key of missing) out.push(`${key}=${updates[key]}`)
  }
  return out.join("\n").replace(/\n*$/, "\n")
}

export interface EnvFileDeps {
  envFile: string
  readFile?: (path: string) => string
  writeFile?: (path: string, data: string, options: { mode: number }) => void
}

/** Merge updates (and removals) into the env file, creating it with mode 0600. */
export function persistEnvUpdates(deps: EnvFileDeps, updates: Record<string, string>, remove: string[] = []): void {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const writeFile = deps.writeFile ?? defaultWriteFile
  let existing = ""
  try { existing = readFile(deps.envFile) } catch { existing = "" }
  writeFile(deps.envFile, mergeEnv(existing, updates, remove), { mode: 0o600 })
}

export async function runWizard(deps: WizardDeps): Promise<WizardResult> {
  const { env, ui, prompter } = deps
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const writeFile = deps.writeFile ?? defaultWriteFile

  ui.heading("Celly setup")
  ui.rule()
  ui.bullet(`Saves your Discord token and guild IDs to ${deps.envFile} (mode 600).`)
  ui.bullet("Everything else has a sensible default.")

  const existingToken = env.DISCORD_TOKEN?.trim()
  let token = existingToken ?? ""
  if (token.length > 0) {
    const entered = (await prompter.askSecret("Discord bot token (Enter to keep the current one): ")).trim()
    if (entered.length > 0) token = entered
  } else {
    while (token.length === 0) {
      token = (await prompter.askSecret("Discord bot token: ")).trim()
      if (token.length === 0) ui.status("warn", "A token is required.")
    }
  }

  let existingGuilds: string[] = []
  try { existingGuilds = parseGuildIds(env) ?? [] } catch { existingGuilds = [] }
  let guilds: string[] = []
  for (;;) {
    const suffix = existingGuilds.length > 0 ? ` [${existingGuilds.join(",")}]` : ""
    const raw = (await prompter.ask(`Discord guild IDs (comma-separated)${suffix}: `)).trim()
    if (raw === "" && existingGuilds.length > 0) { guilds = existingGuilds; break }
    let parsed: string[] | undefined
    try { parsed = parseGuildIds({ DISCORD_GUILD_IDS: raw }) } catch { parsed = undefined }
    const invalid = (parsed ?? []).filter((id) => !GUILD_RE.test(id))
    if (parsed && parsed.length > 0 && invalid.length === 0) { guilds = parsed; break }
    ui.status("warn", invalid.length > 0 ? `Not a guild ID: ${invalid.join(", ")}` : "Enter at least one guild ID.")
  }

  // Optional: a shared GitHub token shipped into every sandbox so the agent can
  // clone/fetch/push private repos. Entered hidden, stored 0600 in the env file.
  const existingGithub = env.GITHUB_TOKEN?.trim()
  let githubToken: string | undefined
  let removeGithub = false
  if (existingGithub) {
    const choice = (await prompter.ask("GitHub token — keep, update, or remove? (k/u/r) [k]: ")).trim().toLowerCase()
    if (choice === "u" || choice === "update") {
      const entered = (await prompter.askSecret("GitHub token (github.com, repo scope): ")).trim()
      if (entered.length > 0) githubToken = entered
      else { ui.status("warn", "No token entered; keeping the current one."); githubToken = existingGithub }
    } else if (choice === "r" || choice === "remove") {
      removeGithub = true
    } else {
      githubToken = existingGithub
    }
  } else {
    const wantsGithub = (await prompter.ask("Add a GitHub token so the agent can clone/push private repos? (y/N) ")).trim().toLowerCase()
    if (wantsGithub === "y" || wantsGithub === "yes") {
      const entered = (await prompter.askSecret("GitHub token (github.com, repo scope): ")).trim()
      if (entered.length > 0) githubToken = entered
      else ui.status("warn", "No token entered; skipping GitHub.")
    }
  }
  prompter.close()

  const updates: Record<string, string> = { DISCORD_TOKEN: token, DISCORD_GUILD_IDS: guilds.join(",") }
  if (githubToken && !removeGithub) updates.GITHUB_TOKEN = githubToken
  const remove = removeGithub ? ["GITHUB_TOKEN", "GH_TOKEN"] : []
  loadConfig({ ...env, ...updates })

  persistEnvUpdates({ envFile: deps.envFile, readFile, writeFile }, updates, remove)
  env.DISCORD_TOKEN = token
  env.DISCORD_GUILD_IDS = guilds.join(",")
  if (githubToken && !removeGithub) env.GITHUB_TOKEN = githubToken
  if (removeGithub) { delete env.GITHUB_TOKEN; delete env.GH_TOKEN }
  ui.status("ok", `Saved config to ${deps.envFile}`)
  return { token, guilds, ...(githubToken && !removeGithub ? { githubToken } : {}) }
}

export function createPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  const askVisible = async (question: string): Promise<string> => {
    const rl = createInterface({ input, output })
    try { return await rl.question(question) } finally { rl.close() }
  }
  return {
    ask: askVisible,
    askSecret: async (question) => {
      const stdin = input as NodeJS.ReadStream
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        output.write("(this terminal cannot hide input; the token will be visible)\n")
        return askVisible(question)
      }
      // No readline interface is attached during this read: readline echoes every
      // keypress it sees, which would print the secret. Read raw keypresses only.
      return new Promise<string>((resolve) => {
        output.write(question)
        let value = ""
        const wasRaw = Boolean(stdin.isRaw)
        emitKeypressEvents(stdin)
        stdin.setRawMode(true)
        stdin.resume()
        const cleanup = (): void => {
          stdin.removeListener("keypress", onKeypress)
          stdin.setRawMode(wasRaw)
        }
        const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }): void => {
          if (key.name === "return" || key.name === "enter") { cleanup(); output.write("\n"); resolve(value) }
          else if (key.ctrl && key.name === "c") { cleanup(); output.write("\n"); process.exit(130) }
          else if (key.name === "backspace") { if (value.length > 0) { value = value.slice(0, -1); output.write("\b \b") } }
          else if (str && !key.ctrl) { value += str }
        }
        stdin.on("keypress", onKeypress)
      })
    },
    close: () => {},
  }
}
