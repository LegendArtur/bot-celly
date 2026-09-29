// test/opencode.test.ts
import { expect, test } from "vitest"
import { applyAndAssertCellyPolicy, AUTH_ENV_BY_PROVIDER, BASH_DENY, basicAuth, buildCellyConfigJson, buildOpencodeEnv, buildServeArgs, cellyPolicy, createClient, createV2Client, enableQuestionPermissionV2, OPENCODE_AUTH_PATH, resolveClient, resolveV2Client, waitForHealth } from "../src/opencode.ts"
import { startTestServer } from "./helpers/http.ts"

test("basicAuth encodes the opencode user and password", () => {
  expect(basicAuth("pw")).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
})

test("serve args source the sandbox env and never contain a password", () => {
  const args = buildServeArgs()
  expect(args).toEqual(["bash", "-lc", `set -a; . ~/.config/celly/opencode.env; set +a; auth="$HOME/.local/share/opencode/auth.json"; if [ -f "$auth" ]; then grep -q "\\"openai\\"" "$auth" && unset OPENAI_API_KEY; grep -q "\\"anthropic\\"" "$auth" && unset ANTHROPIC_API_KEY; grep -q "\\"deepseek\\"" "$auth" && unset DEEPSEEK_API_KEY; grep -q "\\"google\\"" "$auth" && unset GOOGLE_GENERATIVE_AI_API_KEY; grep -q "\\"xai\\"" "$auth" && unset XAI_API_KEY; grep -q "\\"openrouter\\"" "$auth" && unset OPENROUTER_API_KEY; grep -q "\\"groq\\"" "$auth" && unset GROQ_API_KEY; fi; exec opencode serve --port 4096 --hostname 0.0.0.0`])
  expect(args.join(" ")).not.toContain("OPENCODE_SERVER_PASSWORD=")
})

test("serve args unset proxy placeholder envs only for providers present in auth.json", () => {
  const payload = buildServeArgs()[2]!
  expect(payload).toContain(OPENCODE_AUTH_PATH)
  expect(payload).toContain('if [ -f "$auth" ]')
  for (const [id, env] of Object.entries(AUTH_ENV_BY_PROVIDER)) {
    expect(payload).toContain(`grep -q "\\"${id}\\"" "$auth" && unset ${env}`)
  }
  expect(payload).not.toContain("OPENCODE_SERVER_PASSWORD=")
})

test("the celly policy matches spec section 8 and disables share", () => {
  expect(cellyPolicy().permission).toEqual({
    "*": "allow",
    bash: { ...BASH_DENY },
    external_directory: "deny", question: "allow",
  })
  expect(cellyPolicy().permission.bash).toMatchObject({
    "*": "allow", "git push*": "deny", "git clean -fdx*": "deny", "npm publish*": "deny",
    "pnpm publish*": "deny", "yarn publish*": "deny", "printenv*": "deny", "env": "deny",
    "cat *opencode.env*": "deny", "cat */.config/celly/*": "deny",
  })
  for (const command of ["head", "tail", "base64", "xxd", "od", "strings", "cp", "less", "grep", "sed", "awk"]) {
    expect(cellyPolicy().permission.bash[`${command} *opencode.env*`]).toBe("deny")
    expect(cellyPolicy().permission.bash[`${command} */.config/celly/*`]).toBe("deny")
  }
  expect(cellyPolicy().permission.bash["*opencode.env*"]).toBe("deny")
  expect(cellyPolicy().permission.bash["*/.config/celly/*"]).toBe("deny")
  expect(cellyPolicy().share).toBe("disabled")
  expect(JSON.parse(buildCellyConfigJson()).permission).toEqual(cellyPolicy().permission)
  expect(JSON.parse(buildCellyConfigJson()).share).toBe("disabled")
})

test("the sandbox env pins the password, config path, and inline content", () => {
  const env = buildOpencodeEnv("deadbeef")
  expect(env).toContain("OPENCODE_SERVER_PASSWORD=deadbeef")
  expect(env).toContain("OPENCODE_CONFIG=$HOME/.config/celly/opencode.json")
  const match = env.match(/OPENCODE_CONFIG_CONTENT='(.+)'/)
  expect(match).not.toBeNull()
  expect(JSON.parse(match![1]!).permission).toEqual(cellyPolicy().permission)
})

test("applyAndAssertCellyPolicy patches the policy then verifies it", async () => {
  const calls: any[] = []
  let stored: any = null
  const client = { config: {
    update: async (o: any) => { calls.push(["update", o.body]); stored = o.body; return { data: stored } },
    get: async () => { calls.push(["get"]); return { data: stored } },
  } }
  await applyAndAssertCellyPolicy(client as any)
  expect(calls.map((c) => c[0])).toEqual(["update", "get"])
  expect(stored.permission).toEqual(cellyPolicy().permission)
  expect(stored.share).toBe("disabled")
})

