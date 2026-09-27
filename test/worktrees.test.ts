// test/worktrees.test.ts
import { expect, test } from "vitest"
import { mergeOutcome, parseStatusPorcelain, parseWorktreeList, worktreeBranch, worktreeSlug } from "../src/worktrees.ts"

test("worktreeSlug lowercases, collapses separators, and caps the length", () => {
  expect(worktreeSlug("My Feature!! / v2")).toBe("my-feature-v2")
  expect(worktreeSlug("")).toBe("work")
  expect(worktreeSlug("---")).toBe("work")
  expect(worktreeSlug("a".repeat(60)).length).toBeLessThanOrEqual(30)
})

test("worktreeBranch uses the trailing eight alphanumerics of the thread id", () => {
  expect(worktreeBranch("!!thread-42!!")).toBe("celly/thread42")
  expect(worktreeBranch("123456789012345678")).toBe("celly/12345678")
  expect(worktreeBranch("")).toBe("celly/work")
})

test("parseWorktreeList reads porcelain records and strips refs/heads", () => {
  const porcelain = [
    "worktree /sandbox/celly-demo/workspace",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /sandbox/celly-demo/workspace/.celly/worktrees/my-feature",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/celly/my-feature",
    "",
    "worktree /sandbox/celly-demo/workspace/.celly/worktrees/detached",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "",
  ].join("\n")
  expect(parseWorktreeList(porcelain)).toEqual([
    { path: "/sandbox/celly-demo/workspace", branch: "main" },
    { path: "/sandbox/celly-demo/workspace/.celly/worktrees/my-feature", branch: "celly/my-feature" },
    { path: "/sandbox/celly-demo/workspace/.celly/worktrees/detached" },
  ])
  expect(parseWorktreeList("")).toEqual([])
})

test("parseStatusPorcelain returns changed paths and ignores blanks", () => {
  expect(parseStatusPorcelain(" M src/a.ts\n?? new.txt\n")).toEqual(["src/a.ts", "new.txt"])
  expect(parseStatusPorcelain("R  old.txt -> new.txt\n")).toEqual(["old.txt -> new.txt"])
  expect(parseStatusPorcelain("")).toEqual([])
})

test("mergeOutcome reports success, deduplicated conflicts, and hard failures", () => {
  expect(mergeOutcome("Merge made by the 'ort' strategy.", "", 0)).toEqual({ ok: true, conflicts: [] })
  expect(mergeOutcome("", [
    "CONFLICT (content): Merge conflict in src/a.ts",
    "CONFLICT (content): Merge conflict in src/a.ts",
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n"), 1)).toEqual({ ok: false, conflicts: ["src/a.ts"] })
  expect(mergeOutcome("", "CONFLICT (modify/delete): config.json deleted in HEAD and modified in celly/x.  Version celly/x of config.json left in tree.", 1))
    .toEqual({ ok: false, conflicts: ["config.json"] })
  expect(mergeOutcome("", "fatal: refusing to merge unrelated histories", 128))
    .toEqual({ ok: false, conflicts: [] })
})
