import { spawnSync } from "node:child_process"
const name = `cely-smoke-${Date.now()}`
const dir = process.argv[2]
if (!dir) { console.error("usage: node scripts/smoke.mjs <project-dir>"); process.exit(2) }
const run = (args) => { const r = spawnSync("sbx", args, { encoding: "utf8" }); console.log("$", args.join(" "), "=>", r.status); if (r.stdout) console.log(r.stdout); if (r.stderr) console.error(r.stderr); return r }
run(["create", "opencode", dir, "--name", name, "--publish", "4399:4096"])
run(["exec", name, "bash", "-lc", "opencode --version"])
run(["rm", "--force", name])
console.log("smoke OK")
