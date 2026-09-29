---
"bot-celly": patch
---

Verify the bot-enforced permission policy before writing it. A config `PATCH`
disposes the project's OpenCode instance and aborts every running thread, so
Celly now reads the running policy after each wake and health check and only
re-writes it when a rule is missing or weakened. This stops a message in one
thread from aborting every other concurrent thread in the same project.
