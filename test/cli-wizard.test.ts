import { expect, test } from "vitest"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { createPrompter, mergeEnv, runWizard } from "../src/cli/wizard.ts"
import { createUi } from "../src/cli/ui.ts"
import type { Prompter } from "../src/cli/wizard.ts"
import { DiscordApiError } from "../src/discord-api.ts"
import type { BotIdentity, DiscordSetup, GuildInfo } from "../src/discord-api.ts"
import { withTempDir } from "./helpers/tmp.ts"

function fakePrompter(answers: { secret: string[]; visible: string[] }): Prompter {
  return {
    ask: async () => answers.visible.shift() ?? "",
    askSecret: async () => answers.secret.shift() ?? "",
    close: () => {},
  }
}

function silentUi() {
  return createUi({ out: { write: () => true } as unknown as NodeJS.WritableStream, color: false, ascii: true })
}

test("mergeEnv updates existing keys and appends missing ones, preserving comments", () => {
  const existing = "# Celly\nDISCORD_TOKEN=old\n# keep me\nADMIN_PORT=4560\n"
  const merged = mergeEnv(existing, { DISCORD_TOKEN: "new", DISCORD_GUILD_IDS: "1,2" })
  expect(merged).toBe("# Celly\nDISCORD_TOKEN=new\n# keep me\nADMIN_PORT=4560\n\nDISCORD_GUILD_IDS=1,2\n")
})

test("mergeEnv creates a fresh file when there is no existing content", () => {
  expect(mergeEnv("", { DISCORD_TOKEN: "t", DISCORD_GUILD_IDS: "1" })).toBe("DISCORD_TOKEN=t\nDISCORD_GUILD_IDS=1\n")
})

test("mergeEnv removes keys when asked", () => {
  const existing = "DISCORD_TOKEN=t\nGITHUB_TOKEN=old\nGH_TOKEN=old2\n"
  expect(mergeEnv(existing, {}, ["GITHUB_TOKEN", "GH_TOKEN"])).toBe("DISCORD_TOKEN=t\n")
})

test("runWizard collects values, writes 0600, and refreshes process.env", async () => {
  const env: NodeJS.ProcessEnv = {}
  const writes: Array<{ path: string; data: string; mode: number }> = []
  const result = await runWizard({
    env,
    envFile: "/home/u/.bot-celly/.env",
    ui: silentUi(),
    prompter: fakePrompter({ secret: ["token-123"], visible: ["123456789012345678, 234567890123456789"] }),
    readFile: () => { throw new Error("ENOENT") },
    writeFile: (path, data, options) => { writes.push({ path, data, mode: options.mode }) },
  })
  expect(result.token).toBe("token-123")
  expect(result.guilds).toEqual(["123456789012345678", "234567890123456789"])
  expect(writes).toEqual([{ path: "/home/u/.bot-celly/.env", data: "DISCORD_TOKEN=token-123\nDISCORD_GUILD_IDS=123456789012345678,234567890123456789\n", mode: 0o600 }])
  expect(env.DISCORD_TOKEN).toBe("token-123")
  expect(env.DISCORD_GUILD_IDS).toBe("123456789012345678,234567890123456789")
})

test("runWizard asks for a GitHub token and stores it on yes", async () => {
  const env: NodeJS.ProcessEnv = {}
  const writes: string[] = []
  const result = await runWizard({
    env,
    envFile: "/tmp/.env",
    ui: silentUi(),
    prompter: fakePrompter({ secret: ["token-123", "ghp_secret"], visible: ["123456789012345678", "y"] }),
    readFile: () => { throw new Error("ENOENT") },
    writeFile: (_path, data) => { writes.push(data) },
  })
  expect(result.githubToken).toBe("ghp_secret")
  expect(writes[0]).toContain("GITHUB_TOKEN=ghp_secret")
  expect(env.GITHUB_TOKEN).toBe("ghp_secret")
})

test("runWizard skips the GitHub token on no", async () => {
  const env: NodeJS.ProcessEnv = {}
  const writes: string[] = []
  const result = await runWizard({
    env,
    envFile: "/tmp/.env",
    ui: silentUi(),
    prompter: fakePrompter({ secret: ["token-123"], visible: ["123456789012345678", "n"] }),
    readFile: () => { throw new Error("ENOENT") },
    writeFile: (_path, data) => { writes.push(data) },
  })
  expect(result.githubToken).toBeUndefined()
  expect(writes[0]).not.toContain("GITHUB_TOKEN")
  expect(env.GITHUB_TOKEN).toBeUndefined()
})

