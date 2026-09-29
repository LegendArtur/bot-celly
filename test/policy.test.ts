import { expect, test } from "vitest"
import { decidePermission, evaluatePermission, normalizeCommand, scanShellCommands } from "../src/policy.ts"

test("rejects deny-listed bash patterns", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["git push origin main"] }, ["git push*"])).toBe("reject")
})
test("allows non-matching patterns once", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["npm test"] }, ["git push*"])).toBe("once")
})
test("rejects non-bash tools by default (external_directory etc.)", () => {
  expect(evaluatePermission({ tool: "external_directory", patterns: [] }, [])).toBe("reject")
})
test("rejects default deny-listed publish and clean commands", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["npm publish --access public"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["git clean -fdx ."] })).toBe("reject")
})
test("allows an allowed tool with no deny matches", () => {
  expect(evaluatePermission({ tool: "read", patterns: [] })).toBe("once")
})
test("allows the real opencode tool ids surfaced in permission requests", () => {
  const tools = ["list", "patch", "todowrite", "todoread", "multiedit", "write", "glob", "grep",
    "webfetch", "websearch", "task", "skill", "lsp", "doom_loop", "edit"]
  for (const tool of tools) expect(evaluatePermission({ tool, patterns: [] })).toBe("once")
})
test("still rejects a genuinely unknown tool", () => {
  expect(evaluatePermission({ tool: "totally_unknown_tool", patterns: [] })).toBe("reject")
})

test("normalizes commands before deny matching", () => {
  expect(normalizeCommand("  git    -c   x=y   push  ")).toBe("git push")
  expect(normalizeCommand("env FOO=bar git push")).toBe("git push")
  expect(normalizeCommand("/usr/bin/git push")).toBe("git push")
})

test("wrapper and global-option bypasses are still rejected", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["git -c x=y push origin"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["command git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env FOO=bar git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["npx npm publish"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["/usr/bin/git push"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["git   push   origin"] })).toBe("reject")
})

test("adversarial wrapper and env-prefix variants cannot bypass the deny list", () => {
  const variants = [
    "env -i git push",
    "env -u FOO git push",
    "env FOO=bar git push",
    "FOO=bar git push",
    "sudo -u x git push",
    "nice -n 10 git push",
    "time -p git push",
    "command -p git push",
    "npx --yes npm publish",
    "bash -c 'git push'",
    "bash -lc 'git push'",
    "sh -c 'npm publish --access public'",
    "env -i bash -c 'git clean -fdx .'",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("reject")
  }
})

test("normalization keeps benign wrapped commands allowed", () => {
  const variants = [
    "env -i npm test",
    "FOO=bar npm test",
    "sudo -u x git status",
    "nice -n 10 git status",
    "time -p git status",
    "command -p git status",
    "npx --yes tsc --noEmit",
    "bash -c 'npm test'",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("once")
  }
})

test("wrapper commands with no payload still match their deny pattern", () => {
  expect(normalizeCommand("env")).toBe("env")
  expect(normalizeCommand("env -i")).toBe("env")
  expect(evaluatePermission({ tool: "bash", patterns: ["env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env -i"] })).toBe("reject")
})

test("normalization does not deny benign wrapped commands", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["npx tsc --noEmit"] })).toBe("once")
  expect(evaluatePermission({ tool: "bash", patterns: ["git status"] })).toBe("once")
})

