# Follow-ups

Tracked items that are deliberately not part of the 0.2.0 verification pass.
Nothing here blocks the current release; each needs a decision or host evidence
before implementation.

1. **`sbx secret` management from Discord.** Deferred: setting/listing provider
   secrets from Discord needs a host spike on `sbx secret ls/set-custom` output
   shape and stdin support. Provider credentials currently go through
   `sbx secret` on the host.
2. **Per-guild roles.** Access control is global across configured guilds
   (`ACCESS_ROLE_ID`, `BLOCK_ROLE_ID`, `OWNER_ROLE_ID`). Per-guild overrides are
   a follow-up if you run multiple guilds with different staff.
3. **Section 1 residual features** from the spec: cloud sandboxes, browser diff
   viewer, voice messages, image attachments, tunnels/screenshare,
   forum-channel layout, `/project restart`.
4. **Release tag.** No git tag or GitHub release is created for 0.2.0 until the
   host-verification checklist passes and you decide the feature set is
   complete. Version remains `0.2.0` locally.
