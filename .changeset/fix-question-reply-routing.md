---
"bot-celly": patch
---

Fix agent questions never reaching opencode: reply to v1 (`question.asked`) requests through the instance `/question/:id/reply` route (v2 sessions keep the session-scoped route), react to server-side question.replied/rejected events, clear pending questions when a run idles, and abort instead of wedging forever when a reply can no longer be delivered.