test("runWizard keeps existing token and guilds on empty input", async () => {
  const env: NodeJS.ProcessEnv = { DISCORD_TOKEN: "old-token", DISCORD_GUILD_IDS: "123456789012345678" }
  const writes: string[] = []
  const result = await runWizard({
    env,
    envFile: "/tmp/.env",
    ui: silentUi(),
    prompter: fakePrompter({ secret: [""], visible: ["", ""] }),
    readFile: () => "",
    writeFile: (_path, data) => { writes.push(data) },
  })
  expect(result.token).toBe("old-token")
  expect(result.guilds).toEqual(["123456789012345678"])
  expect(writes[0]).toContain("DISCORD_TOKEN=old-token")
  expect(writes[0]).toContain("DISCORD_GUILD_IDS=123456789012345678")
})

test("runWizard keeps, updates, or removes the existing GitHub token", async () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_GUILD_IDS: "123456789012345678", GITHUB_TOKEN: "ghp_old" }

  const keepEnv: NodeJS.ProcessEnv = { ...base }
  let keepData = ""
  const kept = await runWizard({
    env: keepEnv,
    envFile: "/tmp/.env",
    ui: silentUi(),
    prompter: fakePrompter({ secret: [""], visible: ["", "k"] }),
    readFile: () => "GITHUB_TOKEN=ghp_old\n",
    writeFile: (_path, data) => { keepData = data },
  })
  expect(kept.githubToken).toBe("ghp_old")
  expect(keepData).toContain("GITHUB_TOKEN=ghp_old")
  expect(keepEnv.GITHUB_TOKEN).toBe("ghp_old")

  const updateEnv: NodeJS.ProcessEnv = { ...base }
  let updateData = ""
  const updated = await runWizard({
    env: updateEnv,
    envFile: "/tmp/.env",
    ui: silentUi(),
    prompter: fakePrompter({ secret: ["", "ghp_new"], visible: ["", "u"] }),
    readFile: () => "GITHUB_TOKEN=ghp_old\n",
    writeFile: (_path, data) => { updateData = data },
  })
  expect(updated.githubToken).toBe("ghp_new")
  expect(updateData).toContain("GITHUB_TOKEN=ghp_new")
  expect(updateData).not.toContain("ghp_old")
  expect(updateEnv.GITHUB_TOKEN).toBe("ghp_new")

  const removeEnv: NodeJS.ProcessEnv = { ...base }
  let removeData = ""
  const removed = await runWizard({
    env: removeEnv,
    envFile: "/tmp/.env",
    ui: silentUi(),
    prompter: fakePrompter({ secret: [""], visible: ["", "r"] }),
    readFile: () => "GITHUB_TOKEN=ghp_old\n",
    writeFile: (_path, data) => { removeData = data },
  })
  expect(removed.githubToken).toBeUndefined()
  expect(removeData).not.toContain("GITHUB_TOKEN")
  expect(removeEnv.GITHUB_TOKEN).toBeUndefined()
})

test("runWizard re-prompts on a bad guild id and an empty token", async () => {
  const env: NodeJS.ProcessEnv = {}
  const answers = { secret: ["", "good-token"], visible: ["not-an-id", "123456789012345678"] }
  const result = await runWizard({
    env,
    envFile: "/tmp/.env",
    ui: silentUi(),
    prompter: fakePrompter(answers),
    readFile: () => "",
    writeFile: () => {},
  })
  expect(result.guilds).toEqual(["123456789012345678"])
})

