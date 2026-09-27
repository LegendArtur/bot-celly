# Multi-Guild Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Celly process serve several Discord guilds: deploy the command set to every configured guild, run boot subscribe/reconcile for all of them, and scope project channels to the guild that created them — while keeping access control global.

**Architecture:** `Config` gains `guildIds: string[]` parsed from `DISCORD_GUILD_IDS` (comma-separated) with `DISCORD_GUILD_ID` as fallback; `guildId` stays `guildIds[0]` for compatibility. Boot fetches every configured guild, deploys commands per guild with per-guild failure isolation, caches the guilds by id, and scopes `ProjectService.createChannel` to the guild that invoked `/project add|create`. Messages and threads already resolve the owning project row from the DB; tests lock that behavior in.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Node `>=24 <25`, discord.js 14.27, Vitest 3, `node:sqlite`. No new npm dependencies.

**Spec:** docs/superpowers/specs/2026-09-27-vnext-features-design.md (section 4.4 is binding; sections 1, 2, 3 also apply)

## Worktree

Create an isolated worktree with the `superpowers:using-git-worktrees` skill before starting:

```bash
git worktree add ../celly-multi-guild -b feat/multi-guild main
cd ../celly-multi-guild && npm ci
```

Run every command in this plan from that worktree. Spec §1 recommends merging `admin-and-ops` before `multi-guild` because both touch `src/index.ts`, `docs-site/guides/configuration.mdx`, and `README.md`.

## Global Constraints

- Node `>=24 <25`; ESM TypeScript; `strict` + `noUncheckedIndexedAccess`.
- Only `src/sbx.ts` may import `node:child_process` (enforced by `test/imports.test.ts`).
- argv-only spawning: `shell: false`, `windowsHide: true`; never interpolate user input into a shell string.
- Secrets (Discord token, server passwords, provider keys) never in argv, logs, audit entries, or Discord messages; redact through `src/log.ts`.
- Style: double quotes, no statement semicolons, 2-space indent; tests use flat `test(...)` (no `describe`), `import { expect, test, vi } from "vitest"`, and `../src/x.ts` imports. Temp dirs via `mkdtempSync(join(tmpdir(), "celly-...-")); try { } finally { rmSync(...) }`.
- Config changes update `docs-site/guides/configuration.mdx` and `.env.example`; README updates are listed explicitly in Task 5.
- Run `npm test`, `npm run typecheck`, and `npm run build` before each commit.
- **No new npm dependencies.**
- Access control stays global (env roles); do **not** add per-guild role configuration. Document the limitation (Task 5).
- Conventional commits, one commit per task (`feat(config): ...`, `feat(multi-guild): ...`).
- Migrations are append-only; this plan adds none.
- Each plan adds one changeset and commits it with the final task.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Parse `guildIds` from env (`DISCORD_GUILD_IDS` / `DISCORD_GUILD_ID`), validate non-empty, keep `guildId = guildIds[0]`. |
| `src/discord.ts` | `fetchConfiguredGuilds` — boot-time guild resolution with per-guild skip and all-fail fatal. |
| `src/commands.ts` | `deployCommandsToGuilds` — per-guild `commands.set` with failure isolation and invalid-token fatal. |
| `src/handlers.ts` | `createReadyHandler` runs the boot subscribe/reconcile pass once per process. |
| `src/helpers.ts` | `formatStartupBanner` renders one line per configured guild. |
| `src/projects.ts` | `ProjectDeps.createChannel(guildId, name)` and `deleteChannel(guildId, channelId)` so provisioning and teardown target the owning guild. |
| `src/index.ts` | Fetches all guilds, deploys per guild, caches them by id, scopes channel create/delete, prints the multi-guild banner. |
| `test/config.test.ts` | Plural/singular parsing, dedupe, validation. |
| `test/discord.test.ts` | `fetchConfiguredGuilds` reachable/missing/all-missing. |
| `test/commands.test.ts` | Per-guild deploy isolation, all-fail fatal, invalid-token fatal, guild-id forwarding. |
| `test/projects.test.ts` | `createChannel` receives the project's guild id. |
| `test/handlers.test.ts` | Ready-handler single pass, multi-guild banner, thread fallback to the owning project. |
| `.env.example`, `docs-site/guides/configuration.mdx`, `README.md`, `.changeset/multi-guild.md` | Docs and release note. |

---

### Task 1: Config — `DISCORD_GUILD_IDS` with `DISCORD_GUILD_ID` fallback

