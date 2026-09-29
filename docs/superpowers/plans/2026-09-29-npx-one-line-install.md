# Celly one-line install (`npx bot-celly`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `bot-celly` to npm and add a `bot-celly` CLI that runs a guided first-run setup, reports host-prerequisite health, and boots the existing bot.

**Architecture:** A thin CLI (`src/cli.ts`) sits in front of the unchanged app entry. It resolves a home directory (`~/.bot-celly`), loads that `.env`, applies headless flags, runs a wizard when config is missing and a doctor check before boot, then calls the exported `main()` from `src/index.ts`. All new logic lives in small, dependency-injected modules under `src/cli/` so it is unit-testable without a TTY or a real `sbx`.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), Node 24 built-ins (`node:readline`, `node:readline/promises`, `node:fs`, `node:os`), Vitest, the existing `src/sbx.ts` `SbxRunner`, and the existing `src/ansi.ts` color helpers. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-29-npx-one-line-install-design.md`

## Global Constraints

- Node engine floor: `>=24 <25` — the CLI hard-requires Node 24; do not relax `engines`.
- Package name is `bot-celly`; the user command is `npx bot-celly@latest`.
- Config/data home is `~/.bot-celly` (`%USERPROFILE%\.bot-celly`), overridable with `CELLY_HOME`; `PROJECTS_ROOT` keeps the default `~/Celly/projects`.
- `CELLY_ENV_FILE` is internal CLI coordination, not a documented user knob.
- **argv-only:** never pass user input through a host shell. Only `src/sbx.ts` may import `node:child_process`. The CLI probes `sbx` through `SbxRunner`.
- Home directory mode `0o700`; `~/.bot-celly/.env` mode `0o600` (no-op on Windows).
- CLI exit codes: `0` ok, `1` operational failure, `2` usage error.
- No new runtime dependencies.
- Every commit message uses the repo's Conventional-Commits style (`feat:`, `test:`, `docs:`, `chore:`).
- Tests are run with `npx vitest run test/<file>.test.ts` for a single file, `npm test` for all.
- All existing 737 tests must stay green.

---

### Task 1: CLI argument parser

**Files:**
- Create: `src/cli/args.ts`
- Test: `test/cli-args.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CliCommand = "run" | "setup" | "doctor" | "version" | "help"`
  - `interface CliOptions { command: CliCommand; run: boolean; token?: string; guilds?: string; home?: string }`
  - `type ParseResult = { ok: true; options: CliOptions } | { ok: false; message: string }`
  - `function parseArgs(argv: string[]): ParseResult` — `argv` is `process.argv.slice(2)`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli-args.test.ts`:

```ts
import { expect, test } from "vitest"
import { parseArgs } from "../src/cli/args.ts"

test("no arguments runs the bot", () => {
  const result = parseArgs([])
  expect(result).toEqual({ ok: true, options: { command: "run", run: false } })
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cli-args.test.ts`
Expected: FAIL — `Failed to load ../src/cli/args.ts` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `src/cli/args.ts`:

```ts
export type CliCommand = "run" | "setup" | "doctor" | "version" | "help"

export interface CliOptions {
  command: CliCommand
  run: boolean
  token?: string
  guilds?: string
  home?: string
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; message: string }

const COMMANDS = new Set<CliCommand>(["setup", "doctor", "help", "version"])
type ValueFlag = "token" | "guilds" | "home"
const VALUE_FLAGS = new Map<string, ValueFlag>([
  ["--token", "token"],
  ["--guilds", "guilds"],
  ["--home", "home"],
])

export function parseArgs(argv: string[]): ParseResult {
  const options: CliOptions = { command: "run", run: false }
  let commandSeen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--help" || arg === "-h") return { ok: true, options: { ...options, command: "help" } }
    if (arg === "--version" || arg === "-v") return { ok: true, options: { ...options, command: "version" } }
    if (arg === "--run") { options.run = true; continue }
    const flag = VALUE_FLAGS.get(arg)
    if (flag) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) return { ok: false, message: `${arg} requires a value` }
      options[flag] = value
      i++
      continue
    }
    if (arg.startsWith("-")) return { ok: false, message: `unknown flag: ${arg}` }
    if (commandSeen) return { ok: false, message: `unexpected argument: ${arg}` }
    if (!COMMANDS.has(arg as CliCommand)) return { ok: false, message: `unknown command: ${arg}` }
    options.command = arg as CliCommand
    commandSeen = true
  }
  return { ok: true, options }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cli-args.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/args.ts test/cli-args.test.ts
git commit -m "feat(cli): add the bot-celly argument parser"
```

---

### Task 2: Home directory resolution and env wiring

**Files:**
- Create: `src/cli/home.ts`
- Modify: `src/config.ts` (add `envFileFrom` near `loadDotEnv`, around line 34)
- Modify: `src/index.ts:11` (import `envFileFrom`) and `src/index.ts:56` (`loadDotEnv()` → `loadDotEnv(envFileFrom())`)
- Test: `test/cli-home.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function resolveCellyHome(env?: NodeJS.ProcessEnv, home?: () => string): string`
  - `interface ApplyHomeResult { home: string; envFile: string; dataDir: string; envFileLoaded: boolean }`
  - `function applyHome(deps: { env: NodeJS.ProcessEnv; resolveHome?: (env: NodeJS.ProcessEnv) => string; loadEnvFile?: (path: string) => void; mkdir?: (path: string, options: { recursive: true; mode: number }) => void }): ApplyHomeResult`
  - `function envFileFrom(env?: NodeJS.ProcessEnv): string` (exported from `src/config.ts`)

- [ ] **Step 1: Write the failing tests**

Create `test/cli-home.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cli-home.test.ts`
Expected: FAIL — `Failed to load ../src/cli/home.ts`.

- [ ] **Step 3: Write `src/cli/home.ts`**

Create `src/cli/home.ts`:

