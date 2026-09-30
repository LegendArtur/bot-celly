# AGENTS.md

Guidance for coding agents working in this repository.

## Project

Celly is a Discord bot that turns Discord into a control surface for OpenCode
coding agents. Each project runs in its own `sbx` (Docker Sandboxes) microVM.
Start with `docs-site/index.mdx` for the model and
`docs-site/reference/architecture.mdx` for the module map.

## Commands

```bash
npm run dev          # tsx watch src/index.ts
npm test             # full vitest suite
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.json
npm run docs:dev     # preview the docs site
npm run docs:validate
npm run docs:links
npx changeset        # add a changeset for a behavior change
npm run changeset:version # bump the version and sync the changelog
```

Releases are tag-driven: run `npm run changeset:version`, commit the bump, then
`git tag v<version> && git push origin v<version>`. The tag triggers
`.github/workflows/release.yml`, which publishes `bot-celly` to npm with Trusted
Publishing (OIDC). Do not run `npm publish` by hand once Trusted Publishing is
configured.

## Definition of done

A change is not done until all of these hold:

1. `npm test`, `npm run typecheck`, and `npm run build` pass.
2. Every change to behavior, configuration, a command, an environment variable,
   or security adds a changeset (`npx changeset`). Docs-only changes do not.
   When cutting a release, bump via changesets and push the `v*` tag instead of
   publishing manually.
3. The affected documentation and the README are reviewed and updated **in the
   same change** (see the table below).
4. No secrets are committed and the argv-only invariant is preserved.

CI enforces (2) and (3) in the `meta` job:
`scripts/check-docs.mjs` fails a pull request when `src/**` or `.env.example`
changes without a changeset, or without a `README.md` / `docs-site/` change.
The `skip-changeset` and `skip-docs` labels bypass the corresponding check and
should be used only with a reason.

## Documentation is part of the change

Documentation is treated as part of the code. When a change touches any row
below, update the matching page(s) **and** the README in the same pull request.

| Change | Update |
| --- | --- |
| User-facing command or access rule | `docs-site/reference/commands.mdx` and the README command tables |
| Environment variable, default, or seed behavior | `docs-site/guides/configuration.mdx` and the README quick start |
| Security or permission behavior | `docs-site/reference/security.mdx` |
| Admin page, logs, backups, rotation, restore | `docs-site/guides/operations.mdx` |
| Limitation | `docs-site/reference/limitations.mdx` and the README Limitations |
| Known upstream bug or workaround | `docs-site/reference/known-issues.mdx` and the README Known issues |
| Roadmap or deferred feature | `docs-site/project/roadmap.mdx` and the README roadmap |
| Host bootstrap or service setup | `docs-site/quickstart.mdx` and `docs-site/guides/deployment*.mdx` |
| CLI command, flag, or install path | `docs-site/reference/cli.mdx`, the README quick start, and `docs-site/quickstart.mdx` |
| Runtime, dependency, or tooling | `docs-site/project/tech-stack.mdx` |
| Module, saga, or event flow | `docs-site/reference/architecture.mdx` |

Single sources of truth — link to them, do not copy them:

- **Configuration** (`guides/configuration`) — env vars and the path denylist.
- **Security** (`reference/security`) — invariants and the permission policy.
- **Commands** (`reference/commands`) — the command surface.
- **Operations** (`guides/operations`) — admin page, logs, backups.
- **Limitations** (`reference/limitations`) — the canonical limitations.
- **Known issues** (`reference/known-issues`) — confirmed bugs and workarounds.
- **Roadmap** (`project/roadmap`) — planned and deferred features.
- **Tech stack** (`project/tech-stack`) — runtime, tooling, credits.

Reusable docs blocks live in `docs-site/snippets/` and are included with
`<Snippet file="snippets/<name>.mdx" />`.

## Invariants

- **argv-only.** Never pass user input through a host shell. Every `sbx`
  invocation goes through `src/sbx.ts` with `spawn(bin, args, { shell: false })`;
  only that module may import `child_process`.
- **Containment.** All path checks go through the shared helper.
- **Policy.** Never weaken the bot-enforced permission policy or the
  re-assert-after-wake behavior.
- **Tests.** The vitest suite is the contract; add or update tests for any
  behavior change.
