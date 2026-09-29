# Celly one-line install (`npx bot-celly`) design

Status: approved 2026-09-29. Scope: publish `bot-celly` to npm and add a
`bot-celly` CLI that performs a guided first-run setup, reports prerequisite
health, and boots the existing bot — replacing the manual Node/clone/build/`.env`
quickstart.

## Goal

A user with Node 24 and the host prerequisites runs `npx bot-celly@latest` and,
in one shot, is prompted for the only values nobody else can know (Discord token
and guild IDs), gets a pass/fail report on the host prerequisites with exact fix
commands, and ends up with the bot running. Re-running the command boots again;
`bot-celly setup` reconfigures and `bot-celly doctor` diagnoses without booting.

## Decisions already made

1. **Package identity is `bot-celly`.** The unscoped `celly` name is taken on
   npm; `bot-celly` is free. Command: `npx bot-celly@latest`.
2. **Setup + run in one shot.** Bare `bot-celly` runs the wizard only when config
   is missing, then boots.
3. **Config and data live in `~/.bot-celly`** (`%USERPROFILE%\.bot-celly` on
   Windows), overridable by `CELLY_HOME`. `PROJECTS_ROOT` keeps its current
   `~/Celly/projects` default.
4. **Detect + guide for prerequisites.** The CLI never installs host software;
   it validates and prints the exact host command to run.
5. **Hard-require Node `>=24 <25`.** Matches `engines` and CI.
6. **CLI surface is `run` + `setup` / `doctor` / `--help` / `--version`**, with
   flags for headless use. No service-manager commands.
7. **Approach A.** A thin CLI over the existing `main()`; the boot path is not
   restructured. `src/index.ts` exports `main()` and stays the sole owner of
   preflight, lock, login, signals, and the startup banner.
8. **Releases via CI on a tag using npm Trusted Publishing (OIDC).** No
   `NPM_TOKEN`. First publish is a one-time manual `npm publish --access public`.

## Workstream A — packaging & entry layout

`package.json`:

- `"name": "bot-celly"` (renamed from `celly`).
- Remove `"private": true`.
- `"bin": { "bot-celly": "dist/cli.js" }`.
- `"files": ["dist", "assets"]`. `src/admin/assets.ts` resolves
  `../../assets/admin/` from `dist/admin/assets.js`, so `assets/admin/` must ship
  at the package root. npm always includes `README.md` and `LICENSE`.
- `"publishConfig": { "access": "public", "provenance": true }`.
- `"scripts": { "prepack": "npm run build", "prepublishOnly": "npm test && npm run typecheck" }`.
  Use `prepack`, never `prepare` (which would force consumers to build).
- Add `"repository"`, `"homepage"`, `"bugs"` for `LegendArtur/bot-celly`
  (provenance requires `repository.url` to match the GitHub repo).
- `engines` stays `>=24 <25`.

Entries:

- New `src/cli.ts` → `dist/cli.js`, first line `#!/usr/bin/env node` (tsc
  preserves the shebang). This is the `bin`.
- New helpers: `src/cli/args.ts`, `src/cli/home.ts`, `src/cli/wizard.ts`,
  `src/cli/doctor.ts`, `src/cli/ui.ts`.
- `src/index.ts` keeps `main()`, now exported. `dist/index.js` stays runnable for
  the repo/dev flow; the `isMainModule` guard stays, so importing it from the CLI
  does not auto-boot.
- No new runtime dependencies: arg parsing and the wizard use Node built-ins
  (`readline`, `readline/promises`).

## Workstream B — home directory & config resolution

- `resolveCellyHome(env, platform)`: `CELLY_HOME` wins; otherwise
  `join(homedir(), ".bot-celly")`.
- CLI startup order, before `main()` reads config:
  1. Parse args.
  2. Resolve home; `mkdirSync(home, { recursive: true, mode: 0o700 })`.
  3. Set `process.env.CELLY_ENV_FILE = join(home, ".env")` and load it with
     `process.loadEnvFile` (non-fatal if absent). `loadEnvFile` does not override
     already-set vars, so explicit flags/env win.
  4. If `DATA_DIR` is unset, set `process.env.DATA_DIR = join(home, "data")`.
  5. Doctor / wizard as needed, then `await main()`.
- One env file: `src/index.ts` calls `loadDotEnv(process.env.CELLY_ENV_FILE ?? ".env")`.
  Repo/dev loads `./.env` as today; the npx path ignores a stray `.env` in the
  user's current directory.
- Security: home created `0700`; `~/.bot-celly/.env` written `0600` on POSIX
  (no-op on Windows). The Discord token is the only secret stored; the existing
  logger already redacts it.

## Workstream C — first-run wizard

