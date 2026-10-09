---
"bot-celly": patch
---

Fix projects failing to wake after `GITHUB_TOKEN` is added or removed: the
sandbox policy files are now rewritten on every (re)start, and a server still
running with the old baked policy is rebooted automatically instead of failing
the wake with "celly permission policy was not enforced".
