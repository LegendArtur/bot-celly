---
"bot-celly": patch
---

Fix broken code blocks in long Discord replies: Celly now always emits fences
of exactly three backticks and reopens a split code block with its language,
instead of escalating to four-backtick fences that Discord renders as literal
text. One-shot notices and errors (handler failures, project stopped, sandbox
missing, project connected, idle timeout) are now posted as Components v2 cards
with a tone-coloured accent.