- Runs when `DISCORD_TOKEN` or guild IDs are missing after env resolution and
  stdin is a TTY. Missing config with no TTY exits with the exact flags to pass
  or the file to write. `bot-celly setup` always runs it.
- Flow: (1) explain what it collects and where it writes; (2) prompt
  `DISCORD_TOKEN` hidden via a `promptSecret` helper
  (`readline.emitKeypressEvents` + raw mode; visible with a warning if raw mode
  is unavailable); (3) prompt guild IDs comma-separated and validate with
  `parseGuildIds` plus a digits/snowflake sanity check; (4) validate the pair by
  calling `loadConfig` so the wizard cannot write a config boot would reject;
  (5) write `~/.bot-celly/.env` (`0600`), merging — update only
  `DISCORD_TOKEN`/`DISCORD_GUILD_IDS` and preserve comments/optional vars;
  (6) print the path, then continue to doctor + boot.
- `setup` re-runs even when config exists and merges in place; bare `bot-celly`
  skips the wizard once config is present.
- `wizard.ts` takes injected `input`/`output` streams and a `writeFile` function
  so prompts, validation, merge, and the mode are unit-testable without a TTY.

## Workstream D — doctor & prerequisite guidance

Checks, each returning pass/fail plus an actionable fix string:

- Node satisfies `>=24 <25`.
- `SbxRunner.run(["version"])` exits 0 (installed and logged in).
- `SbxRunner.run(["policy", "ls"])` exits 0 (network policy initialized).
- Config present and valid via `loadConfig` (token + ≥1 guild ID).
- Home exists and is writable; `DATA_DIR` creatable.
- Advisory: remind to run `sbx secret set <provider>` (not fatal; cannot be
  checked without leaks).

Behavior:

- Probes go through `SbxRunner` in `src/sbx.ts`; the CLI never imports
  `child_process` and never passes input to a shell (argv-only preserved).
- Bare `bot-celly`: doctor runs first; any failure prints fix commands and exits
  non-zero before boot.
- `bot-celly doctor`: runs checks, prints the table, exits non-zero on a hard
  failure, never boots.
- Dependencies are injected (`{ run(args), env, paths }`) so tests drive pass/fail
  without a real `sbx`.

## Workstream E — CLI presentation

- `src/cli/ui.ts` wraps the existing `paint` / `colorEnabled` / `ANSI` from
  `src/ansi.ts` and adds a green code. All color decisions stay in
  `colorEnabled`, so piped/CI output is plain.
- API: `heading`, `bullet`, `hint`, `status(kind, label, detail)` with
  `kind ∈ ok | fail | warn | info`.
- Symbols `✓ ✗ ! ›` with an ASCII fallback (`[ok]`, `[x]`, …) when color is
  disabled or `CELLY_ASCII=1`.
- Wizard: bold question with a `›` prefix, dim hints/defaults, hidden token, a
  final `Wrote ~/.bot-celly/.env` confirmation.
- Doctor: aligned status table (green `✓`, red `✗`, yellow `!`) with the fix
  command on a dim indented line, reusing the `LABEL_WIDTH`/rule pattern of
  `formatStartupBanner` so it matches the existing startup banner.
- Width capped near 80 columns; every line goes through an injected writer;
  non-TTY emits no ANSI or spinner.

## Workstream F — CLI surface & headless

- `bot-celly` → resolve home → load env → doctor; wizard if config missing and
  TTY; then `await main()`.
- `bot-celly setup` → force the wizard (merge/reconfigure); does not boot unless
  `--run` is given.
- `bot-celly doctor` → checks only; never boots.
- `bot-celly --version` / `-v` → version from `package.json`.
- `bot-celly --help` / `-h` → usage.
- Flags: `--token <value>`, `--guilds <a,b,c>`, `--home <dir>`, and `--run`
  (valid with `setup`). `--token`/`--guilds`/`--home` are applied to
  `process.env` (`DISCORD_TOKEN`, `DISCORD_GUILD_IDS`, `CELLY_HOME`) **before**
  env/config resolution, so a flag wins over the env file and suppresses the
  wizard prompt for that value.
- Unknown flag/subcommand → error, usage, exit `2`.
- Exit codes: `0` ok, `1` operational failure, `2` usage error.
- `src/cli/args.ts` is pure and dependency-free, returning a discriminated
  result (`{ kind: "run" | "setup" | "doctor" | "version" | "help" | "error", … }`).

## Workstream G — boot integration

- `src/index.ts` exports `main()`; the `isMainModule` guard stays so
  `node dist/index.js` and `npm run dev` are unchanged.
- `src/cli.ts` sets env then `await main()`.
- `main()` remains the single owner of preflight, the single-instance lock,
  Discord login, signal handling, and the startup banner. Doctor is pre-boot
  advisory; `main()` still fails fast on its own.
