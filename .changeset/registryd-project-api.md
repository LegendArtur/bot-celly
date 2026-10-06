---
"bot-celly": minor
---

Add registry-facing project endpoints to the loopback admin API. `POST
/api/projects` now accepts JSON `{ "name", "path" }`, validates the path against
`PROJECTS_ROOT` and the sensitive-path denylist, runs the existing create saga,
and returns `{ channelId, status }` (`409` for an already-registered path,
`400`/`403` for invalid or disallowed paths). `DELETE /api/projects/<channelId>`
runs the existing remove saga and returns `204` (`404` when unknown). `GET
/api/projects` returns `[{ channelId, path, status }]` using registryd's status
vocabulary.
