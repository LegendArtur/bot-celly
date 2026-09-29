export type CliCommand = "run" | "setup" | "doctor" | "version" | "help"

export interface CliOptions {
  command: CliCommand
  run: boolean
  token?: string
  guilds?: string
  home?: string
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; message: string }

const COMMANDS = new Set<CliCommand>(["setup", "doctor", "help", "version"])
type ValueFlag = "token" | "guilds" | "home"
const VALUE_FLAGS = new Map<string, ValueFlag>([
  ["--token", "token"],
  ["--guilds", "guilds"],
  ["--home", "home"],
])

export function parseArgs(argv: string[]): ParseResult {
  const options: CliOptions = { command: "run", run: false }
  let commandSeen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--help" || arg === "-h") return { ok: true, options: { ...options, command: "help" } }
    if (arg === "--version" || arg === "-v") return { ok: true, options: { ...options, command: "version" } }
    if (arg === "--run") { options.run = true; continue }
    const flag = VALUE_FLAGS.get(arg)
    if (flag) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) return { ok: false, message: `${arg} requires a value` }
      options[flag] = value
      i++
      continue
    }
    if (arg.startsWith("-")) return { ok: false, message: `unknown flag: ${arg}` }
    if (commandSeen) return { ok: false, message: `unexpected argument: ${arg}` }
    if (!COMMANDS.has(arg as CliCommand)) return { ok: false, message: `unknown command: ${arg}` }
    options.command = arg as CliCommand
    commandSeen = true
  }
  return { ok: true, options }
}
