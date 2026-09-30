---
"bot-celly": patch
---

Add an owner-only `/dashboard` command that posts the loopback admin console
URL to Discord, and print the console URL in the startup banner. The link is
only reachable on the Celly host; `/dashboard` reports the console as disabled
when `ADMIN_PORT=0`.
