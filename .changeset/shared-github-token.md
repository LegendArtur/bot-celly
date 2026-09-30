---
"bot-celly": minor
---

Add an optional shared GitHub token. The setup wizard now asks whether to add
one (and there is a `--github-token` flag for headless setups); `GITHUB_TOKEN`
(with `GH_TOKEN` as a fallback) is copied into every sandbox over stdin at mode
`0600` into `opencode.env` and a `github.com` git credential store, so the agent
can clone, fetch, and push private repos. When a token is configured, `git push`
moves from the hard deny list to the normal approval flow (runs in `auto`, asks
in `buttons`, rejected in `plan`); without one it stays blocked. The token is
host-only, shared across projects, and never stored by Celly.
