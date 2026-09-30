import { expect, test } from "vitest"
import { parseArgs } from "../src/cli/args.ts"

test("no arguments runs the bot", () => {
  const result = parseArgs([])
  expect(result).toEqual({ ok: true, options: { command: "run", run: false } })
})

test("recognises the explicit run subcommand", () => {
  expect(parseArgs(["run"])).toEqual({ ok: true, options: { command: "run", run: false } })
})

test("recognises subcommands", () => {
  expect(parseArgs(["setup"])).toEqual({ ok: true, options: { command: "setup", run: false } })
  expect(parseArgs(["doctor"])).toEqual({ ok: true, options: { command: "doctor", run: false } })
  expect(parseArgs(["help"])).toEqual({ ok: true, options: { command: "help", run: false } })
  expect(parseArgs(["version"])).toEqual({ ok: true, options: { command: "version", run: false } })
})

test("help and version short and long flags", () => {
  expect(parseArgs(["--help"]).ok && parseArgs(["--help"])).toMatchObject({ options: { command: "help" } })
  expect(parseArgs(["-h"]).ok && parseArgs(["-h"])).toMatchObject({ options: { command: "help" } })
  expect(parseArgs(["--version"]).ok && parseArgs(["--version"])).toMatchObject({ options: { command: "version" } })
  expect(parseArgs(["-v"]).ok && parseArgs(["-v"])).toMatchObject({ options: { command: "version" } })
})

test("collects value flags regardless of position", () => {
  expect(parseArgs(["--token", "abc", "--guilds", "1,2", "--home", "/tmp/x"])).toEqual({
    ok: true,
    options: { command: "run", run: false, token: "abc", guilds: "1,2", home: "/tmp/x" },
  })
  expect(parseArgs(["setup", "--run", "--home", "/tmp/x"])).toEqual({
    ok: true,
    options: { command: "setup", run: true, home: "/tmp/x" },
  })
})

test("rejects a value flag with no value", () => {
  expect(parseArgs(["--token"])).toEqual({ ok: false, message: "--token requires a value" })
  expect(parseArgs(["--token", "--guilds", "1"])).toEqual({ ok: false, message: "--token requires a value" })
})

test("rejects unknown flags and commands", () => {
  expect(parseArgs(["--nope"])).toEqual({ ok: false, message: "unknown flag: --nope" })
  expect(parseArgs(["frobnicate"])).toEqual({ ok: false, message: "unknown command: frobnicate" })
})

test("rejects a second bare argument", () => {
  expect(parseArgs(["setup", "doctor"])).toEqual({ ok: false, message: "unexpected argument: doctor" })
})
