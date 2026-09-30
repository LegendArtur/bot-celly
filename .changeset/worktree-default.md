---
"bot-celly": minor
---

Start new sessions in their own git worktree. Add `WORKTREE_DEFAULT` (global,
seeded once into `settings.worktree_default`), an owner-only
`/worktree default state:<inherit|on|off>` per-project override, and a
`new_worktree` option on `/fork`. Non-git projects, an unresolved sandbox path,
or a failed `git worktree add` fall back to the project root with a console
warning instead of failing session creation.
