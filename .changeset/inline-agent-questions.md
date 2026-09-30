---
"bot-celly": patch
---

Render agent questions inline in the streamed reply instead of posting them as
separate messages that split the answer around the question. The question (and
its answers) now appears in order in the agent's output, with its
buttons/selects/modals attached to the message holding the question and removed
once the request is answered, rejected, timed out, or dropped. Question text is
also formatted with numbered headers, option descriptions, and per-question
answer lines.
