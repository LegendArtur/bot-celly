import { expect, test } from "vitest"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mergeEnv, runWizard } from "../src/cli/wizard.ts"
import { createUi } from "../src/cli/ui.ts"
import type { Prompter } from "../src/cli/wizard.ts"
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