test("runWizard tightens the env file mode when rewriting an existing file", async () => {
  await withTempDir("celly-wizard-", async (dir) => {
    const path = join(dir, ".env")
    writeFileSync(path, "DISCORD_TOKEN=old\nDISCORD_GUILD_IDS=111111111111111111\n", { mode: 0o644 })
    const env: NodeJS.ProcessEnv = {}
    await runWizard({
      env,
      envFile: path,
      ui: silentUi(),
      prompter: fakePrompter({ secret: ["new-token"], visible: ["123456789012345678"] }),
    })
    expect(readFileSync(path, "utf8")).toContain("DISCORD_TOKEN=new-token")
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

class FakeTtyInput extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(value: boolean): this { this.isRaw = value; return this }
}

function ttyOutput() {
  let text = ""
  const stream = {
    isTTY: true,
    columns: 80,
    write: (chunk: string) => { text += chunk; return true },
    on() { return stream },
    once() { return stream },
    removeListener() { return stream },
    getColorDepth: () => 1,
  }
  return { stream: stream as unknown as NodeJS.WritableStream, get: () => text }
}

test("createPrompter keeps line input working after a hidden prompt", async () => {
  const input = new FakeTtyInput()
  const output = { write: () => true } as unknown as NodeJS.WritableStream
  const prompter = createPrompter(input, output)

  const secret = prompter.askSecret("Token: ")
  input.emit("keypress", "t", { name: "t" })
  input.emit("keypress", "\r", { name: "return" })
  expect(await secret).toBe("t")
  expect(input.isRaw).toBe(false)

  const ask = prompter.ask("Guilds: ")
  setImmediate(() => input.write("123456789012345678\n"))
  expect(await ask).toBe("123456789012345678")
  prompter.close()
})

test("createPrompter never writes the hidden token to the output", async () => {
  const input = new FakeTtyInput()
  const output = ttyOutput()
  const prompter = createPrompter(input, output.stream)

  const secret = prompter.askSecret("Token: ")
  for (const ch of "hunter2") input.emit("keypress", ch, { name: ch })
  input.emit("keypress", "\r", { name: "return" })
  expect(await secret).toBe("hunter2")
  expect(output.get()).not.toContain("hunter2")
  prompter.close()
})

function fakeDiscord(options: { identity?: BotIdentity; flags?: number; guilds?: GuildInfo[]; fail?: "unauthorized" | "network" } = {}): DiscordSetup {
  const fail = options.fail
  const reject = <T>(): Promise<T> => Promise.reject(
    new DiscordApiError(fail ?? "network", fail === "unauthorized" ? "bad token" : "offline", fail === "unauthorized" ? 401 : undefined),
  )
  return {
    validateToken: () => (fail ? reject<BotIdentity>() : Promise.resolve(options.identity ?? { id: "42", username: "celly" })),
    getApplication: () => (fail ? reject<{ id: string; name: string; flags: number }>() : Promise.resolve({ id: "42", name: "Celly", flags: options.flags ?? ((1 << 18) | (1 << 14)) })),
    listGuilds: () => (fail ? reject<GuildInfo[]>() : Promise.resolve(options.guilds ?? [])),
  }
}

function captureUi() {
  const chunks: string[] = []
  const out = { write: (chunk: string) => { chunks.push(chunk); return true } } as unknown as NodeJS.WritableStream
  return { ui: createUi({ out, color: false, ascii: true }), text: () => chunks.join("") }
}

test("runWizard verifies the token, prints an invite link, and picks a discovered guild", async () => {
  const captured = captureUi()
  let data = ""
  const result = await runWizard({
    env: {}, envFile: "/tmp/.env", ui: captured.ui,
    prompter: fakePrompter({ secret: ["token-123"], visible: ["2"] }),
    readFile: () => "", writeFile: (_p, d) => { data = d },
    discord: fakeDiscord({ guilds: [{ id: "111111111111111111", name: "One" }, { id: "222222222222222222", name: "Two" }] }),
  })
  expect(result.guilds).toEqual(["222222222222222222"])
  expect(data).toContain("DISCORD_GUILD_IDS=222222222222222222")
  expect(captured.text()).toContain("Discord bot: celly")
  expect(captured.text()).toContain("https://discord.com/oauth2/authorize?client_id=42")
})

test("runWizard falls back to manual guild IDs when Discord is unreachable", async () => {
  let data = ""
  const result = await runWizard({
    env: {}, envFile: "/tmp/.env", ui: silentUi(),
    prompter: fakePrompter({ secret: ["token-123"], visible: ["123456789012345678"] }),
    readFile: () => "", writeFile: (_p, d) => { data = d },
    discord: fakeDiscord({ fail: "network" }),
  })
  expect(result.guilds).toEqual(["123456789012345678"])
  expect(data).toContain("DISCORD_GUILD_IDS=123456789012345678")
})

test("runWizard warns and links the Developer Portal when Message Content intent is off", async () => {
  const captured = captureUi()
  const result = await runWizard({
    env: {}, envFile: "/tmp/.env", ui: captured.ui,
    prompter: fakePrompter({ secret: ["token-123"], visible: ["123456789012345678"] }),
    readFile: () => "", writeFile: () => {},
    discord: fakeDiscord({ flags: 0, guilds: [] }),
  })
  expect(captured.text()).toContain("Message Content intent is OFF")
  expect(captured.text()).toContain("https://discord.com/developers/applications/42/bot")
  expect(result.guilds).toEqual(["123456789012345678"])
})

test("runWizard warns on a rejected token and still lets you proceed manually", async () => {
  const captured = captureUi()
  const result = await runWizard({
    env: {}, envFile: "/tmp/.env", ui: captured.ui,
    prompter: fakePrompter({ secret: ["token-123"], visible: ["123456789012345678"] }),
    readFile: () => "", writeFile: () => {},
    discord: fakeDiscord({ fail: "unauthorized" }),
  })
  expect(captured.text()).toContain("Discord rejected that token")
  expect(result.guilds).toEqual(["123456789012345678"])
})