```ts
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function resolveCellyHome(env: NodeJS.ProcessEnv = process.env, home: () => string = homedir): string {
  const override = env.CELLY_HOME?.trim()
  return override && override.length > 0 ? override : join(home(), ".bot-celly")
}

export interface ApplyHomeDeps {
  env: NodeJS.ProcessEnv
  resolveHome?: (env: NodeJS.ProcessEnv) => string
  loadEnvFile?: (path: string) => void
  mkdir?: (path: string, options: { recursive: true; mode: number }) => void
}

export interface ApplyHomeResult {
  home: string
  envFile: string
  dataDir: string
  envFileLoaded: boolean
}

export function applyHome(deps: ApplyHomeDeps): ApplyHomeResult {
  const env = deps.env
  const resolveHome = deps.resolveHome ?? resolveCellyHome
  const mkdir = deps.mkdir ?? ((path, options) => { mkdirSync(path, options) })
  const loadEnvFile = deps.loadEnvFile ?? ((path) => { process.loadEnvFile?.(path) })

  const home = resolveHome(env)
  mkdir(home, { recursive: true, mode: 0o700 })
  const envFile = join(home, ".env")
  env.CELLY_ENV_FILE = envFile
  let envFileLoaded = false
  try { loadEnvFile(envFile); envFileLoaded = true } catch { envFileLoaded = false }
  if (!env.DATA_DIR?.trim()) env.DATA_DIR = join(home, "data")
  return { home, envFile, dataDir: env.DATA_DIR!, envFileLoaded }
}
```

- [ ] **Step 4: Add `envFileFrom` to `src/config.ts`**

Insert immediately after `loadDotEnv` (after line 34):

```ts
/**
 * The env file `main()` loads. The CLI points `CELLY_ENV_FILE` at
 * `~/.bot-celly/.env`; the repo/dev flow falls back to `./.env`.
 */
export function envFileFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.CELLY_ENV_FILE ?? ".env"
}
```

- [ ] **Step 5: Wire it into `src/index.ts`**

Change the import on line 11 from:

```ts
import { ensureDataDir, loadConfig, loadDotEnv, seedSettings } from "./config.js"
```

to:

```ts
import { ensureDataDir, envFileFrom, loadConfig, loadDotEnv, seedSettings } from "./config.js"
```

Change line 56 in `main()` from:

```ts
  loadDotEnv()
```

to:

```ts
  loadDotEnv(envFileFrom())
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/cli-home.test.ts test/config.test.ts`
Expected: PASS (new home tests + existing config tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/cli/home.ts src/config.ts src/index.ts test/cli-home.test.ts
git commit -m "feat(cli): resolve the ~/.bot-celly home and env file"
```

---

### Task 3: CLI presentation

**Files:**
- Modify: `src/ansi.ts:1-9` (add a `green` code)
- Create: `src/cli/ui.ts`
- Test: `test/cli-ui.test.ts`

**Interfaces:**
- Consumes: the `ANSI`, `colorEnabled`, `paint` exports from `src/ansi.ts`.
- Produces:
  - `type StatusKind = "ok" | "fail" | "warn" | "info"`
  - `interface Symbols { ok: string; fail: string; warn: string; info: string; pointer: string }`
  - `function symbols(ascii: boolean): Symbols`
  - `interface Ui { heading(text: string): void; bullet(text: string): void; hint(text: string): void; status(kind: StatusKind, label: string, detail?: string): void }`
  - `function createUi(options?: { out?: NodeJS.WritableStream; color?: boolean; ascii?: boolean; env?: NodeJS.ProcessEnv }): Ui`

- [ ] **Step 1: Write the failing tests**

Create `test/cli-ui.test.ts`:

```ts
import { expect, test } from "vitest"
import { createUi, symbols } from "../src/cli/ui.ts"

function collector() {
  let text = ""
  return { stream: { write: (chunk: string) => { text += chunk; return true } } as unknown as NodeJS.WritableStream, get: () => text }
}

test("symbols fall back to ASCII", () => {
  expect(symbols(true)).toEqual({ ok: "[ok]", fail: "[x]", warn: "[!]", info: "[i]", pointer: ">" })
  expect(symbols(false).ok).toBe("✓")
})

test("color output uses ANSI and unicode symbols", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: true, ascii: false })
  ui.heading("Celly doctor")
  ui.status("ok", "Node — v24.0.0")
  ui.status("fail", "sbx", "install it")
  const text = sink.get()
  expect(text).toContain("\x1b[")
  expect(text).toContain("✓ Node — v24.0.0")
  expect(text).toContain("✗ sbx")
  expect(text).toContain("install it")
})