- No behavior change to the running bot; only how it is reached.

## Workstream H — release & CI

- `package.json`: `publishConfig` with `access: public` + `provenance: true`;
  `private` removed; `name: bot-celly`; `repository.url` =
  `git+https://github.com/LegendArtur/bot-celly.git`.
- `.github/workflows/release.yml`: triggered on push of a `v*` tag;
  `permissions: { contents: read, id-token: write }`; checkout → setup-node 24
  with `registry-url` → `npm ci` → `npm run typecheck` → `npm test` →
  `npm publish` (no `NODE_AUTH_TOKEN`; OIDC).
- Versioning stays on changesets; this change carries a `minor` changeset.
  `changeset version` bumps and syncs the changelog; pushing the tag releases.
- The first publish and Trusted Publisher configuration are operator steps
  (below).

## Workstream I — tests

- `test/cli-args.test.ts` — commands/flags, `--help`, `--version`, unknown → 2,
  headless validation.
- `test/cli-home.test.ts` — `resolveCellyHome`, env precedence, `DATA_DIR`
  default, cwd-`.env` isolation.
- `test/cli-wizard.test.ts` — injected streams, hidden token, guild validation,
  `loadConfig` gate, merge-preserve, `0600`, idempotent `setup`.
- `test/cli-doctor.test.ts` — injected runner pass/fail, fix strings, exit codes,
  never boots.
- `test/cli-ui.test.ts` — color on/off, ASCII fallback, aligned table, plain
  non-TTY output.
- `test/package.test.ts` — `package.json` invariants (`name`, no `private`,
  `bin`, `files`, `publishConfig`) and `assets/admin/*` present.
- TDD throughout; the existing suite stays green.

## Workstream J — docs, changeset & release workflow

- README: quick start becomes `npx bot-celly@latest`; clone/build moves under
  "From source"; document `~/.bot-celly`, `CELLY_HOME`, and the `DATA_DIR`
  default; add a "Releases" note (`changeset version` → commit → `git tag
  v<version>` → push tag → CI publishes).
- `AGENTS.md`: add release/tagging to **Commands**
  (`npx changeset version`, `git tag v<version>`, `git push origin v<version>`);
  add to **Definition of done** that releasing is via changesets + a pushed `v*`
  tag and never `npm publish` by hand once Trusted Publishing is live; link the
  new CLI reference.
- `docs-site/quickstart.mdx`: Step 2 becomes the npx install + wizard (source
  build in a collapsible "From source").
- `docs-site/guides/configuration.mdx`: `CELLY_HOME`, `~/.bot-celly/.env`,
  `DATA_DIR` default.
- `docs-site/guides/deployment.mdx` + `deployment-linux.mdx`: npx install before
  the service setup.
- `docs-site/reference/cli.mdx` (new): commands, flags, exit codes, headless;
  add to `docs.json` nav and cross-link from `reference/commands.mdx`.
- `docs-site/reference/limitations.mdx`: npx still needs Node 24 and host `sbx`.
- `docs-site/project/roadmap.mdx`: drop the shipped one-line-install bullet.
- Add a `minor` changeset.

## Explicitly out of scope

- A bootstrap/`curl | sh` front door or hosted install script.
- A React dashboard migration (a future roadmap item) and any change to the
  admin htmx assets beyond shipping them in the tarball.
- Auto-installing host software (`sbx`, Node) or running `sbx login`.
- Service-manager subcommands (`start`/`stop`/`status`/`logs`/`update`).
- Changing `main()`'s preflight, lock, login, or shutdown behavior.
- Making the bot self-update from the admin page.
- Restructuring the 751-line `src/index.ts` (Approach B was rejected).

## Operator steps (on the maintainer, not code)

1. `npm login` as the owning account and do a one-time `npm publish --access public`.
2. Configure Trusted Publisher on npmjs.com for `bot-celly` → GitHub Actions,
   repo `LegendArtur/bot-celly`, workflow `release.yml`.
3. Confirm `repository.url` matches the GitHub repo.
4. Install Node 24 locally (`fnm install 24`).
5. Have host prereqs ready to test the real flow: `sbx` installed + logged in,
   `sbx policy init balanced`, Discord token + guild IDs, a provider secret.

## Definition of done

- `npm test`, `npm run typecheck`, and `npm run build` green.
- `npx bot-celly@latest` (verified via `npm pack` + local install) performs the
  wizard + doctor + boot on a machine with the host prerequisites.
- A `minor` changeset is present; README, `AGENTS.md`, and the affected
  `docs-site/` pages are updated in the same change.
- The argv-only invariant and the containment/policy invariants are intact; no
  secrets are committed.