test("applyAndAssertCellyPolicy fails closed when the server keeps a weakened policy", async () => {
  const client = { config: {
    update: async () => ({}),
    get: async () => ({ data: { share: "auto", permission: { "*": "allow", external_directory: "allow", question: "allow" } } }),
  } }
  await expect(applyAndAssertCellyPolicy(client as any)).rejects.toThrow(/policy/)
})

// Captured verbatim from a live opencode 1.18.32 server: it normalizes pattern
// keys (spaces and `*` stripped, `"*"` becomes `""`) and reports `question`
// as deny even though the PATCH asks for allow.
const SERVER_NORMALIZED_PERMISSION = {
  bash: {
    "": "allow",
    "git push": "deny",
    "git clean -fdx": "deny",
    "npm publish": "deny",
    "pnpm publish": "deny",
    "yarn publish": "deny",
    printenv: "deny",
    env: "deny",
    "catopencode.env": "deny",
    "cat/.config/celly/": "deny",
    "awkopencode.env": "deny",
    "awk/.config/celly/": "deny",
    "base64opencode.env": "deny",
    "base64/.config/celly/": "deny",
    "cpopencode.env": "deny",
    "cp/.config/celly/": "deny",
    "grepopencode.env": "deny",
    "grep/.config/celly/": "deny",
    "headopencode.env": "deny",
    "head/.config/celly/": "deny",
    "lessopencode.env": "deny",
    "less/.config/celly/": "deny",
    "odopencode.env": "deny",
    "od/.config/celly/": "deny",
    "sedopencode.env": "deny",
    "sed/.config/celly/": "deny",
    "stringsopencode.env": "deny",
    "strings/.config/celly/": "deny",
    "tailopencode.env": "deny",
    "tail/.config/celly/": "deny",
    "xxdopencode.env": "deny",
    "xxd/.config/celly/": "deny",
    "opencode.env": "deny",
    "/.config/celly/": "deny",
  },
  external_directory: "deny",
  question: "deny",
  "": "allow",
}

test("applyAndAssertCellyPolicy accepts the server's normalized permission map", async () => {
  const client = { config: {
    update: async () => ({}),
    get: async () => ({ data: { share: "disabled", permission: SERVER_NORMALIZED_PERMISSION } }),
  } }
  await expect(applyAndAssertCellyPolicy(client as any)).resolves.toBeUndefined()
})

test("enableQuestionPermissionV2 merges question allow and PATCHes the global config", async () => {
  const calls: any[] = []
  const v2 = { global: { config: {
    get: async () => ({ data: { permission: { bash: { "git push": "deny" }, external_directory: "deny" }, share: "disabled" } }),
    update: async (o: any) => { calls.push(o.config); return {} },
  } } }
  await expect(enableQuestionPermissionV2(v2 as any)).resolves.toBe(true)
  expect(calls).toHaveLength(1)
  expect(calls[0].permission.question).toBe("allow")
  expect(calls[0].permission.bash).toEqual({ "git push": "deny" })
  expect(calls[0].permission.external_directory).toBe("deny")
  expect(calls[0].share).toBe("disabled")
})

test("enableQuestionPermissionV2 returns false when the client throws", async () => {
  const v2 = { global: { config: {
    get: async () => { throw new Error("boom") },
    update: async () => ({}),
  } } }
  await expect(enableQuestionPermissionV2(v2 as any)).resolves.toBe(false)
})

test("applyAndAssertCellyPolicy still resolves when the v2 client throws", async () => {
  const client = { config: {
    update: async () => ({}),
    get: async () => ({ data: { share: "disabled", permission: SERVER_NORMALIZED_PERMISSION } }),
  } }
  const v2 = { global: { config: { get: async () => { throw new Error("no v2 config") }, update: async () => ({}) } } }
  await expect(applyAndAssertCellyPolicy(client as any, v2 as any)).resolves.toBeUndefined()
})

test("applyAndAssertCellyPolicy fails closed when a deny pattern is weakened to allow", async () => {
  const permission = structuredClone(SERVER_NORMALIZED_PERMISSION) as any
  permission.bash["gitpush"] = "allow"
  const client = { config: {
    update: async () => ({}),
    get: async () => ({ data: { share: "disabled", permission } }),
  } }
  await expect(applyAndAssertCellyPolicy(client as any)).rejects.toThrow(/git push/)
})

