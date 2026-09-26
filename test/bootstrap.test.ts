import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { BOOTSTRAP_PREPARE, BOOTSTRAP_VERIFY, buildBootstrapInstallScript } from "../src/opencode.ts"

const onWindows = process.platform === "win32"

function inline(script: string, home: string) {
  return spawnSync("bash", ["-lc", script], { env: { ...process.env, HOME: home }, encoding: "utf8" })
}
function install(input: string, home: string) {
  return spawnSync("bash", ["-s"], { input, env: { ...process.env, HOME: home }, encoding: "utf8" })
}

// Host-only in the sense that it needs bash; it runs in the Linux dev sandbox.
// Mirrors the real flow: prepare the dir, then write config/env as the sandbox
// user with the install script on stdin (0600 via umask), then verify. This is
// what replaced the /tmp `mv` and the root-owned `sbx cp` + `chmod` paths.
test.skipIf(onWindows)("bootstrap install script writes a 0600 config/env idempotently", () => {
  const home = mkdtempSync(join(tmpdir(), "celly-home-"))
  const dest = join(home, ".config", "celly")
  try {
    expect(inline(BOOTSTRAP_PREPARE, home).status).toBe(0)

    const first = install(buildBootstrapInstallScript("secret-password"), home)
    expect(first.stderr).toBe("")
    expect(first.status).toBe(0)

    expect(statSync(join(dest, "opencode.json")).mode & 0o777).toBe(0o600)
    expect(statSync(join(dest, "opencode.env")).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dest, "opencode.env"), "utf8")).toContain("OPENCODE_SERVER_PASSWORD=secret-password")
    expect(readFileSync(join(dest, "opencode.json"), "utf8")).toContain('"permission"')

    expect(inline(BOOTSTRAP_VERIFY, home).status).toBe(0)

    // Idempotent: prepare + re-install over the same HOME.
    expect(inline(BOOTSTRAP_PREPARE, home).status).toBe(0)
    expect(install(buildBootstrapInstallScript("another-password"), home).status).toBe(0)
    expect(readFileSync(join(dest, "opencode.env"), "utf8")).toContain("OPENCODE_SERVER_PASSWORD=another-password")

    // Verify must fail closed when the config is missing.
    rmSync(dest, { recursive: true, force: true })
    expect(inline(BOOTSTRAP_VERIFY, home).status).not.toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
