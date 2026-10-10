---
"bot-celly": minor
---

Guided Discord onboarding in `bot-celly`/`bot-celly setup`: the bot token is now
verified against Discord, the required Gateway Intents are checked (with a direct
Developer Portal link when one is off), a ready-made invite URL is printed, and
the guilds the bot can see are listed so you can pick one instead of pasting IDs.
`bot-celly doctor` gained a Discord row that reports the bot identity, the intent
state, and a bad token (hard) versus an unreachable API (advisory). Everything
still works offline, falling back to the previous manual token/guild entry.
