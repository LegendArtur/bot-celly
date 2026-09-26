import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { BOOTSTRAP_FINALIZE, BOOTSTRAP_PREPARE, BOOTSTRAP_VERIFY, buildCellyConfigJson, buildOpencodeEnv } from "../src/opencode.ts"

const onWindows = process.platform === "win32"

function runScript(script: string, home: string) {
  return spawnSync("bash", ["-lc", script], { env: { ...process.env, HOME: home }, encoding: "utf8" })
}

// Host-only in the sense that it needs bash; it runs in the Linux dev sandbox.
// The sandbox `sbx cp` step is host-side, so it is simulated by copying the files
// into $HOME/.config/celly directly (never through the sandbox's /tmp, which
// denies the move in real sbx sandboxes).
test.skipIf(onWindows)("bootstrap prepare + copy + finalize installs a 0600 config/env idempotently", () => {
  const home = mkdtempSync(join(tmpdir(), "celly-home-"))
  const stageDir = mkdtempSync(join(tmpdir(), "celly-stage-"))
  const json = join(stageDir, "opencode.json")
  const env = join(stageDir, "opencode.env")
  const dest = join(home, ".config", "celly")
  try {
    writeFileSync(json, buildCellyConfigJson(), { mode: 0o600 })
    writeFileSync(env, buildOpencodeEnv("secret-password"), { mode: 0o600 })

    expect(runScript(BOOTSTRAP_PREPARE, home).status).toBe(0)

    // Simulate `sbx cp <host file> <sandbox>:$HOME/.config/celly/<name>`.
    cpSync(json, join(dest, "opencode.json"))
    cpSync(env, join(dest, "opencode.env"))

    const finalize = runScript(BOOTSTRAP_FINALIZE, home)
    expect(finalize.stderr).toBe("")
    expect(finalize.status).toBe(0)

    expect(statSync(join(dest, "opencode.json")).mode & 0o777).toBe(0o600)
    expect(statSync(join(dest, "opencode.env")).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dest, "opencode.env"), "utf8")).toContain("OPENCODE_SERVER_PASSWORD=secret-password")
    expect(readFileSync(join(dest, "opencode.json"), "utf8")).toContain('"permission"')

    expect(runScript(BOOTSTRAP_VERIFY, home).status).toBe(0)

    // Idempotent: prepare + re-copy + finalize over the same HOME.
    expect(runScript(BOOTSTRAP_PREPARE, home).status).toBe(0)
    cpSync(json, join(dest, "opencode.json"))
    cpSync(env, join(dest, "opencode.env"))
    expect(runScript(BOOTSTRAP_FINALIZE, home).status).toBe(0)
    expect(statSync(join(dest, "opencode.env")).mode & 0o777).toBe(0o600)

    // Verify must fail closed when the config is missing.
    rmSync(dest, { recursive: true, force: true })
    expect(runScript(BOOTSTRAP_VERIFY, home).status).not.toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(stageDir, { recursive: true, force: true })
  }
})