test("plain output has no ANSI", () => {
  const sink = collector()
  const ui = createUi({ out: sink.stream, color: false, ascii: true })
  ui.heading("Celly")
  ui.bullet("hello")
  ui.hint("hidden")
  ui.status("warn", "Provider secret")
  const text = sink.get()
  expect(text).not.toContain("\x1b[")
  expect(text).toContain("> hello")
  expect(text).toContain("[!] Provider secret")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cli-ui.test.ts`
Expected: FAIL — `Failed to load ../src/cli/ui.ts`.

- [ ] **Step 3: Add green to `src/ansi.ts`**

In the `ANSI` object, add a `green` entry after `yellow`:

```ts
  green: "\x1b[32m",
```

- [ ] **Step 4: Write `src/cli/ui.ts`**

Create `src/cli/ui.ts`:

```ts
import { ANSI, colorEnabled, paint } from "../ansi.js"

export type StatusKind = "ok" | "fail" | "warn" | "info"

export interface Symbols {
  ok: string
  fail: string
  warn: string
  info: string
  pointer: string
}

export function symbols(ascii: boolean): Symbols {
  return ascii
    ? { ok: "[ok]", fail: "[x]", warn: "[!]", info: "[i]", pointer: ">" }
    : { ok: "✓", fail: "✗", warn: "!", info: "i", pointer: "›" }
}

const STYLE: Record<StatusKind, { tone: string; symbol: keyof Symbols }> = {
  ok: { tone: ANSI.green, symbol: "ok" },
  fail: { tone: ANSI.red, symbol: "fail" },
  warn: { tone: ANSI.yellow, symbol: "warn" },
  info: { tone: ANSI.cyan, symbol: "info" },
}

export interface Ui {
  heading(text: string): void
  bullet(text: string): void
  hint(text: string): void
  status(kind: StatusKind, label: string, detail?: string): void
}

export interface UiOptions {
  out?: NodeJS.WritableStream
  color?: boolean
  ascii?: boolean
  env?: NodeJS.ProcessEnv
}

export function createUi(options: UiOptions = {}): Ui {
  const out = options.out ?? process.stdout
  const env = options.env ?? process.env
  const color = options.color ?? colorEnabled(env)
  const ascii = options.ascii ?? (env.CELLY_ASCII === "1" || !color)
  const marks = symbols(ascii)
  const write = (line: string): void => { out.write(`${line}\n`) }
  return {
    heading: (text) => write(paint(`${ANSI.bold}${ANSI.cyan}`, text, color)),
    bullet: (text) => write(`${paint(ANSI.dim, marks.pointer, color)} ${text}`),
    hint: (text) => write(paint(ANSI.dim, `  ${text}`, color)),
    status: (kind, label, detail) => {
      const style = STYLE[kind]
      const head = `${paint(style.tone, marks[style.symbol], color)} ${label}`
      write(detail ? `${head}\n${paint(ANSI.dim, `    ${detail}`, color)}` : head)
    },
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/cli-ui.test.ts test/ansi.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ansi.ts src/cli/ui.ts test/cli-ui.test.ts
git commit -m "feat(cli): add color-aware CLI presentation helpers"
```

---

### Task 4: Doctor

**Files:**
- Create: `src/cli/doctor.ts`
- Test: `test/cli-doctor.test.ts`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.ts`; `RunResult` type from `src/sbx.ts`; `Ui` from `src/cli/ui.ts`.
- Produces:
  - `type CheckKind = "hard" | "advisory"`
  - `interface CheckResult { name: string; ok: boolean; kind: CheckKind; detail?: string; fix?: string }`
  - `function satisfiesNode(version: string): boolean`
  - `async function runDoctor(deps: { env: NodeJS.ProcessEnv; home: string; dataDir: string; nodeVersion?: string; runSbx?: (args: string[]) => Promise<RunResult>; mkdir?: (path: string) => void }): Promise<CheckResult[]>`
  - `function hasHardFailure(results: CheckResult[]): boolean`
  - `function reportDoctor(results: CheckResult[], ui: Ui): void`

- [ ] **Step 1: Write the failing tests**

Create `test/cli-doctor.test.ts`:

```ts
import { expect, test } from "vitest"
import { hasHardFailure, reportDoctor, runDoctor, satisfiesNode } from "../src/cli/doctor.ts"
import { createUi } from "../src/cli/ui.ts"

const baseEnv = { DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "123456789012345678" }
const okSbx = async (args: string[]) => ({ code: 0, stdout: args[0] === "version" ? "sbx 0.45.0\n" : "balanced\n", stderr: "" })

test("satisfiesNode only accepts major 24", () => {
  expect(satisfiesNode("24.0.0")).toBe(true)
  expect(satisfiesNode("24.11.3")).toBe(true)
  expect(satisfiesNode("22.22.1")).toBe(false)
  expect(satisfiesNode("25.0.0")).toBe(false)
})

test("all checks pass on a healthy host", async () => {
  const results = await runDoctor({
    env: baseEnv,
    home: "/home/u/.bot-celly",
    dataDir: "/home/u/.bot-celly/data",
    nodeVersion: "24.1.0",
    runSbx: okSbx,
    mkdir: () => {},
  })
  expect(hasHardFailure(results)).toBe(false)
  expect(results.filter((r) => r.kind === "hard").every((r) => r.ok)).toBe(true)
  expect(results.some((r) => r.kind === "advisory")).toBe(true)
})

test("reports the node failure with a fix", async () => {
  const results = await runDoctor({ env: baseEnv, home: "/h", dataDir: "/h/data", nodeVersion: "22.0.0", runSbx: okSbx, mkdir: () => {} })
  const node = results.find((r) => r.name === "Node")!
  expect(node.ok).toBe(false)
  expect(node.fix).toContain("fnm install 24")
  expect(hasHardFailure(results)).toBe(true)
})

test("reports missing sbx, uninitialized policy, and missing config", async () => {
  const failSbx = async (args: string[]) => args[0] === "version"
    ? { code: 127, stdout: "", stderr: "not found" }
    : { code: 1, stdout: "", stderr: "no policy" }
  const results = await runDoctor({ env: {}, home: "/h", dataDir: "/h/data", nodeVersion: "24.0.0", runSbx: failSbx, mkdir: () => {} })
  expect(results.find((r) => r.name === "sbx")!.fix).toContain("winget install")
  expect(results.find((r) => r.name === "Policy")!.fix).toContain("sbx policy init balanced")
  expect(results.find((r) => r.name === "Config")!.ok).toBe(false)
  expect(hasHardFailure(results)).toBe(true)
})

test("reportDoctor prints pass and fail lines", async () => {
  let text = ""
  const out = { write: (chunk: string) => { text += chunk; return true } } as unknown as NodeJS.WritableStream
  const ui = createUi({ out, color: false, ascii: true })
  const results = await runDoctor({ env: {}, home: "/h", dataDir: "/h/data", nodeVersion: "22.0.0", runSbx: okSbx, mkdir: () => {} })
  reportDoctor(results, ui)
  expect(text).toContain("Celly doctor")
  expect(text).toContain("[x] Node")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cli-doctor.test.ts`
Expected: FAIL — `Failed to load ../src/cli/doctor.ts`.

- [ ] **Step 3: Write `src/cli/doctor.ts`**

Create `src/cli/doctor.ts`:

```ts
import { mkdirSync } from "node:fs"
import { loadConfig } from "../config.js"
import type { RunResult } from "../sbx.js"
import type { Ui } from "./ui.js"

export type CheckKind = "hard" | "advisory"

export interface CheckResult {
  name: string
  ok: boolean
  kind: CheckKind
  detail?: string
  fix?: string
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv
  home: string
  dataDir: string
  nodeVersion?: string
  runSbx?: (args: string[]) => Promise<RunResult>
  mkdir?: (path: string) => void
}

export function satisfiesNode(version: string): boolean {
  return Number.parseInt(version.split(".")[0] ?? "", 10) === 24
}

export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const runSbx = deps.runSbx
  const mkdir = deps.mkdir ?? ((path: string) => { mkdirSync(path, { recursive: true }) })
  const version = deps.nodeVersion ?? process.versions.node
  const results: CheckResult[] = []

  results.push(satisfiesNode(version)
    ? { name: "Node", ok: true, kind: "hard", detail: `v${version}` }
    : { name: "Node", ok: false, kind: "hard", detail: `v${version}`, fix: "Install Node 24: `fnm install 24` (or `nvm install 24`), then reopen your shell." })

  if (runSbx) {
    try {
      const result = await runSbx(["version"])
      results.push(result.code === 0
        ? { name: "sbx", ok: true, kind: "hard", detail: result.stdout.trim().split("\n")[0] ?? "installed" }
        : { name: "sbx", ok: false, kind: "hard", detail: result.stderr.trim() || `exit ${result.code}`, fix: "Install Docker Sandboxes: `winget install -h Docker.sbx`, then `sbx login`." })
    } catch (error) {
      results.push({ name: "sbx", ok: false, kind: "hard", detail: String(error), fix: "Install Docker Sandboxes: `winget install -h Docker.sbx`, then `sbx login`." })
    }
    try {
      const result = await runSbx(["policy", "ls"])
      results.push(result.code === 0
        ? { name: "Policy", ok: true, kind: "hard", detail: "initialized" }
        : { name: "Policy", ok: false, kind: "hard", detail: result.stderr.trim() || `exit ${result.code}`, fix: "Initialize the network policy: `sbx policy init balanced`." })
    } catch (error) {
      results.push({ name: "Policy", ok: false, kind: "hard", detail: String(error), fix: "Initialize the network policy: `sbx policy init balanced`." })
    }
  }

  try {
    loadConfig(deps.env)
    results.push({ name: "Config", ok: true, kind: "hard", detail: "token and guild IDs present" })
  } catch (error) {
    results.push({ name: "Config", ok: false, kind: "hard", detail: (error as Error).message, fix: "Set DISCORD_TOKEN and DISCORD_GUILD_IDS, or run `bot-celly setup`." })
  }

  try {
    mkdir(deps.home)
    mkdir(deps.dataDir)
    results.push({ name: "Storage", ok: true, kind: "hard", detail: deps.dataDir })
  } catch (error) {
    results.push({ name: "Storage", ok: false, kind: "hard", detail: String(error), fix: `Ensure ${deps.home} and ${deps.dataDir} are writable.` })
  }

  results.push({ name: "Provider secret", ok: true, kind: "advisory", detail: "register credentials once with `sbx secret set <provider>`" })
  return results
}

export function hasHardFailure(results: CheckResult[]): boolean {
  return results.some((result) => result.kind === "hard" && !result.ok)
}

export function reportDoctor(results: CheckResult[], ui: Ui): void {
  ui.heading("Celly doctor")
  for (const result of results) {
    const kind = !result.ok
      ? (result.kind === "advisory" ? "warn" : "fail")
      : (result.kind === "advisory" ? "info" : "ok")
    ui.status(kind, result.detail ? `${result.name} — ${result.detail}` : result.name)
    if (!result.ok && result.fix) ui.hint(result.fix)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cli-doctor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/doctor.ts test/cli-doctor.test.ts
git commit -m "feat(cli): add the prerequisite doctor"
```

---

### Task 5: First-run wizard

**Files:**
- Create: `src/cli/wizard.ts`
- Test: `test/cli-wizard.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `parseGuildIds` from `src/config.ts`; `Ui` from `src/cli/ui.ts`.
- Produces:
  - `interface Prompter { ask(question: string): Promise<string>; askSecret(question: string): Promise<string>; close(): void }`
  - `function createPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter`
  - `function mergeEnv(existing: string, updates: Record<string, string>): string`
  - `async function runWizard(deps: { env: NodeJS.ProcessEnv; envFile: string; ui: Ui; prompter: Prompter; readFile?: (path: string) => string; writeFile?: (path: string, data: string, options: { mode: number }) => void }): Promise<{ token: string; guilds: string[] }>`

- [ ] **Step 1: Write the failing tests**

Create `test/cli-wizard.test.ts`:

```ts
import { expect, test } from "vitest"
import { mergeEnv, runWizard } from "../src/cli/wizard.ts"
import { createUi } from "../src/cli/ui.ts"
import type { Prompter } from "../src/cli/wizard.ts"

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cli-wizard.test.ts`
Expected: FAIL — `Failed to load ../src/cli/wizard.ts`.

- [ ] **Step 3: Write `src/cli/wizard.ts`**

Create `src/cli/wizard.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs"
import { emitKeypressEvents } from "node:readline"
import { createInterface } from "node:readline/promises"
import { loadConfig, parseGuildIds } from "../config.js"
import type { Ui } from "./ui.js"

export interface Prompter {
  ask(question: string): Promise<string>
  askSecret(question: string): Promise<string>
  close(): void
}

export interface WizardDeps {
  env: NodeJS.ProcessEnv
  envFile: string
  ui: Ui
  prompter: Prompter
  readFile?: (path: string) => string
  writeFile?: (path: string, data: string, options: { mode: number }) => void
}

export interface WizardResult {
  token: string
  guilds: string[]
}

const GUILD_RE = /^\d{17,20}$/

export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : []
  const seen = new Set<string>()
  const out = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line)
    const key = match?.[1]
    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key)
      return `${key}=${updates[key]}`
    }
    return line
  })
  const missing = Object.keys(updates).filter((key) => !seen.has(key))
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("")
    for (const key of missing) out.push(`${key}=${updates[key]}`)
  }
  return out.join("\n").replace(/\n*$/, "\n")
}

