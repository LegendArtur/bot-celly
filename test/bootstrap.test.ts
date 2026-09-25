import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { BOOTSTRAP_SCRIPT, BOOTSTRAP_VERIFY, buildCellyConfigJson, buildOpencodeEnv } from "../src/opencode.ts"

const STAGED_JSON = "/tmp/celly-opencode.json"
const STAGED_ENV = "/tmp/celly-opencode.env"
const onWindows = process.platform === "win32"

function stage(json: string, env: string): void {
  cpSync(json, STAGED_JSON)
  cpSync(env, STAGED_ENV)
}
function runScript(script: string, home: string) {
  return spawnSync("bash", ["-lc", script], { env: { ...process.env, HOME: home }, encoding: "utf8" })
}

// Host-only in the sense that it needs bash; it runs in the Linux dev sandbox.
test.skipIf(onWindows)("bootstrap script installs the celly config and a 0600 env file, idempotently", () => {
  const home = mkdtempSync(join(tmpdir(), "celly-home-"))
  const stageDir = mkdtempSync(join(tmpdir(), "celly-stage-"))
  const json = join(stageDir, "opencode.json")
  const env = join(stageDir, "opencode.env")
  try {
    writeFileSync(json, buildCellyConfigJson(), { mode: 0o600 })
    writeFileSync(env, buildOpencodeEnv("secret-password"), { mode: 0o600 })
    stage(json, env)
    const first = runScript(BOOTSTRAP_SCRIPT, home)
    expect(first.stderr).toBe("")
    expect(first.status).toBe(0)

    const installedJson = join(home, ".config", "celly", "opencode.json")
    const installedEnv = join(home, ".config", "celly", "opencode.env")
    expect(existsSync(installedJson)).toBe(true)
    expect(existsSync(installedEnv)).toBe(true)
    expect(statSync(installedEnv).mode & 0o777).toBe(0o600)
    expect(readFileSync(installedEnv, "utf8")).toContain("OPENCODE_SERVER_PASSWORD=secret-password")
    expect(readFileSync(installedJson, "utf8")).toContain('"permission"')

    // Idempotent: a second run over the same HOME overwrites cleanly.
    stage(json, env)
    expect(runScript(BOOTSTRAP_SCRIPT, home).status).toBe(0)
    expect(statSync(installedEnv).mode & 0o777).toBe(0o600)

    expect(runScript(BOOTSTRAP_VERIFY, home).status).toBe(0)

    // The verify step must fail closed when the config is missing.
    rmSync(join(home, ".config", "celly"), { recursive: true, force: true })
    expect(runScript(BOOTSTRAP_VERIFY, home).status).not.toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(stageDir, { recursive: true, force: true })
    rmSync(STAGED_JSON, { force: true })
    rmSync(STAGED_ENV, { force: true })
  }
})
