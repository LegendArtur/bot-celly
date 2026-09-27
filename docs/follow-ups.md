# Follow-ups

Tracked items that are deliberately not part of the 0.2.0 verification pass.
Nothing here blocks the current release; each needs a decision or host evidence
before implementation.

1. **Scheduled-task audit entries.** `AuditKind` includes `"task"` and the spec
   mentions audit for scheduled-task execution, but `/task add|remove` and
   `TaskRunner.tick` do not append audit entries. Either audit task runs and
   edits, or drop the unused kind.
2. **OAuth auto-flow verification.** For `method: "auto"`, `/login` currently
   instructs the user to run `/login` again to "verify", but the command starts
   a new authorize flow instead of checking `provider.auth()`/config. Either
   implement the verify path or reword the instructions.
3. **Agent questions on opencode 1.18.32.** The live v1 config surface reports
   `"question": "deny"` even though the policy patches it to `"allow"`, so the
   question UI may never fire (host-verification step 5 records the actual
   behavior). If it does not fire, move the question bridge to the v2
   config/event surface (the v2 client already exists for v2 permission and
   question replies).
4. **`sbx secret` management from Discord.** Deferred: setting/listing provider
   secrets from Discord needs a host spike on `sbx secret ls/set-custom` output
   shape and stdin support. Provider credentials currently go through
   `sbx secret` on the host or OAuth via `/login`.
5. **Per-guild roles.** Access control is global across configured guilds
   (`ACCESS_ROLE_ID`, `BLOCK_ROLE_ID`, `OWNER_ROLE_ID`). Per-guild overrides are
   a follow-up if you run multiple guilds with different staff.
6. **Section 1 residual features** from the spec: cloud sandboxes, browser diff
   viewer, voice messages, image attachments, tunnels/screenshare,
   forum-channel layout, `/project restart`.
7. **Release tag.** No git tag or GitHub release is created for 0.2.0 until the
   host-verification checklist passes and you decide the feature set is
   complete. Version remains `0.2.0` locally.