export async function runWizard(deps: WizardDeps): Promise<WizardResult> {
  const { env, ui, prompter } = deps
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const writeFile = deps.writeFile ?? ((path: string, data: string, options: { mode: number }) => { writeFileSync(path, data, options) })

  ui.heading("Welcome to Celly")
  ui.bullet("I need two things: your Discord bot token and your guild IDs.")
  ui.hint(`I will save them to ${deps.envFile} and set the file mode to 600.`)
  ui.hint("Everything else has a sensible default.")

  let token = ""
  while (token.length === 0) {
    token = (await prompter.askSecret("Discord bot token: ")).trim()
    if (token.length === 0) ui.status("warn", "A token is required.")
  }

  let guilds: string[] = []
  for (;;) {
    const raw = (await prompter.ask("Discord guild IDs (comma-separated): ")).trim()
    let parsed: string[] | undefined
    try { parsed = parseGuildIds({ DISCORD_GUILD_IDS: raw }) } catch { parsed = undefined }
    const invalid = (parsed ?? []).filter((id) => !GUILD_RE.test(id))
    if (parsed && parsed.length > 0 && invalid.length === 0) { guilds = parsed; break }
    ui.status("warn", invalid.length > 0 ? `Not a guild ID: ${invalid.join(", ")}` : "Enter at least one guild ID.")
  }
  prompter.close()

  loadConfig({ ...env, DISCORD_TOKEN: token, DISCORD_GUILD_IDS: guilds.join(",") })

  let existing = ""
  try { existing = readFile(deps.envFile) } catch { existing = "" }
  writeFile(deps.envFile, mergeEnv(existing, { DISCORD_TOKEN: token, DISCORD_GUILD_IDS: guilds.join(",") }), { mode: 0o600 })

  env.DISCORD_TOKEN = token
  env.DISCORD_GUILD_IDS = guilds.join(",")
  ui.status("ok", `Saved config to ${deps.envFile}`)
  return { token, guilds }
}