**Files:**
- Modify: `src/config.ts:5-14` (Config interface), `src/config.ts:41-51` (add parser), `src/config.ts:56-65` (loadConfig required check and return)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Config.guildIds: string[]` — non-empty, trimmed, deduped, first-seen order.
  - `Config.guildId: string` — still present, always `guildIds[0]`.
  - `parseGuildIds(env: NodeJS.ProcessEnv): string[] | undefined` — exported; returns `undefined` when neither env var is set, throws when `DISCORD_GUILD_IDS` is set but contains no non-empty entry.

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, update the import line to include `parseGuildIds`:

```ts
import { defaultProjectsRoot, ensureDataDir, loadConfig, loadDotEnv, parseGuildIds, seedSettings } from "../src/config.ts"
```

Append these tests at the end of the file:

```ts
test("parseGuildIds reads the plural list, trims, drops blanks, and dedupes", () => {
  expect(parseGuildIds({ DISCORD_GUILD_IDS: " g1 , ,g2,g1 " })).toEqual(["g1", "g2"])
})
test("parseGuildIds falls back to the singular guild id", () => {
  expect(parseGuildIds({ DISCORD_GUILD_ID: " g1 " })).toEqual(["g1"])
})
test("parseGuildIds returns undefined when neither variable is set", () => {
  expect(parseGuildIds({})).toBeUndefined()
})
test("parseGuildIds rejects an all-blank plural list", () => {
  expect(() => parseGuildIds({ DISCORD_GUILD_IDS: " , " })).toThrow(/DISCORD_GUILD_IDS/)
})
test("loadConfig prefers DISCORD_GUILD_IDS and keeps guildId as the first id", () => {
  const c = loadConfig({ DISCORD_TOKEN: "t", DISCORD_GUILD_IDS: "g1,g2", DISCORD_GUILD_ID: "legacy" })
  expect(c.guildIds).toEqual(["g1", "g2"])
  expect(c.guildId).toBe("g1")
})
test("loadConfig falls back to the singular guild id", () => {
  const c = loadConfig({ ...base })
  expect(c.guildIds).toEqual(["g"])
  expect(c.guildId).toBe("g")
})
test("loadConfig requires a guild id in either form", () => {
  expect(() => loadConfig({ DISCORD_TOKEN: "t" })).toThrow(/DISCORD_GUILD_ID/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `parseGuildIds` is not exported from `../src/config.ts` (import/compile error), and `c.guildIds` is `undefined`.

- [ ] **Step 3: Implement**

In `src/config.ts`, change the `Config` interface first line:

```ts
  discordToken: string; guildId: string; guildIds: string[]; projectsRoot: string
```

Add the parser after the `int` helper (after line 51):

```ts
/**
 * Spec §4.4: `DISCORD_GUILD_IDS` (comma-separated) wins when set; the singular
 * `DISCORD_GUILD_ID` remains supported. Entries are trimmed, blanks dropped,
 * and duplicates collapsed in first-seen order.
 */
export function parseGuildIds(env: NodeJS.ProcessEnv): string[] | undefined {
  const plural = str(env, "DISCORD_GUILD_IDS")
  if (plural !== undefined) {
    const ids = [...new Set(plural.split(",").map((id) => id.trim()).filter((id) => id.length > 0))]
    if (ids.length === 0) throw new Error("DISCORD_GUILD_IDS must contain at least one non-empty guild id")
    return ids
  }
  const single = str(env, "DISCORD_GUILD_ID")
  return single ? [single] : undefined
}
```

In `loadConfig`, replace the required-vars check:

```ts
  const missing = ["DISCORD_TOKEN", "DISCORD_GUILD_ID"].filter((k) => !str(env, k))
  if (missing.length) throw new Error(`Missing required env: ${missing.join(", ")}`)
```

with:

```ts
  const guildIds = parseGuildIds(env)
  const missing = [
    ...(str(env, "DISCORD_TOKEN") ? [] : ["DISCORD_TOKEN"]),
    ...(guildIds ? [] : ["DISCORD_GUILD_ID or DISCORD_GUILD_IDS"]),
  ]
  if (missing.length) throw new Error(`Missing required env: ${missing.join(", ")}`)
```

Replace the return object's first line:

```ts
    discordToken: str(env, "DISCORD_TOKEN")!, guildId: str(env, "DISCORD_GUILD_ID")!,
```

with:

```ts
    discordToken: str(env, "DISCORD_TOKEN")!, guildId: guildIds![0]!, guildIds: guildIds!,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (all config tests, including the existing `requires mandatory vars` test, which still matches `/DISCORD_TOKEN/`).

Then run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): accept DISCORD_GUILD_IDS with DISCORD_GUILD_ID fallback"
```

---

### Task 2: Deploy `commandData()` to every configured guild

**Files:**
- Modify: `src/commands.ts` (add `deployCommandsToGuilds` after `commandData()`)
- Modify: `src/discord.ts` (add `fetchConfiguredGuilds`)
- Modify: `src/index.ts:11-12` (imports), `src/index.ts:461-468` (boot fetch/deploy), `src/index.ts:479-481` (permission probe uses the first fetched guild until Task 3/4)
- Test: `test/commands.test.ts`, `test/discord.test.ts`

**Interfaces:**
- Consumes: `commandData(): any[]` (existing), `Config.guildIds` (Task 1).
- Produces:
  - `CommandDeployGuild = { id: string; commands: { set(data: any[]): Promise<unknown> } }`
  - `DeployLog = { info(message: string, fields?: any): void; warn(message: string, fields?: any): void }`
  - `deployCommandsToGuilds(guilds: CommandDeployGuild[], data: any[], deps: { log: DeployLog }): Promise<string[]>` — returns deployed guild ids, warns and continues on a per-guild failure, throws on invalid-token errors or when every guild fails.
  - `fetchConfiguredGuilds<G extends { id: string }>(ids: string[], fetchGuild: (id: string) => Promise<G>, log: { warn(message: string, fields?: any): void }): Promise<G[]>` — warns and skips unreachable guilds, throws when none resolve.

- [ ] **Step 1: Write the failing tests**

In `test/discord.test.ts`, update imports:

```ts
import { expect, test, vi } from "vitest"
import { fetchConfiguredGuilds, isAuthorized, rolesOf, shouldHandleMessage } from "../src/discord.ts"
```

Append:

```ts
test("fetchConfiguredGuilds keeps reachable guilds and warns about missing ones", async () => {
  const warn = vi.fn()
  const guilds = await fetchConfiguredGuilds(["g1", "g2"], async (id) => {
    if (id === "g2") throw new Error("Unknown Guild")
    return { id }
  }, { warn })
  expect(guilds).toEqual([{ id: "g1" }])
  expect(warn).toHaveBeenCalledWith("configured guild is unavailable; skipping", { guildId: "g2", error: "Unknown Guild" })
})
test("fetchConfiguredGuilds throws when no configured guild is reachable", async () => {
  await expect(fetchConfiguredGuilds(["g1"], async () => { throw new Error("Unknown Guild") }, { warn: () => {} }))
    .rejects.toThrow(/could not fetch any configured guild/)
})
```

In `test/commands.test.ts`, update imports:

```ts
import { expect, test, vi } from "vitest"
import { SELECT_OPTION_MAX, SELECT_OPTIONS_MAX, commandData, deployCommandsToGuilds, handleCommand, handleSelect, requiresOwner, sanitizeSelectOptions } from "../src/commands.ts"
```

Append:

```ts
test("deployCommandsToGuilds deploys to every guild and logs the ids", async () => {
  const calls: string[] = []
  const info = vi.fn()
  const guilds = ["g1", "g2"].map((id) => ({ id, commands: { set: async (data: any[]) => { calls.push(`${id}:${data.length}`) } } }))
  const deployed = await deployCommandsToGuilds(guilds, commandData(), { log: { info, warn: () => {} } })
  expect(calls).toEqual(["g1:6", "g2:6"])
  expect(deployed).toEqual(["g1", "g2"])
  expect(info).toHaveBeenCalledWith("commands deployed", { guilds: ["g1", "g2"] })
})
test("deployCommandsToGuilds isolates a single guild failure", async () => {
  const warn = vi.fn()
  const set = vi.fn(async () => {})
  const guilds = [
    { id: "g1", commands: { set: async () => { throw new Error("Missing Access") } } },
    { id: "g2", commands: { set } },
  ]
  const deployed = await deployCommandsToGuilds(guilds, [], { log: { info: () => {}, warn } })
  expect(deployed).toEqual(["g2"])
  expect(set).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith("command deploy failed for guild", { guildId: "g1", error: "Missing Access" })
})
test("deployCommandsToGuilds throws when every guild fails", async () => {
  const guilds = [{ id: "g1", commands: { set: async () => { throw new Error("Missing Access") } } }]
  await expect(deployCommandsToGuilds(guilds, [], { log: { info: () => {}, warn: () => {} } })).rejects.toThrow(/every guild/)
})
test("deployCommandsToGuilds treats an invalid token as fatal immediately", async () => {
  const set = vi.fn(async () => {})
  const guilds = [
    { id: "g1", commands: { set: async () => { throw new Error("An invalid token was provided.") } } },
    { id: "g2", commands: { set } },
  ]
  await expect(deployCommandsToGuilds(guilds, [], { log: { info: () => {}, warn: () => {} } })).rejects.toThrow(/invalid token/)
  expect(set).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts test/discord.test.ts`
Expected: FAIL — `deployCommandsToGuilds` and `fetchConfiguredGuilds` are not exported (import/compile errors).

- [ ] **Step 3: Implement the helpers**

In `src/commands.ts`, add after `commandData()`:

```ts
export interface CommandDeployGuild {
  id: string
  commands: { set(data: any[]): Promise<unknown> }
}
export interface DeployLog {
  info(message: string, fields?: any): void
  warn(message: string, fields?: any): void
}
/** Token/auth failures fail for every guild; do not mask them as partial outages. */
const FATAL_DEPLOY_ERROR = /disallowed intents|invalid token|token was provided/i

export async function deployCommandsToGuilds(guilds: CommandDeployGuild[], data: any[], deps: { log: DeployLog }): Promise<string[]> {
  const deployed: string[] = []
  const failures: string[] = []
  for (const guild of guilds) {
    try {
      await guild.commands.set(data)
      deployed.push(guild.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (FATAL_DEPLOY_ERROR.test(message)) throw err
      failures.push(`${guild.id}: ${message}`)
      deps.log.warn("command deploy failed for guild", { guildId: guild.id, error: message })
    }
  }
  if (deployed.length === 0) throw new Error(`command deploy failed for every guild (${failures.join("; ")})`)
  deps.log.info("commands deployed", { guilds: deployed })
  return deployed
}
```

In `src/discord.ts`, append:

```ts
export async function fetchConfiguredGuilds<G extends { id: string }>(
  ids: string[],
  fetchGuild: (id: string) => Promise<G>,
  log: { warn(message: string, fields?: any): void },
): Promise<G[]> {
  const guilds: G[] = []
  const failures: string[] = []
  for (const id of ids) {
    try {
      guilds.push(await fetchGuild(id))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${id}: ${message}`)
      log.warn("configured guild is unavailable; skipping", { guildId: id, error: message })
    }
  }
  if (guilds.length === 0) throw new Error(`could not fetch any configured guild (${failures.join("; ")})`)
  return guilds
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run test/commands.test.ts test/discord.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `src/index.ts`**

