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
}

const GUILD_RE = /^\d{17,20}$/

const defaultWriteFile = (path: string, data: string, options: { mode: number }): void => {
  writeFileSync(path, data, options)
  try { chmodSync(path, options.mode) } catch {}
}

export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : []
  const seen = new Set<string>()
  const out = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line)
    const key = match?.[1]
    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key)
      return `${key}=${updates[key]}`
    }
    return line
  })
  const missing = Object.keys(updates).filter((key) => !seen.has(key))
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("")
    for (const key of missing) out.push(`${key}=${updates[key]}`)
  }
  return out.join("\n").replace(/\n*$/, "\n")
}

export async function runWizard(deps: WizardDeps): Promise<WizardResult> {
  const { env, ui, prompter } = deps
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const writeFile = deps.writeFile ?? defaultWriteFile

  ui.heading("Celly setup")
  ui.rule()
  ui.bullet(`Saves your Discord token and guild IDs to ${deps.envFile} (mode 600).`)
  ui.bullet("Everything else has a sensible default.")

  let token = ""
  while (token.length === 0) {
    token = (await prompter.askSecret("Discord bot token: ")).trim()
    if (token.length === 0) ui.status("warn", "A token is required.")
  }

  let guilds: string[] = []
  for (;;) {
    const raw = (await prompter.ask("Discord guild IDs (comma-separated): ")).trim()
    let parsed: string[] | undefined
    try { parsed = parseGuildIds({ DISCORD_GUILD_IDS: raw }) } catch { parsed = undefined }
    const invalid = (parsed ?? []).filter((id) => !GUILD_RE.test(id))
    if (parsed && parsed.length > 0 && invalid.length === 0) { guilds = parsed; break }
    ui.status("warn", invalid.length > 0 ? `Not a guild ID: ${invalid.join(", ")}` : "Enter at least one guild ID.")
  }
  prompter.close()

  loadConfig({ ...env, DISCORD_TOKEN: token, DISCORD_GUILD_IDS: guilds.join(",") })

  let existing = ""
  try { existing = readFile(deps.envFile) } catch { existing = "" }
  writeFile(deps.envFile, mergeEnv(existing, { DISCORD_TOKEN: token, DISCORD_GUILD_IDS: guilds.join(",") }), { mode: 0o600 })

  env.DISCORD_TOKEN = token
  env.DISCORD_GUILD_IDS = guilds.join(",")
  ui.status("ok", `Saved config to ${deps.envFile}`)
  return { token, guilds }
}

export function createPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  const rl = createInterface({ input, output })
  return {
    ask: (question) => rl.question(question),
    askSecret: async (question) => {
      const stdin = input as NodeJS.ReadStream
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        output.write("(this terminal cannot hide input; the token will be visible)\n")
        return rl.question(question)
      }
      return new Promise<string>((resolve) => {
        rl.pause()
        output.write(question)
        let value = ""
        const wasRaw = Boolean(stdin.isRaw)
        emitKeypressEvents(stdin)
        stdin.setRawMode(true)
        stdin.resume()
        const cleanup = (): void => {
          stdin.removeListener("keypress", onKeypress)
          stdin.setRawMode(wasRaw)
          rl.resume()
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
    close: () => rl.close(),
  }
}
