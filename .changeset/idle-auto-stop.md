---
"celly": minor
---

Auto-stop idle project sandboxes. `IDLE_STOP_MINUTES` (default 30, `0`
disables) stops a project after that many minutes without messages, prompts,
or `!shell` activity and posts a notice in its channel. The next message wakes
the project again.
