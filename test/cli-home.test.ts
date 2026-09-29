import { expect, test } from "vitest"
import { applyHome, resolveCellyHome } from "../src/cli/home.ts"

test("CELLY_HOME wins, otherwise ~/.bot-celly", () => {
  expect(resolveCellyHome({ CELLY_HOME: "/custom" }, () => "/home/u")).toBe("/custom")
  expect(resolveCellyHome({}, () => "/home/u")).toBe("/home/u/.bot-celly")
  expect(resolveCellyHome({ CELLY_HOME: "   " }, () => "/home/u")).toBe("/home/u/.bot-celly")
})

test("applyHome creates the home 0700, points CELLY_ENV_FILE at ~/.bot-celly/.env, loads it, and defaults DATA_DIR", () => {
  const env: NodeJS.ProcessEnv = {}
  const mkdirCalls: Array<{ path: string; mode: number }> = []
  const loaded: string[] = []
  const result = applyHome({
    env,
    resolveHome: () => "/home/u/.bot-celly",
    mkdir: (path, options) => { mkdirCalls.push({ path, mode: options.mode }) },
    loadEnvFile: (path) => { loaded.push(path); env.DISCORD_TOKEN = "from-file" },
  })
  expect(result).toEqual({
    home: "/home/u/.bot-celly",
    envFile: "/home/u/.bot-celly/.env",
    dataDir: "/home/u/.bot-celly/data",
    envFileLoaded: true,
  })
  expect(mkdirCalls).toEqual([{ path: "/home/u/.bot-celly", mode: 0o700 }])
  expect(loaded).toEqual(["/home/u/.bot-celly/.env"])
  expect(env.CELLY_ENV_FILE).toBe("/home/u/.bot-celly/.env")
  expect(env.DATA_DIR).toBe("/home/u/.bot-celly/data")
})

test("applyHome respects an existing DATA_DIR and tolerates a missing env file", () => {
  const env: NodeJS.ProcessEnv = { DATA_DIR: "/var/celly" }
  const result = applyHome({
    env,
    resolveHome: () => "/home/u/.bot-celly",
    mkdir: () => {},
    loadEnvFile: () => { throw new Error("ENOENT") },
  })
  expect(result.envFileLoaded).toBe(false)
  expect(result.dataDir).toBe("/var/celly")
})
