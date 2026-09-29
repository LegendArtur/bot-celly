---
"celly": patch
---

Evaluate the whole bash command in the permission policy: deny-listed commands
hidden behind separators (`;`, `&&`, `||`, `|`, `&`), command substitutions
(`$(...)`, backticks), or heredoc bodies are now rejected, and commands the
policy cannot statically analyze fail closed (approval in buttons mode,
rejection in auto and plan).
