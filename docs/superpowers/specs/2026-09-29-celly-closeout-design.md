# Celly close-out design

Status: approved 2026-09-29. Scope: cleanup, structural refactors, README asset
removal, and bash deny-list hardening.

## Goal

Bring the repository to a close: remove dead code and bloat, extract the units
that have outgrown their files, make the test suite cheaper to maintain without
weakening its coverage of load-bearing invariants, remove the hand-made README
hero asset, and close the command-chain bypass in the bot-enforced bash deny
list.

## Decisions already made

1. **The test suite is not gutted.** The 658-test suite is assertion-dense and
   guards the argv-only, containment, policy, saga, and redaction invariants.
   Only provably redundant or dead-code tests are removed (~9). The savings
   come from shared helpers and deduplicated scaffolding.
2. **Indeterminate bash commands fail closed:** `auto` rejects, `buttons` asks,
   `plan` rejects.
3. **Security docs are softened to state residual limits** instead of the
   current absolute claim that the deny list blocks everything.
4. **No lint toolchain.** Adding ESLint and fixing ~108 `any` sites is churn
   without payoff for a closing repository.
5. **No dispatch-map rewrite in `commands.ts`.** The 358-line if-chain stays;
   a behavioral drift test replaces the rewrite as the guard against missing
   branches.

## Workstream A — dead code and docs hygiene

- Remove `parseCustomId` (`src/commands.ts`), `Sbx.cp` (`src/sbx.ts`), and the
  test-only `Config.guildId` field (`src/config.ts`). `DISCORD_GUILD_ID`
  parsing and `guildIds` stay.
- Remove the three dead branches left by the autocomplete→select refactor:
  `/resume` direct-session (`commands.ts:388-393`) and `/model`//`agent`
  direct-value (`commands.ts:406-418`). The options no longer exist in
  `commandData()`, so production can never reach them. Delete the tests that
  inject the removed options.
- Add a behavioral drift test: for every command in `commandData()`, call
  `handleCommand` with a bare fake interaction and assert it does not fall
  through to `"not implemented in this build"`.
- Delete `docs-site/images/demo.svg` and the README hero block; delete the
  unreferenced `docs-site/images/Gemini_Generated_Image_*.jpg`; ignore the
  untracked host-only `/config.json`.
- Fix docs rot: `architecture.mdx` documents the deleted `src/autocomplete.ts`
  and misattributes module responsibilities; `configuration.mdx` says the
  single-instance lock lives in `DATA_DIR` (it is a loopback port);
  `commands.mdx` marks `/queue` as `authorized` while the README says `thread`.
  New modules (`policy`, `typing`, `lists`) join the module map.

## Workstream B — structural refactors

- **`src/policy.ts`** (new): the tokenizer, wrapper tables, normalization,
  deny matching, and approval decisions move out of `src/runner.ts` unchanged.
  `runner.ts` keeps the queue/epoch/abort state machine.
- **`src/typing.ts`** (new): typing-indicator lifecycle extracted from
  `src/index.ts` behind `createTypingIndicators`.
- **`src/lists.ts`** (new): session/model/agent listing plus the stale-while-
  revalidate caches extracted from `src/index.ts`.
- **Shared helpers**: `getErrorMessage`, `unrefTimer`, and a single
  `DISCORD_CHUNK_LIMIT` constant. `replyError` and the health-suffix block are
  deduplicated in `commands.ts`; `handleProjectDown`/`resetChannel` share
  `clearChannelState` in `runner.ts`.
- **One token formatter**: `session-utils.ts` imports `formatTokens` from
  `usage.ts`. `/context-usage` renders `1.3M` instead of `1.3m` (user-visible,
  changeset).
- **Error handling**: `appendLog` failures, ignored `mkdir`/`chmod` in
  `projects.ts`, and `loadAgents`/`listSessions` failures are logged instead of
  swallowed; the no-op `try/catch` around the synchronous cache `refresh()` is
  removed.
- **Tests**: shared `test/helpers/` modules (`fixtures.ts`, `tmp.ts`,
  `http.ts`) replace `freshDb` (53 copies), project/thread fixtures (11 files),
  `withTempDir` (~7 copies), and ad-hoc HTTP servers (~4 files). Six redundant
  tests merge or disappear.

## Workstream C — bash deny-list hardening

The bot-side matcher currently normalizes only the leading command, so
`echo hi; git push`, `true && npm publish`, and `echo $(printenv)` reach
permission evaluation as harmless-looking commands. `opencode`'s server-side
`BASH_DENY` is a second layer but has the same pattern-matching limitation.

New analysis in `src/policy.ts`:

1. Split a command into every simple command on unquoted `;`, `&&`, `||`, `|`,
   `&`, newlines, and subshell parentheses.
2. Extract and recurse into command substitutions (`$(...)`, backticks) and
   subshells, in unquoted and double-quoted contexts. Separators inside single
   quotes are literal and must not split.
3. Parse heredocs: quoted delimiters skip the body; unquoted bodies are scanned
   for substitutions only.
4. Run the existing wrapper/global-option normalization and deny matching on
   each resulting segment. Any match rejects, in every mode, as today.
5. Fail closed on constructs that cannot be statically analyzed:
   process substitution (`<(...)`, `>(...)`), unbalanced quotes/substitutions,
   a substitution in command position, compound constructs
   (`eval`, `source`, `.`, control keywords, `{`/`}`), and executables that are
   variables or command substitutions.
6. Indeterminate commands return `"ask"` from `evaluatePermission` and map to
   **reject in `auto`**, **ask in `buttons`**, **reject in `plan`** in
   `decidePermission`. Explicit deny-list matches stay an absolute reject in
   every mode.

Documentation: rewrite the deny-list bullet in `security.mdx` to describe
full-command analysis and the fail-closed policy, and add a limitations bullet
stating that the deny list is defense-in-depth, not the sandbox boundary
(arbitrary wrapper binaries and encoded payloads are out of scope; the sandbox
is the boundary).

## Explicitly out of scope

- Rewriting the command dispatch chain or the runner state machine.
- Removing back-compat shims that are still live (`DISCORD_GUILD_ID`, legacy
  tool ids, `live_message_id` fallback).
- Lint/format tooling.
- Release/version commits (`changeset version`); changesets are added, the
  version bump is a separate operator decision.
- Any change to `src/sbx.ts` spawn semantics, containment checks, or the
  re-assert-after-wake policy.

## Definition of done

Every milestone ends with `npm test`, `npm run typecheck`, and `npm run build`
green. Every behavior change carries a changeset. README and the affected
`docs-site/` pages are updated in the same change (the security and formatting
changes in particular). The argv-only invariant and the vitest contract stay
intact.