Update the imports:

```ts
import { createDiscordClient, fetchConfiguredGuilds, isAuthorized, isOwner, rolesOf } from "./discord.js"
import { commandData, deployCommandsToGuilds, handleCommand, handleSelect } from "./commands.js"
```

Replace the post-login block (currently `guild = await client.guilds.fetch(cfg.guildId)` and `await guild.commands.set(commandData())`) with:

```ts
  const fetchedGuilds = await fetchConfiguredGuilds(cfg.guildIds, (id) => client.guilds.fetch(id), log)
  const firstGuild = fetchedGuilds[0]
  if (!firstGuild) throw new Error("no configured guild was reachable")
  guild = firstGuild
  await deployCommandsToGuilds(fetchedGuilds, commandData(), { log })
```

Replace `log.info("Celly ready", { guild: guild.name })` with:

```ts
  log.info("Celly ready", { guilds: fetchedGuilds.map((g) => g.id) })
```

Replace the permission probe so it reads the first fetched guild (this keeps boot working until Tasks 3–4 generalize it):

```ts
  const me = firstGuild.members.me
```

and the banner call's `guild:` field:

```ts
  console.log(formatStartupBanner({ guild: firstGuild.name, projects: db.projects.list().length, dataDir: cfg.dataDir, model: cfg.defaultModel, missingPermissions }))
```

