import { expect, test, vi } from "vitest"
import { join } from "node:path"
import { runCli } from "../src/cli.ts"
import type { RunCliDeps } from "../src/cli.ts"
import type { Ui } from "../src/cli/ui.ts"
import type { Prompter } from "../src/cli/wizard.ts"
import { withTempDir } from "./helpers/tmp.ts"

vi.mock("../src/cli/doctor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/doctor.ts")>()
  return {
    ...actual,
    runDoctor: (deps: Parameters<typeof actual.runDoctor>[0]) => actual.runDoctor({ ...deps, nodeVersion: "24.1.0" }),
  }
})

function fakeUi(): { ui: Ui; lines: string[] } {
  const lines: string[] = []
  const ui: Ui = {
    heading: (text) => { lines.push(`heading: ${text}`) },
    rule: () => { lines.push("rule") },
    bullet: (text) => { lines.push(`bullet: ${text}`) },
    hint: (text) => { lines.push(`hint: ${text}`) },
    status: (kind, label, detail) => { lines.push(detail ? `${kind}: ${label}: ${detail}` : `${kind}: ${label}`) },
    rows: (items) => { for (const item of items) lines.push(`${item.kind}: ${item.label}${item.detail ? `: ${item.detail}` : ""}`) },
  }
  return { ui, lines }
}

function fakePrompter(): Prompter {
  return { ask: async () => "", askSecret: async () => "", close: () => {} }
}

const okSbx = async (args: string[]) => ({
  code: 0,
  stdout: args[0] === "version" ? "sbx 0.45.0\n" : "balanced\n",
  stderr: "",
})

function makeDeps(dir: string, extra: Partial<RunCliDeps> = {}): RunCliDeps {
  return {
    argv: [],
    env: {},
    isTTY: false,
    ui: fakeUi().ui,
    applyHome: () => ({ home: dir, envFile: join(dir, ".env"), dataDir: join(dir, "data"), envFileLoaded: true }),
    makePrompter: fakePrompter,
    runSbx: okSbx,
    ...extra,
  }
}

test("unknown flag and unknown command return exit code 2", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await runCli(makeDeps(dir, { argv: ["--nope"] }))).toBe(2)
      expect(await runCli(makeDeps(dir, { argv: ["frobnicate"] }))).toBe(2)
    } finally {
      error.mockRestore()
    }
  })
})

test("--help returns 0 without booting", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    let mainCalls = 0
    try {
      expect(await runCli(makeDeps(dir, { argv: ["--help"], main: async () => { mainCalls++ } }))).toBe(0)
      expect(mainCalls).toBe(0)
    } finally {
      log.mockRestore()
    }
  })
})

test("--version returns 0 without booting", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    let mainCalls = 0
    try {
      expect(await runCli(makeDeps(dir, { argv: ["--version"], main: async () => { mainCalls++ } }))).toBe(0)
      expect(mainCalls).toBe(0)
    } finally {
      log.mockRestore()
    }
  })
})

test("missing config without a TTY returns 1 without booting", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    let mainCalls = 0
    const code = await runCli(makeDeps(dir, { isTTY: false, main: async () => { mainCalls++ } }))
    expect(code).toBe(1)
    expect(mainCalls).toBe(0)
  })
})

test("headless flags boot once through main", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    let mainCalls = 0
    const code = await runCli(makeDeps(dir, {
      argv: ["--token", "t", "--guilds", "123456789012345678"],
      isTTY: false,
      main: async () => { mainCalls++ },
    }))
    expect(code).toBe(0)
    expect(mainCalls).toBe(1)
  })
})

test("doctor returns 1 on a hard failure and never boots", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    let mainCalls = 0
    const failSbx = async (args: string[]) => args[0] === "version"
      ? { code: 1, stdout: "", stderr: "not found" }
      : { code: 1, stdout: "", stderr: "no policy" }
    const code = await runCli(makeDeps(dir, {
      argv: ["doctor", "--token", "t", "--guilds", "123456789012345678"],
      isTTY: false,
      runSbx: failSbx,
      main: async () => { mainCalls++ },
    }))
    expect(code).toBe(1)
    expect(mainCalls).toBe(0)
  })
})

test("doctor returns 0 on a healthy host and never boots", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    let mainCalls = 0
    const code = await runCli(makeDeps(dir, {
      argv: ["doctor", "--token", "t", "--guilds", "123456789012345678"],
      isTTY: false,
      main: async () => { mainCalls++ },
    }))
    expect(code).toBe(0)
    expect(mainCalls).toBe(0)
  })
})

test("setup stops after setup unless --run is passed", async () => {
  await withTempDir("celly-cli-", async (dir) => {
    let mainCalls = 0
    const deps = {
      isTTY: false,
      main: async () => { mainCalls++ },
    } as const
    const base = ["setup", "--token", "t", "--guilds", "123456789012345678"]

    expect(await runCli(makeDeps(dir, { ...deps, argv: base }))).toBe(0)
    expect(mainCalls).toBe(0)

    expect(await runCli(makeDeps(dir, { ...deps, argv: [...base, "--run"] }))).toBe(0)
    expect(mainCalls).toBe(1)
  })
})
