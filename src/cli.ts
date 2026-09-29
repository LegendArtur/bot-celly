#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { parseArgs } from "./cli/args.js"
import { applyHome } from "./cli/home.js"
import { createUi } from "./cli/ui.js"
import { createPrompter, runWizard } from "./cli/wizard.js"
import { hasHardFailure, reportDoctor, runDoctor } from "./cli/doctor.js"
import { SbxRunner } from "./sbx.js"

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

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const ui = createUi()
  if (!parsed.ok) {
    ui.status("fail", parsed.message)
    console.error(`\n${HELP}`)
    process.exit(2)
  }
  const { options } = parsed
  if (options.command === "version") { console.log(version()); return }
  if (options.command === "help") { console.log(HELP); return }

  if (options.token !== undefined) process.env.DISCORD_TOKEN = options.token
  if (options.guilds !== undefined) process.env.DISCORD_GUILD_IDS = options.guilds
  if (options.home !== undefined) process.env.CELLY_HOME = options.home

  const applied = applyHome({ env: process.env })

  const configOk = configPresent(process.env)
  const wantsWizard = options.command === "setup" || (options.command !== "doctor" && !configOk)
  if (wantsWizard) {
    if (!process.stdin.isTTY) {
      if (configOk) {
        ui.status("warn", "No TTY available; keeping the existing configuration.")
      } else {
        ui.status("fail", "No config found and stdin is not a TTY.")
        ui.hint(`Pass --token and --guilds, or write ${applied.envFile} yourself.`)
        process.exit(1)
      }
    } else {
      const prompter = createPrompter(process.stdin, process.stdout)
      await runWizard({ env: process.env, envFile: applied.envFile, ui, prompter })
    }
  }

  const runner = new SbxRunner()
  const results = await runDoctor({
    env: process.env,
    home: applied.home,
    dataDir: applied.dataDir,
    runSbx: (args) => runner.run(args),
  })
  reportDoctor(results, ui)

  if (options.command === "doctor") process.exit(hasHardFailure(results) ? 1 : 0)
  if (hasHardFailure(results)) {
    ui.status("fail", "Fix the items above, then run `bot-celly` again.")
    process.exit(1)
  }
  if (options.command === "setup" && !options.run) {
    ui.status("ok", "Setup complete. Run `bot-celly` to start.")
    return
  }
  const { main } = await import("./index.js")
  await main()
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
