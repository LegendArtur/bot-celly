# celly

## 0.1.0

### Highlights

Initial release: a Discord control surface for OpenCode agents, with one
isolated `sbx` sandbox per project.

### Core model

- Channel = project (one sandbox, one host directory); thread = session (one
  OpenCode conversation).
- The bot runs natively on the `sbx` host and supervises a long-lived
  `sbx exec ... opencode serve` child per project.

### Commands

- Project lifecycle: `/project add`, `create`, `list`, `status`, `start`,
  `stop`, `remove`.
- Sessions: `/new`, `/resume`, `/abort`, `/model`, `/agent`.
- `!<command>` runs a shell command inside the sandbox.

### Features

- Streaming replies throttled into a single live message, with fence-aware
  chunking.
- Session resume and per-thread model/agent overrides.
- Text attachments written to a validated `.celly/inbox`.
- Access control via guild owner, `Manage Guild`/`Administrator`, an access
  role, and a block role.
- Terminal coexistence: the same sessions are reachable from an attached
  terminal.

### Security

- argv-only `sbx` spawns, per-project microVM isolation, path containment, and
  a sensitive-path denylist.
- Loopback-only server with a generated password.
- Bot-enforced permission policy re-asserted after every wake.

### Known limitations

- The in-memory message queue is lost on restart.
- Role configuration accepts role IDs only.
- The finalization token/duration footer is descoped.
