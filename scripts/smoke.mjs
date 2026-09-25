import { spawnSync } from "node:child_process"
const name = `cely-smoke-${Date.now()}`
const dir = process.argv[2]
if (!dir) { console.error("usage: node scripts/smoke.mjs <project-dir>"); process.exit(2) }
const run = (args) => { const r = spawnSync("sbx", args, { encoding: "utf8" }); console.log("$", args.join(" "), "=>", r.status); if (r.stdout) console.log(r.stdout); if (r.stderr) console.error(r.stderr); return r }
let failed = false
const step = (args) => { const r = run(args); if (r.status !== 0) { failed = true; console.error("smoke step failed:", args.join(" ")) } return r }
step(["create", "opencode", dir, "--name", name, "--publish", "4399:4096"])
step(["exec", name, "bash", "-lc", "opencode --version"])
const cleanup = run(["rm", "--force", name])
if (cleanup.status !== 0) failed = true
if (failed) { console.error("smoke FAILED"); process.exit(1) }
console.log("smoke OK")
