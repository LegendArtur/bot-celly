// test/opencode.test.ts
import { createServer } from "node:http"
import { expect, test } from "vitest"
import { buildServeArgs, createClient, waitForHealth } from "../src/opencode.ts"

test("serve args source the sandbox env and never contain a password", () => {
  const args = buildServeArgs()
  expect(args).toEqual(["bash", "-lc", "set -a; . ~/.config/cely/opencode.env; set +a; exec opencode serve --port 4096 --hostname 0.0.0.0"])
  expect(args.join(" ")).not.toContain("OPENCODE_SERVER_PASSWORD=")
})

test("waitForHealth resolves when /global/health is healthy", async () => {
  let n = 0
  const server = createServer((req, res) => {
    if (++n < 2) { res.writeHead(500).end() ; return }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ healthy: true, version: "x" }))
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  const client = { baseUrl: `http://127.0.0.1:${port}` } as any
  await expect(waitForHealth(client, 2000, 10)).resolves.toBeUndefined()
  server.close()
})
test("waitForHealth rejects on timeout", async () => {
  const server = createServer((_, res) => { res.writeHead(500).end() })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  await expect(waitForHealth({ baseUrl: `http://127.0.0.1:${port}` } as any, 150, 20)).rejects.toThrow(/health/)
  server.close()
})

test("createClient attaches basic auth derived from the password", async () => {
  let auth: string | undefined
  const server = createServer((req, res) => {
    auth = req.headers.authorization
    res.writeHead(200, { "content-type": "application/json" }).end("[]")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  const client = createClient(`http://127.0.0.1:${port}`, "s3cret")
  await client.project.list()
  expect(auth).toBe("Basic " + Buffer.from("opencode:s3cret").toString("base64"))
  server.close()
})
