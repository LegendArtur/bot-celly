import { spawnSync, spawn } from "node:child_process"
const sh = (args, opts = {}) => {
  const r = spawnSync("sbx", args, { encoding: "utf8", ...opts })
  console.log("$ sbx", args.join(" "), "=>", r.status)
  console.log(r.stdout || "", r.stderr || "")
  return r
}
const name = "cely-spike"
sh(["rm", "--force", name])
sh(["create", "opencode", ".", "--name", name, "--publish", "4399:4096"])
sh(["ls", "--json"])
sh(["ports", name, "--json"])
const child = spawn("sbx", ["exec", name, "bash", "-lc",
  "exec opencode serve --port 4096 --hostname 0.0.0.0"], { stdio: ["ignore", "pipe", "pipe"] })
child.stdout.on("data", (d) => process.stdout.write(d))
child.stderr.on("data", (d) => process.stderr.write(d))
setTimeout(async () => {
  try {
    const res = await fetch("http://127.0.0.1:4399/global/health")
    console.log("HEALTH", res.status, await res.text())
  } catch (e) { console.log("HEALTH ERR", e.message) }
  child.kill()
}, 8000)
