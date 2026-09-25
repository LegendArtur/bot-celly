// Host-only §15 full-chain smoke: create -> bootstrap -> serve -> health ->
// create session -> prompt "say hi" -> abort -> stop -> remove.
//
// argv-only: every `sbx` call is spawn("sbx", [...args]) with shell:false, and
// the bootstrap command is a single argv element for `bash -lc`. Run on the
// Windows host with sbx logged in:
//
//   node scripts/smoke.mjs C:\path\to\a\project\dir [hostPort]
//
// Any failed step prints the failure and the process exits 1.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = process.argv[2]
if (!dir) { console.error("usage: node scripts/smoke.mjs <project-dir> [hostPort]"); process.exit(2) }

const name = `celly-smoke-${Date.now()}`
const hostPort = Number(process.argv[3] ?? 4399)
const password = randomBytes(16).toString("hex")
const baseUrl = `http://127.0.0.1:${hostPort}`
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

const CELLY_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "permission": {
    "*": "allow",
    "bash": { "*": "allow", "git push*": "deny", "npm publish*": "deny", "pnpm publish*": "deny", "yarn publish*": "deny" },
    "external_directory": "deny",
    "question": "deny"
  }
}
`
const CELLY_ENV = `OPENCODE_SERVER_PASSWORD=${password}\nOPENCODE_CONFIG=$HOME/.config/celly/opencode.json\n`
const BOOTSTRAP = "set -e; mkdir -p $HOME/.config/celly; mv /tmp/celly-opencode.json $HOME/.config/celly/opencode.json; mv /tmp/celly-opencode.env $HOME/.config/celly/opencode.env; chmod 600 $HOME/.config/celly/opencode.env"
const VERIFY = "test -s $HOME/.config/celly/opencode.json && test -s $HOME/.config/celly/opencode.env && grep -q OPENCODE_SERVER_PASSWORD $HOME/.config/celly/opencode.env"
const SERVE = "set -a; . ~/.config/celly/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0"

let server
let failed = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fail = (message) => { failed = true; console.error("smoke step failed:", message) }

const run = (args) => {
  const r = spawnSync("sbx", args, { encoding: "utf8", shell: false })
  console.log("$ sbx", args.join(" "), "=>", r.status)
  if (r.stdout) console.log(r.stdout)
  if (r.stderr) console.error(r.stderr)
  return r
}
const step = (label, args) => {
  const r = run(args)
  if (r.status !== 0) fail(`${label}: sbx ${args[0]} exited ${r.status}`)
  return r
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: auth, "content-type": "application/json", ...(options.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} -> HTTP ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}
const sessionIdOf = (body) => body?.id ?? body?.data?.id ?? body?.info?.id

async function waitForHealth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    try {
      const body = await request("/global/health")
      if (body?.healthy) return
      last = JSON.stringify(body)
    } catch (e) { last = e.message }
    await sleep(500)
  }
  throw new Error(`health never passed: ${last}`)
}

async function waitForReply(sessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await request(`/session/${sessionId}/message`)
    const list = Array.isArray(messages) ? messages : messages?.data ?? []
    for (const m of list) {
      if (m?.info?.role === "assistant" && (m.parts ?? []).some((p) => p?.type === "text" && p.text)) return
    }
    await sleep(500)
  }
  throw new Error("no assistant reply arrived")
}

const teardown = () => {
  try { server?.kill() } catch {}
  run(["rm", "--force", name])
}

async function main() {
  const stage = mkdtempSync(join(tmpdir(), "celly-smoke-"))
  writeFileSync(join(stage, "opencode.json"), CELLY_CONFIG)
  writeFileSync(join(stage, "opencode.env"), CELLY_ENV)
  try {
    step("create", ["create", "opencode", dir, "--name", name, "--publish", `${hostPort}:4096`])
    step("copy config", ["cp", join(stage, "opencode.json"), `${name}:/tmp/celly-opencode.json`])
    step("copy env", ["cp", join(stage, "opencode.env"), `${name}:/tmp/celly-opencode.env`])
    step("bootstrap", ["exec", name, "bash", "-lc", BOOTSTRAP])
    step("verify bootstrap", ["exec", name, "bash", "-lc", VERIFY])

    server = spawn("sbx", ["exec", name, "bash", "-lc", SERVE], { stdio: ["ignore", "pipe", "pipe"], shell: false })
    server.stdout.on("data", (d) => process.stdout.write(d))
    server.stderr.on("data", (d) => process.stderr.write(d))

    await waitForHealth()
    console.log("health OK")

    const created = await request("/session", { method: "POST", body: JSON.stringify({ title: "smoke" }) })
    const sessionId = sessionIdOf(created)
    if (!sessionId) throw new Error("session.create returned no id")
    console.log("session", sessionId)

    await request(`/session/${sessionId}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "say hi" }] }) })
    await waitForReply(sessionId)
    console.log("reply OK")

    await request(`/session/${sessionId}/abort`, { method: "POST" })
    console.log("abort OK")
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }

  step("stop", ["stop", name])
  step("remove", ["rm", "--force", name])
}

main().catch((e) => { fail(e.message) }).finally(() => {
  if (failed) { teardown(); console.error("smoke FAILED"); process.exit(1) }
  teardown()
  console.log("smoke OK")
})