export function createPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  const rl = createInterface({ input, output })
  return {
    ask: (question) => rl.question(question),
    askSecret: async (question) => {
      const stdin = input as NodeJS.ReadStream
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        output.write("(this terminal cannot hide input; the token will be visible)\n")
        return rl.question(question)
      }
      return new Promise<string>((resolve) => {
        output.write(question)
        let value = ""
        const wasRaw = Boolean(stdin.isRaw)
        emitKeypressEvents(stdin, rl)
        stdin.setRawMode(true)
        stdin.resume()
        const cleanup = (): void => {
          stdin.removeListener("keypress", onKeypress)
          stdin.setRawMode(wasRaw)
          stdin.pause()
        }
        const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }): void => {
          if (key.name === "return" || key.name === "enter") { cleanup(); output.write("\n"); resolve(value) }
          else if (key.ctrl && key.name === "c") { cleanup(); output.write("\n"); process.exit(130) }
          else if (key.name === "backspace") { if (value.length > 0) { value = value.slice(0, -1); output.write("\b \b") } }
          else if (str && !key.ctrl) { value += str }
        }
        stdin.on("keypress", onKeypress)
      })
    },
    close: () => rl.close(),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cli-wizard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `emitKeypressEvents(stdin, rl)` complains about types, cast: `emitKeypressEvents(stdin as NodeJS.ReadStream, rl as unknown as NodeJS.ReadableStream)`. Keep the cast local and add no comments.

- [ ] **Step 6: Commit**

```bash
git add src/cli/wizard.ts test/cli-wizard.test.ts
git commit -m "feat(cli): add the first-run setup wizard"
```

---

### Task 6: CLI entry and package metadata

**Files:**
- Create: `src/cli.ts`
- Modify: `src/index.ts:55` (`async function main()` → `export async function main()`)
- Modify: `package.json`
- Modify: `package-lock.json` (root `name`)
- Modify: `.changeset/*.md` (rename `"celly"` → `"bot-celly"`)
- Test: `test/package.test.ts`

**Interfaces:**
- Consumes: `parseArgs` (Task 1), `applyHome` (Task 2), `createUi` (Task 3), `runDoctor`/`reportDoctor`/`hasHardFailure` (Task 4), `createPrompter`/`runWizard` (Task 5), `SbxRunner` (`src/sbx.ts`), `main` (`src/index.ts`).
- Produces: the `dist/cli.js` bin.

- [ ] **Step 1: Export `main` from `src/index.ts`**

Change line 55 from:

```ts
async function main(): Promise<void> {
```

to:

```ts
export async function main(): Promise<void> {
```

- [ ] **Step 2: Write `src/cli.ts`**

Create `src/cli.ts` (the shebang must be the first line):

```ts
#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { parseArgs } from "./cli/args.js"
import { applyHome } from "./cli/home.js"
import { createUi } from "./cli/ui.js"
import { createPrompter, runWizard } from "./cli/wizard.js"
import { hasHardFailure, reportDoctor, runDoctor } from "./cli/doctor.js"
import { SbxRunner } from "./sbx.js"
import { main } from "./index.js"

const HELP = `Celly — a Discord control surface for OpenCode

Usage: bot-celly [command] [flags]

Commands:
  (none)      Set up on first run, then start the bot
  setup       Re-run the setup wizard
  doctor      Check host prerequisites and configuration
  --version   Print the version
  --help      Show this help

