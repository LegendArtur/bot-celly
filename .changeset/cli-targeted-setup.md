---
"bot-celly": patch
---

`bot-celly setup` can now update a single value without re-running the whole
wizard: pass `--token`, `--guilds`, or `--github-token` to rewrite just those
keys in the env file (an empty `--github-token` removes it). The interactive
wizard also shows existing values and keeps them on Enter, and the GitHub
prompt now offers keep/update/remove.
