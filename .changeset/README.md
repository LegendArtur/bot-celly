# Changesets

This folder holds [changesets](https://github.com/changesets/changesets) — one
small markdown file per pull request describing what changed.

Add one with:

```bash
npx changeset
```

Pick the bump (patch/minor/major) and write a short summary. On release,
`npm run changeset:version` bumps `package.json`, updates `CHANGELOG.md`, and
regenerates the docs changelog page (`docs-site/changelog.mdx`).
