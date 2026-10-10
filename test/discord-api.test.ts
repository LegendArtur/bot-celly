import { expect, test } from "vitest"
import {
  DISCORD_API_BASE,
  INVITE_PERMISSION_VALUE,
  buildInviteUrl,
  createDiscordSetup,
  getApplication,
  intentStatus,
  listBotGuilds,
  settingsUrl,
  validateBotToken,
} from "../src/discord-api.ts"
import { startTestServer } from "./helpers/http.ts"

const FLAG = {
  GUILD_MEMBERS: 1 << 14,
  GUILD_MEMBERS_LIMITED: 1 << 15,
  MESSAGE_CONTENT: 1 << 18,
  MESSAGE_CONTENT_LIMITED: 1 << 19,
}

test("intentStatus accepts both the full and the limited intent flags", () => {
  expect(intentStatus(FLAG.MESSAGE_CONTENT | FLAG.GUILD_MEMBERS)).toEqual({ messageContent: true, guildMembers: true })
  expect(intentStatus(FLAG.MESSAGE_CONTENT_LIMITED | FLAG.GUILD_MEMBERS_LIMITED)).toEqual({ messageContent: true, guildMembers: true })
  expect(intentStatus(0)).toEqual({ messageContent: false, guildMembers: false })
})

test("buildInviteUrl carries the client id, scopes, and permission bitfield", () => {
  const url = buildInviteUrl("123")
  expect(url.startsWith("https://discord.com/oauth2/authorize?")).toBe(true)
  expect(url).toContain("client_id=123")
  expect(url).toContain("scope=bot%20applications.commands")
  expect(url).toContain(`permissions=${INVITE_PERMISSION_VALUE.toString()}`)
  // The threads bits must survive: a 32-bit shift would drop them.
  expect(INVITE_PERMISSION_VALUE > BigInt(2) ** BigInt(33)).toBe(true)
})

test("settingsUrl deep-links to the application's bot page", () => {
  expect(settingsUrl("123")).toBe("https://discord.com/developers/applications/123/bot")
})

test("DISCORD_API_BASE points at the versioned API", () => {
  expect(DISCORD_API_BASE).toBe("https://discord.com/api/v10")
})

test("validateBotToken returns the identity and sends the Bot authorization header", async () => {
  let authorization = ""
  const server = await startTestServer((req, res) => {
    authorization = String(req.headers.authorization ?? "")
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ id: "42", username: "celly", discriminator: "0", global_name: "Celly" }))
  })
  try {
    const identity = await validateBotToken({ token: "secret", base: server.url })
    expect(identity).toEqual({ id: "42", username: "celly", discriminator: "0", globalName: "Celly" })
    expect(authorization).toBe("Bot secret")
  } finally {
    await server.close()
  }
})

test("a 401 becomes an unauthorized DiscordApiError", async () => {
  const server = await startTestServer((_req, res) => { res.statusCode = 401; res.end("{}") })
  try {
    await expect(validateBotToken({ token: "bad", base: server.url })).rejects.toMatchObject({ kind: "unauthorized", status: 401 })
  } finally {
    await server.close()
  }
})

test("a non-2xx response becomes an http DiscordApiError", async () => {
  const server = await startTestServer((_req, res) => { res.statusCode = 500; res.end("{}") })
  try {
    await expect(validateBotToken({ token: "t", base: server.url })).rejects.toMatchObject({ kind: "http", status: 500 })
  } finally {
    await server.close()
  }
})

test("an unreachable host becomes a network DiscordApiError", async () => {
  await expect(validateBotToken({ token: "t", base: "http://127.0.0.1:1" })).rejects.toMatchObject({ kind: "network" })
})

test("getApplication reads flags and listBotGuilds parses the guild list", async () => {
  const server = await startTestServer((req, res) => {
    res.setHeader("content-type", "application/json")
    if (req.url === "/applications/@me") {
      res.end(JSON.stringify({ id: "42", name: "Celly", flags: FLAG.MESSAGE_CONTENT | FLAG.GUILD_MEMBERS }))
    } else if (req.url === "/users/@me/guilds") {
      res.end(JSON.stringify([{ id: "1", name: "One" }, { id: "2" }]))
    } else {
      res.statusCode = 404
      res.end("{}")
    }
  })
  try {
    expect(await getApplication({ token: "t", base: server.url })).toEqual({ id: "42", name: "Celly", flags: FLAG.MESSAGE_CONTENT | FLAG.GUILD_MEMBERS })
    expect(await listBotGuilds({ token: "t", base: server.url })).toEqual([{ id: "1", name: "One" }, { id: "2", name: "2" }])
  } finally {
    await server.close()
  }
})

test("createDiscordSetup threads the base URL through every call", async () => {
  const server = await startTestServer((req, res) => {
    res.setHeader("content-type", "application/json")
    if (req.url === "/users/@me") res.end(JSON.stringify({ id: "42", username: "celly" }))
    else if (req.url === "/applications/@me") res.end(JSON.stringify({ id: "42", name: "Celly", flags: 0 }))
    else res.end(JSON.stringify([]))
  })
  try {
    const client = createDiscordSetup({ base: server.url })
    expect((await client.validateToken("t")).username).toBe("celly")
    expect(await client.listGuilds("t")).toEqual([])
  } finally {
    await server.close()
  }
})
