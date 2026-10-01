---
"bot-celly": minor
---

Smart thread names: managed threads now show a live status prefix
(`🟢 working`, `⛔ blocked`, `⏸️ idle`, `❌ error`, `⏹️ stopping`) and let the
session agent author a short title once, in-band, before it locks. The new
`SMART_THREAD_NAMES` setting (default on) gates the feature; sandboxes get a
global naming instruction at bootstrap.
