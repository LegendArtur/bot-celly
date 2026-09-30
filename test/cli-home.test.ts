import { join } from "node:path"
import { expect, test } from "vitest"
import { applyHome, resolveCellyHome } from "../src/cli/home.ts"

test("CELLY_HOME wins, otherwise ~/.bot-celly", () => {
  const home = "/home/u"
  expect(resolveCellyHome({ CELLY_HOME: "/custom" }, () => home)).toBe("/custom")
  expect(resolveCellyHome({}, () => home)).toBe(join(home, ".bot-celly"))
  expect(resolveCellyHome({ CELLY_HOME: "   " }, () => home)).toBe(join(home, ".bot-celly"))
})

test("applyHome creates the home 0700, points CELLY_ENV_FILE at ~/.bot-celly/.env, loads it, and defaults DATA_DIR", () => {
  const home = join("/home/u", ".bot-celly")
  const env: NodeJS.ProcessEnv = {}
  const mkdirCalls: Array<{ path: string; mode: number }> = []
  const loaded: string[] = []
  const result = applyHome({
    env,
    resolveHome: () => home,
    mkdir: (path, options) => { mkdirCalls.push({ path, mode: options.mode }) },
    loadEnvFile: (path) => { loaded.push(path); env.DISCORD_TOKEN = "from-file" },
  })
  expect(result).toEqual({
    home,
    envFile: join(home, ".env"),
    dataDir: join(home, "data"),
    envFileLoaded: true,
  })
  expect(mkdirCalls).toEqual([{ path: home, mode: 0o700 }])
  expect(loaded).toEqual([join(home, ".env")])
  expect(env.CELLY_ENV_FILE).toBe(join(home, ".env"))
  expect(env.DATA_DIR).toBe(join(home, "data"))
})

test("applyHome respects an existing DATA_DIR and tolerates a missing env file", () => {
  const env: NodeJS.ProcessEnv = { DATA_DIR: "/var/celly" }
  const result = applyHome({
    env,
    resolveHome: () => join("/home/u", ".bot-celly"),
    mkdir: () => {},
    loadEnvFile: () => { throw new Error("ENOENT") },
  })
  expect(result.envFileLoaded).toBe(false)
  expect(result.dataDir).toBe("/var/celly")
})
