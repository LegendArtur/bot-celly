# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report it
privately via GitHub's [Report a vulnerability](https://github.com/LegendArtur/bot-celly/security/advisories/new)
flow, or contact [@LegendArtur](https://github.com/LegendArtur) directly.

Include the affected version, a description, and steps to reproduce. You can
expect an acknowledgement within a few days.

## Supported versions

Celly is pre-1.0; security fixes are applied to the latest release on `main`.

## Scope and threat model

Celly's security boundary is the `sbx` sandbox. The bot and host are trusted;
the mounted project directory and anything the agent downloads are treated as
untrusted. Provider credentials are injected by `sbx secret` at the host proxy
and never stored in the bot or the repository.

See the [security reference](https://celly.agub.dev/reference/security) for the
full model, including the argv-only spawn invariant, path containment, the
loopback + password server, and the bot-enforced permission policy.
