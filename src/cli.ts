#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "./cli/args.js"
import { applyHome } from "./cli/home.js"
import type { ApplyHomeResult } from "./cli/home.js"
import { createUi } from "./cli/ui.js"
import type { Ui } from "./cli/ui.js"
import { createPrompter, runWizard } from "./cli/wizard.js"
import type { Prompter } from "./cli/wizard.js"
import { hasHardFailure, reportDoctor, runDoctor } from "./cli/doctor.js"
import { SbxRunner } from "./sbx.js"
import type { RunResult } from "./sbx.js"

const HELP = `Celly — a Discord control surface for OpenCode

Usage: bot-celly [command] [flags]

Commands:
  (none)      Set up on first run, then start the bot
  run         Start the bot (same as passing no command)
  setup       Re-run the setup wizard
  doctor      Check host prerequisites and configuration
  --version   Print the version
  --help      Show this help

Flags:
  --token <value>    Discord bot token (headless)
  --guilds <a,b,c>   Comma-separated guild IDs (headless)
  --home <dir>       Config and data directory (default ~/.bot-celly)
  --run              With setup, start the bot after setup`

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
  return pkg.version
}

function configPresent(env: NodeJS.ProcessEnv): boolean {
  const token = env.DISCORD_TOKEN?.trim()
  const guilds = env.DISCORD_GUILD_IDS?.trim() || env.DISCORD_GUILD_ID?.trim()
  return Boolean(token) && Boolean(guilds)
}

export interface RunCliDeps {
  argv: string[]
  env: NodeJS.ProcessEnv
  isTTY: boolean
  ui: Ui
  applyHome?: (deps: { env: NodeJS.ProcessEnv }) => ApplyHomeResult
  makePrompter?: () => Prompter
  runSbx?: (args: string[]) => Promise<RunResult>
  main?: () => Promise<void>
}

export async function runCli(deps: RunCliDeps): Promise<number> {
  const { argv, env, isTTY, ui } = deps
  const appliedHome = deps.applyHome ?? applyHome
  const makePrompter = deps.makePrompter ?? (() => createPrompter(process.stdin, process.stdout))
  const runSbx = deps.runSbx ?? ((args: string[]) => new SbxRunner().run(args))
  const main = deps.main ?? (async () => { const { main } = await import("./index.js"); await main() })

  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    ui.status("fail", parsed.message)
    console.error(`\n${HELP}`)
    return 2
  }
  const { options } = parsed
  if (options.command === "version") { console.log(version()); return 0 }
  if (options.command === "help") { console.log(HELP); return 0 }

  if (options.token !== undefined) env.DISCORD_TOKEN = options.token
  if (options.guilds !== undefined) env.DISCORD_GUILD_IDS = options.guilds
  if (options.home !== undefined) env.CELLY_HOME = options.home

  const applied = appliedHome({ env })

  const configOk = configPresent(env)
  const wantsWizard = options.command === "setup" || (options.command !== "doctor" && !configOk)
  if (wantsWizard) {
    if (!isTTY) {
      if (configOk) {
        ui.status("warn", "No TTY available; keeping the existing configuration.")
      } else {
        ui.status("fail", "No config found and stdin is not a TTY.")
        ui.hint(`Pass --token and --guilds, or write ${applied.envFile} yourself.`)
        return 1
      }
    } else {
      const prompter = makePrompter()
      await runWizard({ env, envFile: applied.envFile, ui, prompter })
    }
  }

  const results = await runDoctor({ env, home: applied.home, dataDir: applied.dataDir, runSbx })
  reportDoctor(results, ui)

  if (options.command === "doctor") return hasHardFailure(results) ? 1 : 0
  if (hasHardFailure(results)) {
    ui.status("fail", "Fix the items above, then run `bot-celly` again.")
    return 1
  }
  if (options.command === "setup" && !options.run) {
    ui.status("ok", "Setup complete. Run `bot-celly` to start.")
    return 0
  }
  await main()
  return 0
}

async function run(): Promise<void> {
  const code = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY),
    ui: createUi(),
    makePrompter: () => createPrompter(process.stdin, process.stdout),
  })
  if (code !== 0) process.exit(code)
}

function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  run().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
}