Note: `let guild: Guild | undefined` and `requireGuild()` stay for now; `guild` is set to the first configured guild so channel operations still work until Task 4 scopes them per guild.

- [ ] **Step 6: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/commands.ts src/discord.ts src/index.ts test/commands.test.ts test/discord.test.ts
git commit -m "feat(multi-guild): deploy commands to every configured guild"
```

---

### Task 3: Multi-guild readiness and startup banner

**Files:**
- Modify: `src/handlers.ts:186-199` (`createReadyHandler`)
- Modify: `src/helpers.ts:98-120` (`StartupBanner`, `formatStartupBanner`)
- Modify: `src/index.ts:468-481` (permissions and banner use every fetched guild)
- Test: `test/handlers.test.ts`

**Interfaces:**
- Consumes: `fetchConfiguredGuilds` (Task 2), `Config.guildIds` (Task 1).
- Produces:
  - `StartupBannerGuild = { id: string; name: string; missingPermissions: string[] }`
  - `StartupBanner = { guilds: StartupBannerGuild[]; projects: number; dataDir: string; model?: string }`
  - `formatStartupBanner(info: StartupBanner): string` — one `Guild:` line per entry.
  - `createReadyHandler(deps: ReadyDeps): () => void` — runs the subscribe-then-reconcile boot pass at most once per process.

Subscription and reconcile are already DB-driven: `subscribeReadyProjects()` iterates `db.projects.list()` (all guilds) and `subscribeProject` is gated per channel; `createReconcileThreads` has an in-flight guard. The only duplicate-work fix needed is making `createReadyHandler` run its pass once even if `ClientReady` is emitted more than once.

- [ ] **Step 1: Write the failing ready-handler test**

In `test/handlers.test.ts`, append after the existing `ready handler subscribes then reconciles` test:

```ts
test("ready handler runs subscribe and reconcile only once", async () => {
  const subscribe = vi.fn()
  const reconcile = vi.fn(async () => {})
  const ready = createReadyHandler({ log: silent, subscribeReadyProjects: subscribe, reconcileThreads: reconcile })
  ready()
  ready()
  await new Promise((r) => setTimeout(r, 0))
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(reconcile).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/handlers.test.ts -t "runs subscribe and reconcile only once"`
Expected: FAIL — `subscribe` and `reconcile` are each called twice.

- [ ] **Step 3: Implement the once guard**

Replace `createReadyHandler` in `src/handlers.ts`:

```ts
export function createReadyHandler(deps: ReadyDeps): () => void {
  let started = false
  return (): void => {
    if (started) return
    started = true
    void (async () => {
      try { await deps.subscribeReadyProjects() } catch (err) { deps.log.error("boot subscribe failed", { error: String(err) }) }
      await deps.reconcileThreads().catch((err) => deps.log.error("boot reconcile failed", { error: String(err) }))
    })()
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/handlers.test.ts -t "ready handler"`
Expected: PASS (both ready-handler tests).

- [ ] **Step 5: Write the failing banner test**

In `test/handlers.test.ts`, replace the existing `formatStartupBanner summarizes the run and flags missing permissions` test with:

```ts
test("formatStartupBanner lists every guild and flags its missing permissions", () => {
  const ok = formatStartupBanner({
    guilds: [
      { id: "g1", name: "Guild One", missingPermissions: [] },
      { id: "g2", name: "Guild Two", missingPermissions: [] },
    ],
    projects: 2, dataDir: "./data", model: "anthropic/x",
  })
  expect(ok).toContain("Celly is running")
  expect(ok).toContain("Projects: 2")
  expect(ok).toContain("Guild:    Guild One (g1)")
  expect(ok).toContain("Guild:    Guild Two (g2)")
  const bad = formatStartupBanner({
    guilds: [{ id: "g1", name: "Guild One", missingPermissions: ["Manage Channels"] }],
    projects: 0, dataDir: "./data",
  })
  expect(bad).toContain("MISSING: Manage Channels")
  expect(bad).toContain("/project add")
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/handlers.test.ts -t formatStartupBanner`
Expected: FAIL — the old `formatStartupBanner` reads `info.guild` (undefined) and `info.missingPermissions` (undefined).

- [ ] **Step 7: Implement the multi-guild banner**

In `src/helpers.ts`, replace `StartupBanner` and `formatStartupBanner`:

```ts
export interface StartupBannerGuild {
  id: string
  name: string
  missingPermissions: string[]
}
export interface StartupBanner {
  guilds: StartupBannerGuild[]
  projects: number
  dataDir: string
  model?: string
}
export function formatStartupBanner(info: StartupBanner): string {
  const lines = [
    `Projects: ${info.projects}`,
    `Data:     ${info.dataDir}`,
    `Model:    ${info.model ?? "(OpenCode default)"}`,
    ...info.guilds.map((g) => `Guild:    ${g.name} (${g.id})${g.missingPermissions.length === 0 ? "" : ` MISSING: ${g.missingPermissions.join(", ")}`}`),
  ]
  const width = Math.max("Celly is running".length, ...lines.map((l) => l.length))
  const rule = `+${"-".repeat(width + 2)}+`
  const box = [rule, `| ${"Celly is running".padEnd(width)} |`, rule, ...lines.map((l) => `| ${l.padEnd(width)} |`), rule]
  const next = info.projects === 0
    ? "Next: in Discord run  /project add <name> <path>  then send a message in its channel."
    : "Next: send a message in a project channel to start a session."
  return [...box, next].join("\n")
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/handlers.test.ts -t formatStartupBanner`
Expected: PASS.

- [ ] **Step 9: Wire `src/index.ts`**

Replace the permission probe and banner call (the block starting at `const me = firstGuild.members.me`) with:

```ts
  console.log(formatStartupBanner({
    guilds: fetchedGuilds.map((g) => {
      const me = g.members.me
      const missingPermissions = required.filter(([, bit]) => !(me?.permissions.has(bit) ?? false)).map(([name]) => name)
      return { id: g.id, name: g.name, missingPermissions }
    }),
    projects: db.projects.list().length,
    dataDir: cfg.dataDir,
    model: cfg.defaultModel,
  }))
```

Keep `const required: Array<[string, bigint]> = [...]` as-is above it. All guild fetches are already awaited by `fetchConfiguredGuilds` in Task 2 before this banner runs.

- [ ] **Step 10: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add src/handlers.ts src/helpers.ts src/index.ts test/handlers.test.ts
git commit -m "feat(multi-guild): run boot readiness and banner across all guilds"
```

---

### Task 4: Guild-scope project channel creation and lock in thread fallback

**Files:**
- Modify: `src/projects.ts:17-18` (`ProjectDeps.createChannel`/`deleteChannel`), `src/projects.ts:154` and `:177` (create/rollback call sites), `src/projects.ts:457` (remove call site)
- Modify: `src/index.ts:86-90` (replace `guild`/`requireGuild` with a guild cache), `src/index.ts:104-117` (`createChannel`/`deleteChannel` closures), `src/index.ts:454-462` (boot uses cached guilds, drop `firstGuild`)
- Test: `test/projects.test.ts`, `test/commands.test.ts`, `test/handlers.test.ts`

**Interfaces:**
- Consumes: `Config.guildIds` (Task 1), `fetchConfiguredGuilds` (Task 2), `ProjectService.addProject(input: { guildId; name; directory; existingChannelId? })` (existing).
- Produces:
  - `ProjectDeps.createChannel(guildId: string, name: string): Promise<string>`
  - `ProjectDeps.deleteChannel(guildId: string, channelId: string): Promise<void>` — the guild id is passed explicitly because `remove()` deletes the project row before deleting the channel.
  - index-local `resolveGuild(guildId: string): Promise<Guild>` backed by a `guildsById` cache.

Message and thread handlers already resolve the owning project row (`knownThread.channelId`, then `projectForChannel(projects, channelId, parentId)`); Task 4 adds regression tests for that and fixes the real gap: `createChannel`/`deleteChannel` currently run in a single global guild.

- [ ] **Step 1: Write the failing projects test**

In `test/projects.test.ts`, append:

```ts
test("addProject creates the channel in the project's guild", async () => {
  const db = openDb(":memory:"); db.migrate(); const { sbx, runner } = fakes()
  sbx.create = async () => { throw new Error("create boom") }
  const created: Array<[string, string]> = []
  const deleted: Array<[string, string]> = []
  const svc = new ProjectService({ sbx, runner: runner as any, db, config: makeCfg(4600, 4600), log: logger(),
    isPortFree: async () => true,
    createChannel: async (guildId: string, name: string) => { created.push([guildId, name]); return "chan1" },
    deleteChannel: async (guildId: string, channelId: string) => { deleted.push([guildId, channelId]) } } as any)
  await expect(svc.addProject({ guildId: "g2", name: "demo", directory: "C:\\projects\\demo" })).rejects.toThrow(/create boom/)
  expect(created).toEqual([["g2", "demo"]])
  expect(deleted).toEqual([["g2", "chan1"]])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/projects.test.ts -t "project's guild"`
Expected: FAIL — `created` is `[["demo", undefined]]` because the current call is `createChannel(input.name)`.

- [ ] **Step 3: Implement the signature change**

In `src/projects.ts`, change the dependency types:

```ts
  createChannel(guildId: string, name: string): Promise<string>
  deleteChannel(guildId: string, channelId: string): Promise<void>
```

Change the create call site in `doAddProject`:

```ts
      channelId = input.existingChannelId ?? (await this.deps.createChannel(input.guildId, input.name))
```

Change the rollback call site in the same method's `catch`:

```ts
      if (!input.existingChannelId && channelId) await this.deps.deleteChannel(input.guildId, channelId).catch(() => {})
```

Change the call site in `remove` (the project row is fetched as `p` before this line):

```ts
    await this.deps.deleteChannel(p.guildId, channelId).catch(() => {})
```

- [ ] **Step 4: Update the fakes that inspect the first argument**

In `test/projects.test.ts`, fakes that read the first arg need the guild id added as the new first parameter. Find every `deleteChannel` fake of the form `async (c: string) => { deleted.push(c) }`:

Run: `rg -n "deleteChannel: async \(c: string\)" test/projects.test.ts`
Expected: 7 matches.

Rewrite each as:

```ts
deleteChannel: async (_guildId: string, c: string) => { deleted.push(c) }
```

Then update the two `createChannel` fakes that assert the name (`addProject rolls back on create failure` at ~line 203 and `addProject with existingChannelId preserves the channel on rollback` at ~line 253):

```ts
    isPortFree: async () => true, createChannel: async (_guildId: string, n: string) => { created.push(n); return "chan1" },
```

```ts
    isPortFree: async () => true, createChannel: async (_guildId: string, n: string) => { created.push(n); return "new" },
```

And the slug test's create fake at ~line 239:

```ts
      isPortFree: async (p: number) => listening.has(p), createChannel: (_guildId: string, n: string) => Promise.resolve("chan-" + n), deleteChannel: async () => {} } as any)
```

- [ ] **Step 5: Run the projects tests to verify they pass**

Run: `npx vitest run test/projects.test.ts`
Expected: PASS (the new test plus all existing rollback/slug tests).

- [ ] **Step 6: Write the guild-scoping guard tests**

These lock behavior required by spec §4.4; the commands guard passes on the current commit because `handleCommand` already forwards `interaction.guildId`.

Append to `test/commands.test.ts`:

```ts
test("project add forwards the invoking guild id to addProject", async () => {
  const i = interaction({ sub: "add", strings: { name: "demo", path: "C:\\p" }, guildId: "g2" })
  const seen: any[] = []
  await handleCommand(i, {
    projects: { addProject: async (input: any) => { seen.push(input); return { ...proj, guildId: input.guildId } } } as any,
    runner: {} as any, db: fresh(), authorized: () => true, isOwner: () => true,
  })
  expect(seen).toEqual([{ guildId: "g2", name: "demo", directory: "C:\\p" }])
})
```

In `test/handlers.test.ts`, add `guildId` to the fake message (inside `fakeMessage`, on the `message` object):

```ts
    guildId: over.guildId ?? "g",
```

Append:

```ts
test("a message in a thread resolves its owning project across guilds", async () => {
  const db = fresh()
  db.projects.insertProvisioning(project({ channelId: "c1", guildId: "g1", name: "one" })); db.projects.setReady("c1", "C:\\p1")
  db.projects.insertProvisioning(project({ channelId: "c2", guildId: "g2", name: "two" })); db.projects.setReady("c2", "C:\\p2")
  db.threads.upsert(thread({ threadId: "t2", channelId: "c2", sessionId: "s2" }))
  const deps = baseDeps(db)
  const { message } = fakeMessage({ channelId: "t2", parentId: null, isThread: () => true, guildId: "g2", content: "hello" })
  await createMessageHandler(deps)(message)
  expect(deps.runner.prompt).toHaveBeenCalledWith("t2", "hello", "u1")
})
```

Run: `npx vitest run test/commands.test.ts test/handlers.test.ts`
Expected: the two guard tests PASS (they do not depend on the implementation change); all other tests still pass.

- [ ] **Step 7: Replace the single-guild plumbing in `src/index.ts`**

Replace:

```ts
  let guild: Guild | undefined
  const requireGuild = (): Guild => {
    if (!guild) throw new Error("Discord guild not ready")
    return guild
  }
```

with:

```ts
  const guildsById = new Map<string, Guild>()
  const resolveGuild = async (guildId: string): Promise<Guild> => {
    const cached = guildsById.get(guildId)
    if (cached) return cached
    const fetched = await client.guilds.fetch(guildId)
    guildsById.set(guildId, fetched)
    return fetched
  }
```

Replace the `createChannel`/`deleteChannel` closures inside the `new ProjectService({...})` deps:

```ts
    createChannel: async (guildId, name) => {
      const activeGuild = await resolveGuild(guildId)
      const categoryId = findCategoryId(activeGuild, cfg.categoryId)
        ?? (await activeGuild.channels.create({ name: "Forge", type: ChannelType.GuildCategory })).id
      const taken = new Set([...activeGuild.channels.cache.values()].map((c) => c.name))
      const channelName = uniqueChannelName(sanitizeChannelName(name), taken)
      const channel = await activeGuild.channels.create({ name: channelName, parent: categoryId, type: ChannelType.GuildText })
      return channel.id
    },
    deleteChannel: async (guildId, id) => {
      const activeGuild = await resolveGuild(guildId).catch(() => undefined)
      const channel = activeGuild?.channels.cache.get(id) ?? (activeGuild ? await activeGuild.channels.fetch(id).catch(() => null) : null)
      if (channel) await channel.delete().catch(() => {})
    },
```

At the end of `main`, replace:

```ts
  const fetchedGuilds = await fetchConfiguredGuilds(cfg.guildIds, (id) => client.guilds.fetch(id), log)
  const firstGuild = fetchedGuilds[0]
  if (!firstGuild) throw new Error("no configured guild was reachable")
  guild = firstGuild
  await deployCommandsToGuilds(fetchedGuilds, commandData(), { log })
```

with:

```ts
  const fetchedGuilds = await fetchConfiguredGuilds(cfg.guildIds, (id) => client.guilds.fetch(id), log)
  for (const g of fetchedGuilds) guildsById.set(g.id, g)
  await deployCommandsToGuilds(fetchedGuilds, commandData(), { log })
```

- [ ] **Step 8: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. If typecheck reports an unused `Guild` import, it is still used by `guildsById`/`resolveGuild`; no change needed. `grep -n "requireGuild\|firstGuild" src/index.ts` must return no matches.

- [ ] **Step 9: Commit**

```bash
git add src/projects.ts src/index.ts test/projects.test.ts test/commands.test.ts test/handlers.test.ts
git commit -m "feat(multi-guild): scope project channels to the invoking guild"
```

---

### Task 5: Docs, `.env.example`, and changeset

**Files:**
- Modify: `.env.example:1-5`
- Modify: `docs-site/guides/configuration.mdx:10-24`
- Modify: `README.md:93-94`, `README.md:119`, `README.md:194`, `README.md:197-207`
- Create: `.changeset/multi-guild.md`

**Interfaces:**
- Consumes: `DISCORD_GUILD_IDS` / `DISCORD_GUILD_ID` behavior from Task 1; deploy/skip semantics from Task 2; global access-control decision (spec §4.4).
- Produces: user-facing docs and the release changeset; no code.

- [ ] **Step 1: Update `.env.example`**

Replace the first five lines:

```dotenv
# Celly configuration — only the first two values are required.
# Everything below them has a working default; uncomment only to override.

DISCORD_TOKEN=
# One or more guild IDs, comma-separated. DISCORD_GUILD_ID (single guild) is
# still accepted when DISCORD_GUILD_IDS is unset.
DISCORD_GUILD_IDS=
# DISCORD_GUILD_ID=
```

- [ ] **Step 2: Update `docs-site/guides/configuration.mdx`**

Change the intro code block to:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_GUILD_IDS=111111111111111111,222222222222222222
```

and the sentence before it to: "Start from `.env.example` and set the required values. Everything else has a working default:".

In the variables table, replace the `DISCORD_GUILD_ID` row with:

```markdown
| `DISCORD_GUILD_IDS` | **required** | Comma-separated guild IDs. Entries are trimmed, blanks dropped, and duplicates ignored. |
| `DISCORD_GUILD_ID` | unset | Legacy single-guild form, used only when `DISCORD_GUILD_IDS` is unset. |
```

Add a new section after the `Variables` note:

```markdown
## Multiple guilds

Celly deploys its command set to every guild in `DISCORD_GUILD_IDS` and runs
boot subscribe and thread reconcile across all of them. At startup each
configured guild is fetched; a guild the bot cannot see (for example, it was
never invited) is skipped with a warning. Startup fails only when **no**
configured guild is reachable, or when the bot token itself is invalid. A
single guild failing command deployment does not abort startup.

`Config.guildId` remains available as `guildIds[0]` for code paths that still
expect one guild.

<Note>
Access control is global: `ACCESS_ROLE_ID`, `BLOCK_ROLE_ID`, and
`OWNER_ROLE_ID` apply to every configured guild. Role IDs only match in the
guild that owns them, and each guild's owner (or a member with `Manage Guild` /
`Administrator`) is always allowed in that guild. Per-guild role configuration
is not supported in this version.
</Note>
```

- [ ] **Step 3: Update `README.md`**

- Requirements bullet: change "A Discord application with a bot token, the **Message Content** intent, and a single guild." to "A Discord application with a bot token, the **Message Content** intent, and one or more guild IDs."
- Quick start: change "Set **only** `DISCORD_TOKEN` and `DISCORD_GUILD_ID`." to "Set **only** `DISCORD_TOKEN` and the guild list in `DISCORD_GUILD_IDS` (comma-separated; `DISCORD_GUILD_ID` still works for one guild)."
- Roadmap: change "**Scale/deploy:** multi-guild, cloud sandboxes, ..." to "**Scale/deploy:** cloud sandboxes, ..." (drop `multi-guild`).
- Limitations: add a bullet: "**Access control is global across guilds.** The same role IDs apply to every configured guild; per-guild roles are not supported. A configured guild the bot cannot see is skipped at startup with a warning."

- [ ] **Step 4: Create the changeset**

Create `.changeset/multi-guild.md`:

```markdown
---
"celly": minor
---

Multi-guild support: `DISCORD_GUILD_IDS` accepts a comma-separated list (with
`DISCORD_GUILD_ID` still supported) and Celly deploys its commands, boot
subscription, and thread reconcile across every configured guild.
```

- [ ] **Step 5: Validate docs**

Run: `npm run docs:validate`
Expected: exits 0 (requires network for `npx mint`; if the execution environment is offline, note it and rely on CI — code checks below are mandatory).

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add .env.example docs-site/guides/configuration.mdx README.md .changeset/multi-guild.md
git commit -m "feat(multi-guild): document multi-guild configuration"
```

---

## Definition of Done (spec §4.4 acceptance)

- Config tests cover plural parsing, singular fallback, dedupe/trim, blank-list rejection, and `guildId = guildIds[0]`.
- `deployCommandsToGuilds` tests assert two `commands.set` calls for two fake guilds and that one failing guild does not abort the other or startup; all-fail and invalid-token are fatal.
- `fetchConfiguredGuilds` skips an unreachable guild with a warning and throws only when none are reachable; all fetches are awaited before the banner.
- `createReadyHandler` runs subscribe/reconcile once; `formatStartupBanner` lists every guild id and per-guild missing permissions.
- `ProjectService.createChannel` receives the project's guild id, and `deleteChannel` receives it explicitly on both rollback and remove; message/thread routing tests prove the owning project row wins across guilds.
- Access control stays global and is documented; per-guild roles are explicitly out of scope.
- `.env.example`, `configuration.mdx`, `README.md`, and `.changeset/multi-guild.md` are updated.
- `npm test`, `npm run typecheck`, and `npm run build` pass at every commit; no new npm dependencies.

## Self-Review

**Spec coverage:** §4.4 config bullets → Task 1; per-guild deploy with isolation → Task 2; readiness/banner across guilds → Task 3; guild-scoped `addProject`/channel creation and thread fallback → Task 4; global access-control limitation + `.env.example`/docs → Task 5; changeset → Task 5; §1 worktree/merge order → Worktree section.

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every test and implementation step contains runnable code and exact commands.

**Identifier consistency:** `guildIds`, `parseGuildIds`, `fetchConfiguredGuilds`, `deployCommandsToGuilds`, `resolveGuild`, `guildsById`, `fetchedGuilds`, `StartupBannerGuild`, `createChannel(guildId, name)`, and `deleteChannel(guildId, channelId)` are spelled identically in every task.

## Open Questions

1. A configured guild the bot cannot see is skipped with a warning; the plan makes startup fatal only when none are reachable. The spec does not say whether a single unreachable guild should be fatal — confirm with the operator before merge.
2. `docs-site/reference/security.mdx` is not touched: spec §4.4 scopes the access-control change to a documented limitation, not a security-model change.
3. `admin-and-ops` also edits `configuration.mdx` and `README.md`; merge that worktree first per spec §1 to keep this plan's doc hunks conflict-free.
