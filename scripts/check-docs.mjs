#!/usr/bin/env node
// Fails a pull request when code changes ship without a changeset or without a
// docs/README update. CI provides CHANGED_FILES (newline-separated) and
// PR_LABELS (comma-separated). See AGENTS.md for what to update.
const changed = (process.env.CHANGED_FILES ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
const labels = new Set(
  (process.env.PR_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean),
)

if (changed.length === 0) {
  console.log("No changed files detected; skipping docs/changeset check.")
  process.exit(0)
}

const touchesBehavior = (file) =>
  file.startsWith("src/") || file === ".env.example"
const touchesManifest = (file) => file === "package.json"
const touchesDocs = (file) => file === "README.md" || file.startsWith("docs-site/")
const isChangeset = (file) =>
  file.startsWith(".changeset/") &&
  file.endsWith(".md") &&
  file !== ".changeset/README.md"

const needsChangeset = changed.some(
  (file) => touchesBehavior(file) || touchesManifest(file),
)
const needsDocs = changed.some(touchesBehavior)

const changesetAdded = changed.some(isChangeset)
const docsChanged = changed.some(touchesDocs)

const problems = []
if (needsChangeset && !changesetAdded && !labels.has("skip-changeset")) {
  problems.push(
    "Code changed but no changeset was added. Run `npx changeset` (or apply the `skip-changeset` label).",
  )
}
if (needsDocs && !docsChanged && !labels.has("skip-docs")) {
  problems.push(
    "Code changed but neither README.md nor docs-site/ was updated. Review the docs (see AGENTS.md) or apply the `skip-docs` label.",
  )
}

if (problems.length > 0) {
  console.error("Documentation/changeset check failed:\n")
  for (const problem of problems) console.error(`- ${problem}`)
  console.error("\nSee AGENTS.md for what to update.")
  process.exit(1)
}

console.log("Documentation/changeset check passed.")