Flags:
  --token <value>    Discord bot token (headless)
  --guilds <a,b,c>   Comma-separated guild IDs (headless)
  --home <dir>       Config and data directory (default ~/.bot-celly)
  --run              With setup, start the bot after setup`

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
  return pkg.version
}

function configPresent(env: NodeJS.ProcessEnv): boolean {
  const token = env.DISCORD_TOKEN?.trim()
  const guilds = env.DISCORD_GUILD_IDS?.trim() || env.DISCORD_GUILD_ID?.trim()
  return Boolean(token) && Boolean(guilds)
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const ui = createUi()
  if (!parsed.ok) {
    ui.status("fail", parsed.message)
    console.error(`\n${HELP}`)
    process.exit(2)
  }
  const { options } = parsed
  if (options.command === "version") { console.log(version()); return }
  if (options.command === "help") { console.log(HELP); return }

  if (options.token !== undefined) process.env.DISCORD_TOKEN = options.token
  if (options.guilds !== undefined) process.env.DISCORD_GUILD_IDS = options.guilds
  if (options.home !== undefined) process.env.CELLY_HOME = options.home

  const applied = applyHome({ env: process.env })

  const needsWizard = options.command === "setup" || !configPresent(process.env)
  if (needsWizard) {
    if (!process.stdin.isTTY && options.command !== "setup") {
      ui.status("fail", "No config found and stdin is not a TTY.")
      ui.hint(`Pass --token and --guilds, or write ${applied.envFile} yourself.`)
      process.exit(1)
    }
    const prompter = createPrompter(process.stdin, process.stdout)
    await runWizard({ env: process.env, envFile: applied.envFile, ui, prompter })
  }

  const runner = new SbxRunner()
  const results = await runDoctor({
    env: process.env,
    home: applied.home,
    dataDir: applied.dataDir,
    runSbx: (args) => runner.run(args),
  })
  reportDoctor(results, ui)

  if (options.command === "doctor") process.exit(hasHardFailure(results) ? 1 : 0)
  if (hasHardFailure(results)) {
    ui.status("fail", "Fix the items above, then run `bot-celly` again.")
    process.exit(1)
  }
  if (options.command === "setup" && !options.run) {
    ui.status("ok", "Setup complete. Run `bot-celly` to start.")
    return
  }
  await main()
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 3: Update `package.json`**

Apply these exact changes:

- `"name": "celly"` → `"name": "bot-celly"`.
- Remove the `"private": true,` line.
- After `"start"`, add: `"prepack": "npm run build",` and `"prepublishOnly": "npm test && npm run typecheck",`.
- Add top-level `"bin": { "bot-celly": "dist/cli.js" },`.
- Add top-level `"files": ["dist", "assets"],`.
- Add top-level `"publishConfig": { "access": "public", "provenance": true },`.
- Add top-level `"repository": { "type": "git", "url": "git+https://github.com/LegendArtur/bot-celly.git" },`, `"homepage": "https://celly.agub.dev",`, and `"bugs": { "url": "https://github.com/LegendArtur/bot-celly/issues" },`.
- Keep `"license": "MIT"` and `"engines": { "node": ">=24 <25" }` unchanged.

The resulting `package.json` must parse as JSON and contain `name`, `bin`, `files`, and `publishConfig` exactly as above.

- [ ] **Step 4: Regenerate the lockfile name**

`npm ci` in CI requires `package-lock.json` to match `package.json`. After the
rename, run:

```bash
npm install --package-lock-only
head -3 package-lock.json
```

Expected: the first lines are `{`, `"name": "bot-celly",`, `"version": "0.2.0",`.

- [ ] **Step 5: Rename the package in the pending changesets**

The eight unreleased changesets in `.changeset/*.md` reference the old package
name and would break `changeset version`. Rewrite their frontmatter:

```bash
for file in .changeset/*.md; do
  node -e "const fs=require('fs');const p=process.argv[1];const s=fs.readFileSync(p,'utf8').replace(/\"celly\":/g,'\"bot-celly\":');fs.writeFileSync(p,s)" "$file"
done
grep -l '"celly"' .changeset/*.md || echo "no stale package references"
```

Expected: `grep` prints `no stale package references`.

- [ ] **Step 6: Write `test/package.test.ts`**

Create `test/package.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { expect, test } from "vitest"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>

test("is publishable as bot-celly", () => {
  expect(pkg.name).toBe("bot-celly")
  expect(pkg.private).not.toBe(true)
  expect(pkg.bin).toEqual({ "bot-celly": "dist/cli.js" })
  expect(pkg.files).toEqual(["dist", "assets"])
  expect(pkg.publishConfig).toMatchObject({ access: "public", provenance: true })
  expect((pkg.repository as { url: string }).url).toBe("git+https://github.com/LegendArtur/bot-celly.git")
})

test("ships the admin assets the server reads from the package root", () => {
  expect(existsSync(new URL("../assets/admin/htmx.min.js", import.meta.url))).toBe(true)
})

test("the bin target is built from src/cli.ts", () => {
  expect(existsSync(new URL("../src/cli.ts", import.meta.url))).toBe(true)
})
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run test/package.test.ts && npm run typecheck`
Expected: PASS (3 tests) and no type errors.

- [ ] **Step 8: Build and smoke the bin locally**

Run:
```bash
npm run build
node dist/cli.js --version
node dist/cli.js --help
```
Expected: `--version` prints `0.2.0` (or the current version); `--help` prints the usage text; both exit 0 and neither touches the network. Confirm the compiled file starts with `#!/usr/bin/env node`:

Run: `head -1 dist/cli.js`
Expected: `#!/usr/bin/env node`

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts src/index.ts package.json package-lock.json .changeset test/package.test.ts
git commit -m "feat(cli): ship the bot-celly entry point and package metadata"
```

---

### Task 7: Release workflow, changeset config, and changeset

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.changeset/config.json` (`"access": "restricted"` → `"access": "public"`)
- Create: `.changeset/npx-one-line-install.md`

**Interfaces:**
- Consumes: the `prepack`/`prepublishOnly` scripts and `publishConfig` from Task 6.
- Produces: tag-triggered npm publishing.

- [ ] **Step 1: Create the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    name: publish to npm
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm publish
```

- [ ] **Step 2: Set changeset access to public**

In `.changeset/config.json`, change:

```json
  "access": "restricted",
```

to:

```json
  "access": "public",
```

- [ ] **Step 3: Add the changeset**

Create `.changeset/npx-one-line-install.md`:

```markdown
---
"bot-celly": minor
---

Add `npx bot-celly@latest`: a guided first-run setup for the Discord token and
guild IDs, a `bot-celly doctor` prerequisite check, a hidden-token wizard, and a
`setup`/`help`/`version` CLI surface. Config and data now default to
`~/.bot-celly` (override with `CELLY_HOME`), and the package publishes to npm as
`bot-celly`.
```

- [ ] **Step 4: Verify the changeset and config parse**

Run: `npx changeset status --output /tmp/celly-changeset.json && cat /tmp/celly-changeset.json`
Expected: exits 0 and lists `bot-celly` with a `minor` bump. (If `changeset status` requires a base branch, run it from the `one-line-install` branch where `main` exists; otherwise skip the run and visually confirm the frontmatter.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml .changeset/config.json .changeset/npx-one-line-install.md
git commit -m "ci: publish bot-celly to npm on a version tag"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs-site/quickstart.mdx`
- Modify: `docs-site/guides/configuration.mdx`
- Modify: `docs-site/guides/deployment.mdx`
- Modify: `docs-site/guides/deployment-linux.mdx`
- Modify: `docs-site/reference/limitations.mdx`
- Modify: `docs-site/project/roadmap.mdx`
- Modify: `docs-site/reference/commands.mdx`
- Modify: `docs-site/docs.json`
- Create: `docs-site/reference/cli.mdx`

**Interfaces:**
- Consumes: the CLI surface from Tasks 1–6.
- Produces: user-facing docs and the agent readme.

- [ ] **Step 1: README quick start**

Replace README lines 151–166 (the current steps 2 and 3) with:

````markdown
2. **Install and run:**

   ```powershell
   npx bot-celly@latest
   ```

   The first run asks for your **Discord bot token** and **guild IDs**, saves
   them to `~/.bot-celly/.env` (`%USERPROFILE%\.bot-celly\.env` on Windows,
   override with `CELLY_HOME`), checks that `sbx` is installed and its network
   policy is initialized, then starts the bot. `PROJECTS_ROOT` defaults to
   `~/Celly/projects`. Re-run the same command to start; `npx bot-celly doctor`
   diagnoses the host without starting; `npx bot-celly setup` reconfigures.
   Prefer a source checkout? See [Development](#development).

3. In Discord, run `/project add name:<name> path:<path>` and send a message in
   the new channel.
````

- [ ] **Step 2: README Development and roadmap/limitations**

In the `## Development` section (after the existing script block), add:

````markdown
The published CLI is the same code: `npx bot-celly@latest` runs `dist/cli.js`,
which sets up `~/.bot-celly` and then calls `dist/index.js`. To exercise it from
a checkout, run `npm run build && npx bot-celly` (requires Node 24).
````

In `## Status and roadmap`, delete the one-line-install bullet (the two lines
starting `- **One-line install.**`).

In `## Limitations`, add a bullet after the "Host-only items" bullet:

```markdown
- **The one-line install uses npm.** `npx bot-celly@latest` still requires Node
  24 and a host with `sbx` installed, logged in, and policy-initialized.
```

- [ ] **Step 3: AGENTS.md**

In the `## Commands` code block, add after the `npx changeset` line:

```bash
npx changeset version # bump the version and sync the changelog
```

Add a new paragraph after the Commands block:

```markdown
Releases are tag-driven: run `npx changeset version`, commit the bump, then
`git tag v<version> && git push origin v<version>`. The tag triggers
`.github/workflows/release.yml`, which publishes `bot-celly` to npm with Trusted
Publishing (OIDC). Do not run `npm publish` by hand once Trusted Publishing is
configured.
```

In the **Definition of done** list, extend item 2 with:

```markdown
   When cutting a release, bump via changesets and push the `v*` tag instead of
   publishing manually.
```

In the documentation table, add a row:

```markdown
| CLI command, flag, or install path | `docs-site/reference/cli.mdx`, the README quick start, and `docs-site/quickstart.mdx` |
```

- [ ] **Step 4: `docs-site/quickstart.mdx`**

Replace the `<Step title="Clone and install">` and `<Step title="Configure .env">` blocks with a single step:

````mdx
  <Step title="Install and configure">
    ```powershell
    npx bot-celly@latest
    ```

    The first run asks for your **Discord bot token** and **guild IDs** and saves
    them to `~/.bot-celly/.env`. `PROJECTS_ROOT` defaults to `~/Celly/projects`
    (created on boot). Re-run the command to start again; `npx bot-celly doctor`
    checks the host without starting.

    <Accordion title="From source">
      ```powershell
      git clone https://github.com/LegendArtur/bot-celly.git
      cd bot-celly
      npm ci
      npm run build
      copy .env.example .env    # macOS/Linux: cp .env.example .env
      node dist/index.js
      ```
    </Accordion>
  </Step>
````

Update the `<Step title="Run the bot">` block to remove the `node dist/index.js`
line (running the bot is now step 2), keeping the preflight note.

- [ ] **Step 5: `docs-site/guides/configuration.mdx`**

In the intro paragraph, add after the first sentence:

```markdown
When Celly is started through `npx bot-celly`, `.env` is read from
`~/.bot-celly/.env` (Windows: `%USERPROFILE%\.bot-celly\.env`) instead of the
current directory, and `DATA_DIR` defaults to `~/.bot-celly/data`. Set
`CELLY_HOME` to move that directory.
```

In the Variables table, add a row above `DISCORD_TOKEN`:

```markdown
| `CELLY_HOME` | `~/.bot-celly` | Directory holding `.env` and, by default, `DATA_DIR`. |
```

Change the `DATA_DIR` row default from `` `./data` `` to `` `~/.bot-celly/data` when launched via the CLI, else `./data` ``.

- [ ] **Step 6: Deployment guides**

In `docs-site/guides/deployment.mdx`, replace section `## 2. Build and configure the bot` steps 1–3 with:

````markdown
## 2. Install and configure the bot

1. Install Node 24 (see the host bootstrap in the [Quickstart](/quickstart)).
2. Install and run Celly once in the foreground to confirm it boots:
   ```powershell
   npx bot-celly@latest
   ```
   The wizard saves `~/.bot-celly/.env`. On boot Celly performs a preflight
   (`sbx version`, policy check, single-instance lock) and fails fast with an
   actionable message. Logs are written to `~/.bot-celly/data/bot.log`.
````

Keep the rest of the section (Task Scheduler) but change the `$action`/`-Argument`
and `-WorkingDirectory` guidance to launch the package instead of the repo. Use:

```powershell
$node    = (Get-Command node).Source
$cli     = "$env:APPDATA\npm\node_modules\bot-celly\dist\cli.js"
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`"" -WorkingDirectory $env:USERPROFILE
```

Add one sentence: "Install globally first (`npm install -g bot-celly`) so the CLI
path is stable."

In `docs-site/guides/deployment-linux.mdx`, replace section `## 2. Build and configure` with:

````markdown
## 2. Install and configure

```bash
npx bot-celly@latest   # first foreground boot; Ctrl-C once it is ready
```

The wizard writes `~/.bot-celly/.env`. The required values are documented in
[Configuration](/guides/configuration).
````

In the systemd unit, change `ExecStart` to run the installed CLI:

```ini
ExecStart=/bin/bash -lc 'exec bot-celly'
```

Add one sentence before the unit: "Install globally first with
`npm install -g bot-celly`."

- [ ] **Step 7: New CLI reference page**

Create `docs-site/reference/cli.mdx`:

````mdx
---
title: CLI
description: The bot-celly command-line interface — install, setup, doctor, and headless flags.
---

Celly installs and runs through the `bot-celly` CLI on the host. It requires
Node 24 and the host prerequisites in the [Quickstart](/quickstart).

```bash
npx bot-celly@latest
```

## Commands

| Command | What it does |
| --- | --- |
| `bot-celly` | Set up on first run (wizard), check the host, then start the bot. |
| `bot-celly setup` | Re-run the setup wizard. Add `--run` to start after setup. |
| `bot-celly doctor` | Check prerequisites and configuration; never starts the bot. |
| `bot-celly --version` · `-v` | Print the version. |
| `bot-celly --help` · `-h` | Show usage. |

## Flags

| Flag | Purpose |
| --- | --- |
| `--token <value>` | Discord bot token, for headless setup. |
| `--guilds <a,b,c>` | Comma-separated guild IDs, for headless setup. |
| `--home <dir>` | Config and data directory; same as `CELLY_HOME`. |
| `--run` | With `setup`, start the bot after setup. |

## Configuration and data

The wizard writes `~/.bot-celly/.env` (Windows:
`%USERPROFILE%\.bot-celly\.env`) with mode `600`. `DATA_DIR` defaults to
`~/.bot-celly/data`; `PROJECTS_ROOT` still defaults to `~/Celly/projects`. Set
`CELLY_HOME` to move the directory. See
[Configuration](/guides/configuration) for every variable.

## Exit codes

`0` success, `1` an operational failure (missing prerequisite or config), `2` a
usage error (unknown command or flag).

## Related

- [Quickstart](/quickstart) — the host bootstrap and first project.
- [Commands](/reference/commands) — the Discord command surface.
````

- [ ] **Step 8: Nav, commands cross-link, limitations, roadmap**

In `docs-site/docs.json`, add `"reference/cli"` to the Reference group, before `"reference/commands"`.

In `docs-site/reference/commands.mdx`, add a note near the top (after frontmatter):

```mdx
> Installing and running Celly is a host action, not a Discord command. See the
> [CLI reference](/reference/cli) for `npx bot-celly`, `setup`, and `doctor`.
```

In `docs-site/reference/limitations.mdx`, add a bullet after the "Some checks are host-only" bullet:

```markdown
- **The one-line install uses npm and still needs the host.** `npx bot-celly`
  requires Node 24 and a host with `sbx` installed, logged in, and
  policy-initialized; it never installs host software.
```

In `docs-site/project/roadmap.mdx`, delete the `- **One-line install.**` bullet
and update the frontmatter `description` to drop "install ergonomics".

- [ ] **Step 9: Validate docs and commit**

Run: `npm run docs:validate && npm run docs:links`
Expected: both pass (Mintlify validates the new page and finds no broken links).

```bash
git add README.md AGENTS.md docs-site .changeset
git commit -m "docs: document the npx one-line install"
```

---

### Task 9: End-to-end packaging verification

**Files:**
- No source changes; this task verifies the built package.

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: confidence that the published tarball runs.

- [ ] **Step 1: Full suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green (existing 737 + the new CLI tests; 0 failures).

- [ ] **Step 2: Inspect the packed tarball**

Run:
```bash
npm pack --dry-run
```
Expected: the file list includes `dist/cli.js`, `dist/index.js`, `dist/admin/assets.js`, `assets/admin/htmx.min.js`, `assets/admin/app.css`, `README.md`, and `LICENSE`; it does **not** include `src/`, `test/`, or `node_modules/`.

- [ ] **Step 3: Install the tarball into a scratch project and run the safe commands**

Run:
```bash
npm pack
TARBALL="$(pwd)"/bot-celly-*.tgz
rm -rf /tmp/celly-pack && mkdir -p /tmp/celly-pack && cd /tmp/celly-pack
npm init -y >/dev/null
npm install "$TARBALL"
npx bot-celly --version
npx bot-celly --help
npx bot-celly doctor
```

Expected:
- `--version` prints the package version and exits `0`.
- `--help` prints the usage text and exits `0`.
- `doctor` prints the check table. On a host without Node 24/`sbx` it exits `1`
  with the fix lines; on a ready host it exits `0`. Either is acceptable here —
  what matters is that it does not crash and does not start the bot.

- [ ] **Step 4: Confirm the argv-only invariant**

Run: `grep -rn "child_process" src` and confirm the only match is `src/sbx.ts`.
Expected: exactly one file.

- [ ] **Step 5: Remove the scratch artifacts and commit any doc corrections**

From the repository root (return to it first if Step 3 left you in `/tmp`):

```bash
rm -f bot-celly-*.tgz
rm -rf /tmp/celly-pack
```
If Step 2–4 surfaced a docs inaccuracy, fix it and commit with `docs:`; otherwise:

```bash
git status --short
```
Expected: clean working tree (the tarball is removed and `.gitignore` already
ignores build output).

---

## Self-Review

**Spec coverage:**
- Workstream A (packaging/entries) → Tasks 5–7.
- Workstream B (home/env) → Task 2.
- Workstream C (wizard) → Task 5.
- Workstream D (doctor) → Task 4.
- Workstream E (presentation) → Task 3.
- Workstream F (CLI surface/headless) → Tasks 1, 6.
- Workstream G (boot integration) → Tasks 2, 6.
- Workstream H (release/CI) → Task 7.
- Workstream I (tests) → each task's test file; `test/package.test.ts` in Task 6.
- Workstream J (docs/changeset) → Tasks 7–8.
- Operator steps are outside the code and called out in the spec; Task 9 verifies
  the artifact they will publish.

**Placeholder scan:** no `TBD`/`TODO`; every code step contains the full file or
exact replacement.

**Type consistency:** `CliOptions.run` (Task 1) is read in Task 6; `ApplyHomeResult`
(Task 2) fields `home`/`envFile`/`dataDir` feed Tasks 4 and 6; `CheckResult`
(Task 4) is consumed by `reportDoctor` and Task 6; `Prompter`/`WizardResult`
(Task 5) feed Task 6; `Ui`/`StatusKind` (Task 3) feed Tasks 4–6. Names match
across tasks.

**Known deviation from the spec:** the spec's Workstream D says "doctor runs
first, then the wizard"; the plan runs the wizard first when config is missing,
then doctor, because the config check is itself a doctor item and the wizard is
what satisfies it. Boot is still gated by doctor, which matches the intent.

**Rename fallout:** changing the package name is not cosmetic. Task 6 regenerates
the lockfile name (or `npm ci` fails) and rewrites the package key in all eight
pending changesets (or `changeset version` fails). Both are inside Task 6's
commit so the tree is consistent at every commit.