test("applyAndAssertCellyPolicy fails closed when a deny pattern disappears", async () => {
  const permission = structuredClone(SERVER_NORMALIZED_PERMISSION) as any
  delete permission.bash["git clean -fdx"]
  const client = { config: {
    update: async () => ({}),
    get: async () => ({ data: { share: "disabled", permission } }),
  } }
  await expect(applyAndAssertCellyPolicy(client as any)).rejects.toThrow(/git clean -fdx/)
})

test("waitForHealth resolves when /global/health is healthy", async () => {
  let n = 0
  const server = await startTestServer((req, res) => {
    if (++n < 2) { res.writeHead(500).end() ; return }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true, version: "x" }))
  })
  try {
    const client = { baseUrl: server.url } as any
    await expect(waitForHealth(client, 2000, { intervalMs: 10 })).resolves.toBeUndefined()
  } finally {
    await server.close()
  }
})
test("waitForHealth rejects on timeout", async () => {
  const server = await startTestServer((_, res) => { res.writeHead(500).end() })
  try {
    await expect(waitForHealth({ baseUrl: server.url } as any, 150, { intervalMs: 20 })).rejects.toThrow(/health/)
  } finally {
    await server.close()
  }
})

test("createClient attaches basic auth derived from the password", async () => {
  let auth: string | undefined
  const server = await startTestServer((req, res) => {
    auth = req.headers.authorization
    res.writeHead(200, { "content-type": "application/json" }).end("[]")
  })
  try {
    const client = createClient(server.url, "s3cret")
    await client.project.list()
    expect(auth).toBe("Basic " + Buffer.from("opencode:s3cret").toString("base64"))
  } finally {
    await server.close()
  }
})

test("createClient surfaces SDK errors instead of resolving an error tuple", async () => {
  const server = await startTestServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ data: { message: "bad request" } }))
  })
  try {
    const client = createClient(server.url, "pw")
    await expect(client.session.promptAsync({ path: { id: "s1" }, body: { parts: [] } } as any)).rejects.toThrow(/bad request/)
  } finally {
    await server.close()
  }
})

test("resolveClient builds the loopback baseUrl from the project", () => {
  const client = resolveClient({ hostPort: 4321, serverPassword: "pw" } as any)
  expect(client.baseUrl).toBe("http://127.0.0.1:4321")
  expect(client.auth).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
})

test("waitForHealth sends credentials and succeeds on an auth-guarded server", async () => {
  const expected = "Basic " + Buffer.from("opencode:pw").toString("base64")
  const server = await startTestServer((req, res) => {
    if (req.headers.authorization !== expected) { res.writeHead(401).end(); return }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true, version: "x" }))
  })
  try {
    const client = createClient(server.url, "pw")
    await expect(waitForHealth(client, 1000, { intervalMs: 10 })).resolves.toBeUndefined()
  } finally {
    await server.close()
  }
})

test("waitForHealth aborts a hung connection within its budget", async () => {
  const server = await startTestServer(() => {})
  try {
    const started = Date.now()
    await expect(waitForHealth({ baseUrl: server.url } as any, 300, { intervalMs: 50 })).rejects.toThrow(/health/)
    expect(Date.now() - started).toBeLessThan(2000)
  } finally {
    await server.close()
  }
})

test("waitForHealth bounds each attempt so a hung connection cannot exhaust the budget", async () => {
  let requests = 0
  const server = await startTestServer((_req, res) => {
    requests += 1
    if (requests === 1) return // hang the first attempt only
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true, version: "x" }))
  })
  try {
    await expect(waitForHealth({ baseUrl: server.url } as any, 2000, { intervalMs: 10, attemptTimeoutMs: 50 })).resolves.toBeUndefined()
    expect(requests).toBeGreaterThanOrEqual(2)
  } finally {
    await server.close()
  }
})

test("createV2Client attaches basic auth and calls the v2 API", async () => {
  let auth: string | undefined
  let url: string | undefined
  const server = await startTestServer((req, res) => {
    auth = req.headers.authorization
    url = req.url
    res.writeHead(200, { "content-type": "application/json" }).end("{}")
  })
  try {
    const client = createV2Client(server.url, "s3cret")
    await client.v2.session.permission.reply({ sessionID: "s1", requestID: "r1", reply: "once" })
    expect(auth).toBe("Basic " + Buffer.from("opencode:s3cret").toString("base64"))
    expect(url).toBe("/api/session/s1/permission/r1/reply")
  } finally {
    await server.close()
  }
})

test("resolveV2Client builds the loopback baseUrl from the project", () => {
  const client = resolveV2Client({ hostPort: 4321, serverPassword: "pw" } as any)
  expect(client.baseUrl).toBe("http://127.0.0.1:4321")
  expect(client.auth).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
})
