// Host-only probe that mirrors the bot's supervised serve spawn.
//
// Build first so dist/opencode.js exists: `npm run build`
// Then: `node scripts/probe-serve.mjs <sandbox>`
import { spawn } from "node:child_process"
import { buildServeArgs } from "../dist/opencode.js"

const name = process.argv[2]
if (!name) { console.error("usage: node scripts/probe-serve.mjs <sandbox>"); process.exit(2) }

const args = ["exec", name, ...buildServeArgs()]
console.log("spawn: sbx", args.join(" "))

const child = spawn("sbx", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
child.on("error", (e) => console.error("ERROR", e))
child.stdout.on("data", (d) => process.stdout.write("OUT " + String(d)))
child.stderr.on("data", (d) => process.stdout.write("ERR " + String(d)))
child.on("exit", (code, signal) => console.log("EXIT", code, signal))

setTimeout(() => { console.log("-- killing probe after 10s --"); child.kill(); process.exit(0) }, 10_000)