test("rejects environment-inspection deny patterns", () => {
  expect(evaluatePermission({ tool: "bash", patterns: ["printenv"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["printenv PATH"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["cat ~/.config/celly/opencode.env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "bash", patterns: ["cat /root/.config/celly/opencode.env"] })).toBe("reject")
})

test("rejects the broadened env-inspection utilities against the celly config", () => {
  const commands = [
    "head -n 5 ~/.config/celly/opencode.env",
    "tail -1 ~/.config/celly/opencode.env",
    "base64 ~/.config/celly/opencode.env",
    "xxd ~/.config/celly/opencode.env",
    "od -c ~/.config/celly/opencode.env",
    "strings ~/.config/celly/opencode.env",
    "cp ~/.config/celly/opencode.env /tmp/leak",
    "less ~/.config/celly/opencode.env",
    "grep OPENCODE_SERVER_PASSWORD ~/.config/celly/opencode.env",
    "sed -n 1p ~/.config/celly/opencode.env",
    "awk '{print}' ~/.config/celly/opencode.env",
    "head -n 5 /root/.config/celly/other.json",
    "env -i cat ~/.config/celly/opencode.env",
  ]
  for (const command of commands) {
    expect(evaluatePermission({ tool: "bash", patterns: [command] }), command).toBe("reject")
  }
})

test("rejects read and grep tool paths into the celly config directory", () => {
  expect(evaluatePermission({ tool: "read", patterns: ["/root/.config/celly/opencode.env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "grep", patterns: ["/home/u/.config/celly/*"] })).toBe("reject")
  expect(evaluatePermission({ tool: "read", patterns: ["opencode.env"] })).toBe("reject")
  expect(evaluatePermission({ tool: "read", patterns: ["/srv/project/README.md"] })).toBe("once")
})

test("decidePermission keeps today's policy under auto", () => {
  expect(decidePermission("auto", { tool: "bash", patterns: ["npm test"] })).toBe("once")
  expect(decidePermission("auto", { tool: "bash", patterns: ["git push origin main"] })).toBe("reject")
})

test("decidePermission plan allows only read-only tools", () => {
  for (const tool of ["read", "glob", "grep", "list", "find"]) {
    expect(decidePermission("plan", { tool, patterns: [] }), tool).toBe("once")
  }
  for (const tool of ["bash", "edit", "write", "patch", "external_directory", "webfetch", "task", "totally_unknown_tool"]) {
    expect(decidePermission("plan", { tool, patterns: [] }), tool).toBe("reject")
  }
  expect(decidePermission("plan", { tool: "read", patterns: ["/root/.config/celly/opencode.env"] })).toBe("reject")
})

test("decidePermission buttons auto-allows read-only tools, asks for mutations, and still rejects deny-listed or unknown tools", () => {
  expect(decidePermission("buttons", { tool: "read", patterns: [] })).toBe("once")
  expect(decidePermission("buttons", { tool: "bash", patterns: ["npm test"] })).toBe("ask")
  expect(decidePermission("buttons", { tool: "edit", patterns: ["src/a.ts"] })).toBe("ask")
  expect(decidePermission("buttons", { tool: "bash", patterns: ["git push origin main"] })).toBe("reject")
  expect(decidePermission("buttons", { tool: "totally_unknown_tool", patterns: [] })).toBe("reject")
})

test("splits every top-level command separator", () => {
  for (const input of ["echo hi; git push", "true && npm publish", "a || b", "printf x | grep y", "a & b", "one\ntwo"]) {
    const scan = scanShellCommands(input)
    expect(scan.ok, input).toBe(true)
    expect(scan.ok && scan.commands.length, input).toBe(2)
  }
})

test("ignores separators inside quotes", () => {
  const scan = scanShellCommands(`git commit -m "fix: a; git push" && git status`)
  expect(scan.ok).toBe(true)
  expect(scan.ok && scan.commands).toEqual([`git commit -m "fix: a; git push"`, "git status"])
})

test("extracts command substitutions and backticks recursively", () => {
  const scan = scanShellCommands("echo $(echo $(printenv)) `npm publish`")
  expect(scan.ok).toBe(true)
  expect(scan.ok && scan.commands).toContain("printenv")
  expect(scan.ok && scan.commands).toContain("npm publish")
})

test("single-quoted substitutions and separators are literal", () => {
  const scan = scanShellCommands("echo '$(git push); git push'")
  expect(scan.ok).toBe(true)
  expect(scan.ok && scan.commands).toEqual(["echo '$(git push); git push'"])
})

test("quoted heredocs are skipped and unquoted heredocs are scanned for substitutions", () => {
  const quoted = scanShellCommands("cat <<'EOF'\n$(printenv)\ngit push\nEOF")
  expect(quoted.ok).toBe(true)
  expect(quoted.ok && quoted.commands).toEqual(["cat <<'EOF'\n$(printenv)\ngit push\nEOF"])
  const unquoted = scanShellCommands("cat <<EOF\n$(printenv)\nEOF")
  expect(unquoted.ok).toBe(true)
  expect(unquoted.ok && unquoted.commands).toContain("printenv")
})

test("here-strings are not treated as heredocs", () => {
  const literal = scanShellCommands("cat <<< \"literal\"")
  expect(literal.ok).toBe(true)
  expect(literal.ok && literal.commands).toEqual(["cat <<< \"literal\""])
  const chained = scanShellCommands("cat <<< \"literal\"; git push")
  expect(chained.ok).toBe(true)
  expect(chained.ok && chained.commands).toContain("git push")
  const substituted = scanShellCommands("cat <<< $(git push)")
  expect(substituted.ok).toBe(true)
  expect(substituted.ok && substituted.commands).toContain("git push")
})

test("expands shell -c payloads so hidden chains are visible", () => {
  const chain = scanShellCommands("bash -c 'echo x; git push'")
  expect(chain.ok).toBe(true)
  expect(chain.ok && chain.commands).toContain("git push")
  const quoted = scanShellCommands(`bash -c 'echo "a; git push"'`)
  expect(quoted.ok).toBe(true)
  expect(quoted.ok && quoted.commands).not.toContain("git push")
  const wrapped = scanShellCommands("env -i bash -c 'npm publish'")
  expect(wrapped.ok).toBe(true)
  expect(wrapped.ok && wrapped.commands).toContain("npm publish")
})

test("fails closed on constructs it cannot analyze", () => {
  for (const input of ["diff <(git status) <(git log)", "echo $(git push", "echo 'unterminated", "$(git push)"]) {
    const scan = scanShellCommands(input)
    expect(scan.ok, input).toBe(false)
  }
})

test("parameter expansion bodies are scanned for substitutions", () => {
  const variants = ["echo ${x:-$(git push)}", "echo \"${x:-`git push`}\"", "echo ${x:-${y:-$(git push)}}"]
  for (const input of variants) {
    const scan = scanShellCommands(input)
    expect(scan.ok, input).toBe(true)
    expect(scan.ok && scan.commands, input).toContain("git push")
  }
  const benign = scanShellCommands("echo ${HOME}")
  expect(benign.ok && benign.commands).toEqual(["echo ${HOME}"])
  expect(scanShellCommands("echo ${x").ok).toBe(false)
})

test("deny-listed commands hidden behind separators or substitutions are rejected", () => {
  const variants = [
    "echo hi; git push",
    "true && git push",
    "echo hi || npm publish",
    "printf x | git push",
    "echo hi & git clean -fdx .",
    "one\ngit push",
    "echo $(printenv)",
    "echo `npm publish --access public`",
    "echo $(echo $(git push))",
    "cat $(echo opencode.env)",
    "bash -c 'echo x; git push'",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("reject")
  }
})

test("benign chains and quoted separators stay allowed", () => {
  const variants = [
    "npm test && npm run build",
    "git status; ls",
    `git commit -m "fix: a; git push"`,
    "cat <<'EOF'\ngit push\n$(printenv)\nEOF",
  ]
  for (const variant of variants) {
    expect(evaluatePermission({ tool: "bash", patterns: [variant] }), variant).toBe("once")
  }
})

test("indeterminate commands fail closed", () => {
  for (const patterns of [["diff <(git status) <(git log)"], ['eval "git push"'], ["$x push"]]) {
    const req = { tool: "bash", patterns }
    expect(evaluatePermission(req), patterns[0]).toBe("ask")
    expect(decidePermission("auto", req), patterns[0]).toBe("reject")
    expect(decidePermission("buttons", req), patterns[0]).toBe("ask")
    expect(decidePermission("plan", req), patterns[0]).toBe("reject")
  }
})

test("explicit deny matches stay an absolute reject in buttons mode", () => {
  const req = { tool: "bash", patterns: ["echo hi; git push"] }
  expect(decidePermission("buttons", req)).toBe("reject")
})
