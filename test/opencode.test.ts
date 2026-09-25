// test/opencode.test.ts
import { createServer } from "node:http"
import { expect, test } from "vitest"
import { applyAndAssertCelyPolicy, BASH_DENY, buildCelyConfigJson, buildOpencodeEnv, buildServeArgs, celyPolicy, createClient, resolveClient, waitForHealth } from "../src/opencode.ts"

test("serve args source the sandbox env and never contain a password", () => {
  const args = buildServeArgs()
  expect(args).toEqual(["bash", "-lc", "set -a; . ~/.config/cely/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0"])
  expect(args.join(" ")).not.toContain("OPENCODE_SERVER_PASSWORD=")
})

test("the cely policy matches spec section 8 and disables share", () => {
  expect(celyPolicy().permission).toEqual({
    "*": "allow",
    bash: { ...BASH_DENY },
    external_directory: "deny", question: "deny",
  })
  expect(celyPolicy().permission.bash).toMatchObject({
    "*": "allow", "git push*": "deny", "git clean -fdx*": "deny", "npm publish*": "deny",
    "pnpm publish*": "deny", "yarn publish*": "deny", "printenv*": "deny", "env": "deny",
    "cat *opencode.env*": "deny", "cat */.config/cely/*": "deny",
  })
  for (const command of ["head", "tail", "base64", "xxd", "od", "strings", "cp", "less", "grep", "sed", "awk"]) {
    expect(celyPolicy().permission.bash[`${command} *opencode.env*`]).toBe("deny")
    expect(celyPolicy().permission.bash[`${command} */.config/cely/*`]).toBe("deny")
  }
  expect(celyPolicy().permission.bash["*opencode.env*"]).toBe("deny")
  expect(celyPolicy().permission.bash["*/.config/cely/*"]).toBe("deny")
  expect(celyPolicy().share).toBe("disabled")
  expect(JSON.parse(buildCelyConfigJson()).permission).toEqual(celyPolicy().permission)
  expect(JSON.parse(buildCelyConfigJson()).share).toBe("disabled")
})

test("the sandbox env pins the password, config path, and inline content", () => {
  const env = buildOpencodeEnv("deadbeef")
  expect(env).toContain("OPENCODE_SERVER_PASSWORD=deadbeef")
  expect(env).toContain("OPENCODE_CONFIG=$HOME/.config/cely/opencode.json")
  const match = env.match(/OPENCODE_CONFIG_CONTENT='(.+)'/)
  expect(match).not.toBeNull()
  expect(JSON.parse(match![1]!).permission).toEqual(celyPolicy().permission)
})

test("applyAndAssertCelyPolicy patches the policy then verifies it", async () => {
  const calls: any[] = []
  let stored: any = null
  const client = { config: {
    update: async (o: any) => { calls.push(["update", o.body]); stored = o.body; return { data: stored } },
    get: async () => { calls.push(["get"]); return { data: stored } },
  } }
  await applyAndAssertCelyPolicy(client as any)
  expect(calls.map((c) => c[0])).toEqual(["update", "get"])
  expect(stored.permission).toEqual(celyPolicy().permission)
  expect(stored.share).toBe("disabled")
})

test("applyAndAssertCelyPolicy fails closed when the server keeps a weakened policy", async () => {
  const client = { config: {
    update: async () => ({}),
    get: async () => ({ data: { share: "auto", permission: { "*": "allow", external_directory: "allow", question: "allow" } } }),
  } }
  await expect(applyAndAssertCelyPolicy(client as any)).rejects.toThrow(/policy/)
})

test("waitForHealth resolves when /global/health is healthy", async () => {
  let n = 0
  const server = createServer((req, res) => {
    if (++n < 2) { res.writeHead(500).end() ; return }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true, version: "x" }))
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const client = { baseUrl: `http://127.0.0.1:${port}` } as any
    await expect(waitForHealth(client, 2000, 10)).resolves.toBeUndefined()
  } finally {
    server.close()
  }
})
test("waitForHealth rejects on timeout", async () => {
  const server = createServer((_, res) => { res.writeHead(500).end() })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    await expect(waitForHealth({ baseUrl: `http://127.0.0.1:${port}` } as any, 150, 20)).rejects.toThrow(/health/)
  } finally {
    server.close()
  }
})

test("createClient attaches basic auth derived from the password", async () => {
  let auth: string | undefined
  const server = createServer((req, res) => {
    auth = req.headers.authorization
    res.writeHead(200, { "content-type": "application/json" }).end("[]")
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const client = createClient(`http://127.0.0.1:${port}`, "s3cret")
    await client.project.list()
    expect(auth).toBe("Basic " + Buffer.from("opencode:s3cret").toString("base64"))
  } finally {
    server.close()
  }
})

test("createClient exposes baseUrl and auth for health checks", () => {
  const client = createClient("http://127.0.0.1:9", "pw")
  expect(client.baseUrl).toBe("http://127.0.0.1:9")
  expect(client.auth).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
})

test("createClient surfaces SDK errors instead of resolving an error tuple", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ data: { message: "bad request" } }))
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const client = createClient(`http://127.0.0.1:${port}`, "pw")
    await expect(client.session.promptAsync({ path: { id: "s1" }, body: { parts: [] } } as any)).rejects.toThrow(/bad request/)
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test("resolveClient builds the loopback baseUrl from the project", () => {
  const client = resolveClient({ hostPort: 4321, serverPassword: "pw" } as any)
  expect(client.baseUrl).toBe("http://127.0.0.1:4321")
  expect(client.auth).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
})

test("waitForHealth sends credentials and succeeds on an auth-guarded server", async () => {
  const expected = "Basic " + Buffer.from("opencode:pw").toString("base64")
  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) { res.writeHead(401).end(); return }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true, version: "x" }))
  })
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const client = createClient(`http://127.0.0.1:${port}`, "pw")
    await expect(waitForHealth(client, 1000, 10)).resolves.toBeUndefined()
  } finally {
    server.close()
  }
})

test("waitForHealth aborts a hung connection within its budget", async () => {
  const server = createServer(() => {})
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    const started = Date.now()
    await expect(waitForHealth({ baseUrl: `http://127.0.0.1:${port}` } as any, 300, 50)).rejects.toThrow(/health/)
    expect(Date.now() - started).toBeLessThan(2000)
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
