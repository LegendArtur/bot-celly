// Host-only full-chain smoke: create -> bootstrap -> serve -> health ->
// create session -> prompt "say hi" -> abort -> stop -> remove.
//
// argv-only: every `sbx` call is spawn/spawnSync("sbx", [...args]) with
// shell:false; the bootstrap script is delivered on stdin to `sbx exec -i`,
// never via a host temp file or `sbx cp`.
//
// Build first so dist/opencode.js exists:
//   npm run build
// Then, on the host with sbx logged in:
//   node scripts/smoke.mjs <project-dir> [hostPort]
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { BOOTSTRAP_PREPARE, bootstrapVerify, buildBootstrapInstallScript, buildServeArgs } from "../dist/opencode.js"

const dir = process.argv[2]
if (!dir) { console.error("usage: node scripts/smoke.mjs <project-dir> [hostPort]"); process.exit(2) }
const name = `celly-smoke-${Date.now()}`
const hostPort = Number(process.argv[3] ?? 4399)
const password = randomBytes(16).toString("hex")
const baseUrl = `http://127.0.0.1:${hostPort}`
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

let server
let failed = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (message) => { failed = true; console.error("smoke step failed:", message) }

const run = (args, input) => {
  const r = spawnSync("sbx", args, { encoding: "utf8", shell: false, input })
  console.log("$ sbx", args.join(" "), "=>", r.status)
  if (r.stdout) console.log(r.stdout)
  if (r.stderr) console.error(r.stderr)
  return r
}
const step = (label, args, input) => {
  const r = run(args, input)
  if (r.status !== 0) {
    fail(`${label}: sbx ${args[0]} exited ${r.status}`)
    throw new Error(`${label} failed`)
  }
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

let removed = false
const removeSandbox = () => {
  if (removed) return
  removed = true
  step("remove", ["rm", "--force", name])
}

const teardown = () => {
  try { server?.kill() } catch {}
  try { removeSandbox() } catch {}
}

async function main() {
  step("create", ["create", "opencode", dir, "--name", name, "--publish", `${hostPort}:4096`])
  step("prepare", ["exec", name, "bash", "-lc", BOOTSTRAP_PREPARE])
  step("bootstrap", ["exec", "-i", name, "bash", "-s"], buildBootstrapInstallScript(password))
  step("verify bootstrap", ["exec", name, "bash", "-lc", bootstrapVerify()])

  server = spawn("sbx", ["exec", name, ...buildServeArgs()], { stdio: ["ignore", "pipe", "pipe"], shell: false })
  server.on("error", (e) => fail(String(e)))
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

  step("stop", ["stop", name])
  removeSandbox()
}

main().catch((e) => { fail(e.message) }).finally(() => {
  if (failed) { teardown(); console.error("smoke FAILED"); process.exit(1) }
  teardown()
  console.log("smoke OK")
})
