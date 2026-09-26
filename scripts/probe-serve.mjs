import { spawn } from "node:child_process"

const name = process.argv[2]
if (!name) { console.error("usage: node scripts/probe-serve.mjs <sandbox>"); process.exit(2) }

const payload = "set -a; . ~/.config/celly/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0"
console.log("spawn: sbx", ["exec", name, "bash", "-lc", payload].join(" "))

const child = spawn("sbx", ["exec", name, "bash", "-lc", payload], {
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
})

child.on("error", (e) => console.error("ERROR", e))
child.stdout.on("data", (d) => process.stdout.write("OUT " + String(d)))
child.stderr.on("data", (d) => process.stdout.write("ERR " + String(d)))
child.on("exit", (code, signal) => console.log("EXIT", code, signal))

setTimeout(() => { console.log("-- killing probe after 10s --"); child.kill(); process.exit(0) }, 10_000)
