// test/approvals.test.ts
import { expect, test, vi } from "vitest"
import { ComponentType } from "discord.js"
import {
  APPROVAL_TIMEOUT_MS, ApprovalManager, answerCustomId, approvalCustomId, questionComponents, rejectQuestionCustomId,
  type ApprovalManagerDeps, type PermissionAsk, type QuestionAsk,
} from "../src/approvals.ts"

const question = (over: any = {}) => ({
  question: "Which database?",
  header: "Database",
  options: [{ label: "sqlite", description: "single file" }, { label: "postgres", description: "server" }],
  ...over,
})
const permission: PermissionAsk = { threadId: "t1", sessionId: "s1", requestId: "r1", source: "v1", tool: "bash", patterns: ["npm test"], exact: true }
const questions: QuestionAsk = { threadId: "t1", sessionId: "s1", requestId: "q1", questions: [question()] }

function fake(over: Partial<ApprovalManagerDeps> = {}) {
  const sent: Array<{ threadId: string; content: string; components: any[] }> = []
  const edited: Array<{ threadId: string; messageId: string; content: string; components: any[] }> = []
  const permissionsReplied: any[] = []
  const questionsReplied: any[] = []
  const questionsRejected: any[] = []
  const audits: any[] = []
  let n = 0
  const deps: ApprovalManagerDeps = {
    send: async (threadId, content, components) => { sent.push({ threadId, content, components }); return `m${++n}` },
    edit: async (threadId, messageId, content, components) => { edited.push({ threadId, messageId, content, components }) },
    replyPermission: async (input) => { permissionsReplied.push(input) },
    replyQuestion: async (input) => { questionsReplied.push(input) },
    rejectQuestion: async (input) => { questionsRejected.push(input) },
    modeFor: () => "buttons",
    now: () => 1000,
    timeoutMs: APPROVAL_TIMEOUT_MS,
    audit: (entry) => { audits.push(entry) },
    log: () => {},
    ...over,
  }
  return { deps, sent, edited, permissionsReplied, questionsReplied, questionsRejected, audits }
}

test("requestPermission posts three buttons and resolves the chosen decision", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const pending = manager.requestPermission(permission)
  expect(f.sent[0]!.threadId).toBe("t1")
  const row = f.sent[0]!.components[0]
  expect(row.components.map((c: any) => c.custom_id)).toEqual([
    "celly:approval:r1:once", "celly:approval:r1:always", "celly:approval:r1:reject",
  ])
  expect(manager.resolvePermission("r1", "always", "u1")).toBe(true)
  await expect(pending).resolves.toBe("always")
  expect(f.permissionsReplied).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "r1", source: "v1", reply: "always" }])
  expect(f.edited[0]!.content).toContain("approved always")
  expect(f.audits[0]).toMatchObject({ kind: "permission", actorId: "u1", decision: "always" })
})

test("resolvePermission ignores unknown requests and invalid decisions", () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  expect(manager.resolvePermission("nope", "once", "u1")).toBe(false)
  expect(manager.resolvePermission("nope", "yolo" as any, "u1")).toBe(false)
})

test("requestPermission times out to reject and edits the message", async () => {
  vi.useFakeTimers()
  try {
    const f = fake({ timeoutMs: 1000 })
    const manager = new ApprovalManager(f.deps)
    const pending = manager.requestPermission(permission)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe("reject")
    expect(f.permissionsReplied[0]).toMatchObject({ reply: "reject" })
    expect(f.edited[0]!.content).toMatch(/timed out/)
    expect(f.audits[0]).toMatchObject({ actorId: "timeout", decision: "reject" })
  } finally {
    vi.useRealTimers()
  }
})

test("requestPermission outside buttons mode rejects immediately without posting", async () => {
  const f = fake({ modeFor: () => "plan" })
  const manager = new ApprovalManager(f.deps)
  await expect(manager.requestPermission(permission)).resolves.toBe("reject")
  expect(f.sent).toEqual([])
  expect(f.permissionsReplied).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "r1", source: "v1", reply: "reject" }])
})

test("askQuestion collects multi-question answers in order and replies once", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const input: QuestionAsk = { ...questions, questions: [question(), question({ question: "Deploy?", header: "Deploy", options: [] })] }
  const pending = manager.askQuestion(input)
  expect(f.sent).toHaveLength(1)
  expect(manager.answerOption("q1", 0, 1, "u1")).toBe(true)
  expect(f.questionsReplied).toEqual([])
  expect(manager.answerQuestion("q1", 1, ["yes"], "u2")).toBe(true)
  await expect(pending).resolves.toEqual([["postgres"], ["yes"]])
  expect(f.questionsReplied[0]).toEqual({ threadId: "t1", sessionId: "s1", requestId: "q1", answers: [["postgres"], ["yes"]] })
  expect(f.edited[0]!.content).toContain("answered")
  expect(f.audits).toHaveLength(2)
})

test("resolveQuestion completes a pending request with the full answer matrix", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const pending = manager.askQuestion(questions)
  expect(manager.resolveQuestion("q1", [["postgres"]], "u1")).toBe(true)
  await expect(pending).resolves.toEqual([["postgres"]])
  expect(f.questionsReplied[0]).toMatchObject({ answers: [["postgres"]] })
  expect(manager.resolveQuestion("q1", [["x"]], "u1")).toBe(false)
})

test("askQuestion renders a select above five options and keeps components/custom ids legal", () => {
  const options = Array.from({ length: 8 }, (_, i) => ({ label: `option-${i}`, description: `d${i}` }))
  const rows = questionComponents("r".repeat(32), [question({ options }), question(), question(), question(), question()])
  expect(rows.length).toBeLessThanOrEqual(5)
  expect(rows[0]!.components[0].type).toBe(ComponentType.StringSelect)
  expect(rows[0]!.components[0].options).toHaveLength(8)
  for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(5)
  for (const id of [approvalCustomId("r".repeat(32), "always"), answerCustomId("r".repeat(32), 4, 24), rejectQuestionCustomId("r".repeat(32))]) {
    expect(id.length).toBeLessThanOrEqual(100)
  }
})

test("askQuestion times out to null and rejects the server request", async () => {
  vi.useFakeTimers()
  try {
    const f = fake({ timeoutMs: 1000 })
    const manager = new ApprovalManager(f.deps)
    const pending = manager.askQuestion(questions)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBeNull()
    expect(f.questionsRejected).toEqual([{ threadId: "t1", sessionId: "s1", requestId: "q1" }])
    expect(f.edited[0]!.content).toMatch(/timed out/)
  } finally {
    vi.useRealTimers()
  }
})

test("rejectQuestion resolves null and cancel clears a pending request", async () => {
  const f = fake()
  const manager = new ApprovalManager(f.deps)
  const pendingQuestion = manager.askQuestion(questions)
  expect(manager.rejectQuestion("q1", "u1")).toBe(true)
  await expect(pendingQuestion).resolves.toBeNull()
  expect(f.questionsRejected).toHaveLength(1)

  const pendingPermission = manager.requestPermission(permission)
  manager.cancel("s1", "r1")
  await expect(pendingPermission).resolves.toBe("reject")
  expect(f.edited.some((e) => e.content.includes("no longer active"))).toBe(true)
})

test("askQuestion outside buttons mode rejects without posting", async () => {
  const f = fake({ modeFor: () => "auto" })
  const manager = new ApprovalManager(f.deps)
  await expect(manager.askQuestion(questions)).resolves.toBeNull()
  expect(f.sent).toEqual([])
  expect(f.questionsRejected).toHaveLength(1)
})
