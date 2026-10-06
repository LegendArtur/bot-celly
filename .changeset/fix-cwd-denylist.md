---
"bot-celly": patch
---

Fix the sensitive-path denylist rejecting every project when Celly's working
directory contains `PROJECTS_ROOT`. The default systemd unit runs Celly with
`WorkingDirectory=%h`, so `process.cwd()` (home) overlapped the default
`~/Celly/projects` and every project under it was treated as sensitive. The
working directory is now skipped when it is an ancestor of `PROJECTS_ROOT`;
the bot repository itself stays denied in every other case.
