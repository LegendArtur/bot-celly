---
"bot-celly": patch
---

Stop echoing the prompt twice in a streamed reply. opencode publishes
`message.part.updated` for the user's own message parts, which the renderer
pushed after the `> **you** · …` quote; the event router now tracks each
message's role from `message.updated` and drops user-authored parts so only the
assistant output is rendered.
