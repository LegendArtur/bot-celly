import { ButtonStyle, ComponentType } from "discord.js"
import { unrefTimer } from "./helpers.js"
import type { QuestionInfo } from "@opencode-ai/sdk/v2"
import type { AuditDraft } from "./audit.ts"
import type { ApprovalMode } from "./mode.ts"

export type ApprovalDecision = "once" | "always" | "reject"
export type ApprovalSource = "v1" | "v2"
export const APPROVAL_ACTION = "approval"
export const ANSWER_ACTION = "answer"
export const REJECT_QUESTION_ACTION = "reject-question"
export const APPROVAL_TIMEOUT_MS = 5 * 60_000
export const MAX_QUESTION_ROWS = 4

export interface PermissionAsk {
  threadId: string
  sessionId: string
  requestId: string
  source: ApprovalSource
  tool: string
  patterns: string[]
  exact: boolean
}
export interface QuestionAsk {
  threadId: string
  sessionId: string
  requestId: string
  source: ApprovalSource
  questions: QuestionInfo[]
}
/**
 * A question is rendered inline in the thread's streamed reply rather than as a
 * standalone message, so the agent's answer is not split around it. The manager
 * emits this state and the caller paints it into the renderer; `components` is
 * null once the request can no longer be answered.
 */
export interface QuestionStateUpdate {
  threadId: string
  requestId: string
  questions: QuestionInfo[]
  text: string
  components: any[] | null
}
export interface ReplyPermissionInput {
  threadId: string
  sessionId: string
  requestId: string
  source: ApprovalSource
  reply: ApprovalDecision
}
export interface ReplyQuestionInput {
  threadId: string
  sessionId: string
  requestId: string
  source: ApprovalSource
  answers: string[][]
}
export interface RejectQuestionInput {
  threadId: string
  sessionId: string
  requestId: string
  source: ApprovalSource
}
/**
 * A question reply/reject could not be delivered to opencode (usually the
 * request already expired server-side). Without recovery the agent tool keeps
 * waiting forever and the thread looks busy, so callers should abort the run.
 */
export interface QuestionDeliveryFailure {
  threadId: string
  sessionId: string
  requestId: string
  action: "reply" | "reject"
  error: string
}
export interface ApprovalManagerDeps {
  send(threadId: string, content: string, components: any[]): Promise<string>
  edit(threadId: string, messageId: string, content: string, components: any[]): Promise<void>
  /**
   * Paint an inline question into the thread's streamed reply. Called for the
   * initial ask, partial answers, and the terminal state (answered, rejected,
   * timed out, inactive).
   */
  onQuestionState?(update: QuestionStateUpdate): void
  replyPermission(input: ReplyPermissionInput): Promise<void>
  replyQuestion(input: ReplyQuestionInput): Promise<void>
  rejectQuestion(input: RejectQuestionInput): Promise<void>
  onQuestionDeliveryFailed?(input: QuestionDeliveryFailure): void
  modeFor(threadId: string): ApprovalMode
  now(): number
  timeoutMs: number
  audit?(entry: AuditDraft): void
  log(msg: string, fields?: Record<string, unknown>): void
}

export function approvalCustomId(requestId: string, decision: ApprovalDecision): string {
  return `celly:${APPROVAL_ACTION}:${requestId}:${decision}`
}
export function answerCustomId(requestId: string, questionIndex: number, optionIndex?: number): string {
  const extra = optionIndex === undefined ? `${questionIndex}` : `${questionIndex}.${optionIndex}`
  return `celly:${ANSWER_ACTION}:${requestId}:${extra}`
}
export function rejectQuestionCustomId(requestId: string): string {
  return `celly:${REJECT_QUESTION_ACTION}:${requestId}`
}

function actionRow(components: any[]): any {
  return { type: ComponentType.ActionRow, components }
}
function button(customId: string, label: string, style: ButtonStyle): any {
  return { type: ComponentType.Button, style, custom_id: customId, label: label.slice(0, 80) }
}
function describePermission(input: PermissionAsk): string {
  const patterns = input.patterns.length ? input.patterns.map((p) => `\`${p}\``).join(", ") : "(no patterns)"
  return `tool \`${input.tool}\` · ${patterns}`
}
function decisionText(decision: ApprovalDecision, actorId: string): string {
  if (decision === "once") return `Permission **approved once** by <@${actorId}>.`
  if (decision === "always") return `Permission **approved always** by <@${actorId}>.`
  return `Permission **rejected** by <@${actorId}>.`
}
function describeQuestions(questions: QuestionInfo[]): string {
  return questions.map((q) => q.question).join(" | ").slice(0, 500)
}
function optionLines(question: QuestionInfo): string {
  const options = (question.options ?? []).filter((option) => typeof option?.label === "string" && option.label)
  if (!options.length) return ""
  return options.map((option) => `  - **${option.label}**${option.description ? ` — ${option.description}` : ""}`).join("\n")
}
function questionBlock(question: QuestionInfo, index: number, answer?: string): string {
  const header = question.header || `Question ${index + 1}`
  const lines = [`**${index + 1}. ${header}**`, question.question]
  const options = optionLines(question)
  if (options) lines.push(options)
  if (answer !== undefined) lines.push(answer)
  return lines.join("\n")
}
const QUESTION_HEADING = "**❓ The agent asked**"
function renderQuestions(questions: QuestionInfo[]): string {
  return clampContent(`${QUESTION_HEADING}\n\n${questions.map((q, i) => questionBlock(q, i)).join("\n\n")}`)
}
function renderQuestionStatus(questions: QuestionInfo[], status: string): string {
  return clampContent(`${QUESTION_HEADING}\n\n${questions.map((q, i) => questionBlock(q, i)).join("\n\n")}\n\n${status}`)
}
const QUESTION_MESSAGE_MAX = 2000
const QUESTION_ANSWER_MAX = 200
function clampContent(text: string, max = QUESTION_MESSAGE_MAX): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).replace(/\s+$/, "") + "…"
}
function answerLine(answers: string[] | undefined): string {
  if (answers === undefined) return "**Waiting for an answer…**"
  const labels = answers.map((answer) => String(answer).trim().slice(0, QUESTION_ANSWER_MAX)).filter(Boolean)
  return labels.length ? `**Answer:** ${labels.join(", ")}` : "**Answer:** _(skipped)_"
}
function renderQuestionProgress(questions: QuestionInfo[], answers: (string[] | undefined)[], actorId?: string): string {
  const blocks = questions.map((q, i) => questionBlock(q, i, answerLine(answers[i])))
  const complete = answers.length > 0 && answers.every((answer) => answer !== undefined)
  const footer = complete && actorId ? `\n\nQuestions **answered** by <@${actorId}>.` : ""
  return clampContent(`${QUESTION_HEADING}\n\n${blocks.join("\n\n")}${footer}`)
}
function questionSelectOptions(question: QuestionInfo): any[] {
  const seen = new Set<string>()
  const options: any[] = []
  for (const option of question.options) {
    const label = String(option.label ?? "").trim().slice(0, 100)
    if (!label || seen.has(label)) continue
    seen.add(label)
    const mapped: any = { label, value: label }
    if (option.description) mapped.description = String(option.description).slice(0, 100)
    options.push(mapped)
    if (options.length >= 25) break
  }
  return options
}
export function questionComponents(requestId: string, questions: QuestionInfo[]): any[] {
  const rows: any[][] = []
  const utility: any[] = []
  const visible = questions.slice(0, MAX_QUESTION_ROWS)
  for (let index = 0; index < visible.length; index++) {
    const question = visible[index]!
    const options = question.options.filter((option) => typeof option?.label === "string" && option.label)
    const custom = question.custom !== false || options.length === 0
    if (options.length > 0 && options.length <= 5 && question.multiple !== true) {
      const buttons = options.map((option, optionIndex) =>
        button(answerCustomId(requestId, index, optionIndex), option.label, ButtonStyle.Secondary))
      if (custom && buttons.length < 5) buttons.push(button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary))
      else if (custom) utility.push(button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary))
      rows.push(buttons)
    } else if (options.length > 0) {
      const selectOptions = questionSelectOptions(question)
      rows.push([{
        type: ComponentType.StringSelect,
        custom_id: answerCustomId(requestId, index),
        placeholder: "Choose an answer",
        min_values: 1,
        max_values: question.multiple === true ? Math.max(1, selectOptions.length) : 1,
        options: selectOptions,
      }])
      if (custom) utility.push(button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary))
    } else {
      rows.push([button(answerCustomId(requestId, index), "Custom answer", ButtonStyle.Secondary)])
    }
  }
  utility.push(button(rejectQuestionCustomId(requestId), "Reject", ButtonStyle.Danger))
  rows.push(utility)
  return rows.map(actionRow)
}

interface PendingPermission {
  input: PermissionAsk
  message: Promise<string | null>
  resolve(decision: ApprovalDecision): void
  timer: ReturnType<typeof setTimeout>
}
interface PendingQuestion {
  input: QuestionAsk
  answers: (string[] | undefined)[]
  resolve(answers: string[][] | null): void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalManager {
  private permissions = new Map<string, PendingPermission>()
  private questions = new Map<string, PendingQuestion>()
  constructor(private readonly deps: ApprovalManagerDeps) {}

  hasPending(requestId: string): boolean {
    return this.permissions.has(requestId) || this.questions.has(requestId)
  }

  private arm(timer: ReturnType<typeof setTimeout>): void {
    unrefTimer(timer)
  }
  /**
   * A pending request that is removed without an authorized member deciding it.
   * Logging the cause makes the "this request is no longer active" reply
   * diagnosable: the drop and the later stale click share a requestId.
   */
  private drop(kind: "permission" | "question", cause: string, input: { threadId: string; sessionId: string; requestId: string }): void {
    this.deps.log(`${kind} request dropped`, { threadId: input.threadId, sessionId: input.sessionId, requestId: input.requestId, cause })
  }
  private async sendSafe(threadId: string, content: string, components: any[]): Promise<string | null> {
    try { return await this.deps.send(threadId, content, components) }
    catch (err) { this.deps.log("approval message send failed", { threadId, error: String(err) }); return null }
  }
  private async editSafe(threadId: string, message: Promise<string | null>, content: string, components: any[] = []): Promise<void> {
    let messageId: string | null = null
    try { messageId = await message } catch { return }
    if (!messageId) return
    try { await this.deps.edit(threadId, messageId, content, components) }
    catch (err) { this.deps.log("approval message edit failed", { threadId, messageId, error: String(err) }) }
  }
  private emitQuestion(input: QuestionAsk, text: string, components: any[] | null): void {
    this.deps.onQuestionState?.({ threadId: input.threadId, requestId: input.requestId, questions: input.questions, text, components })
  }
  private async replyPermissionSafe(input: PermissionAsk, reply: ApprovalDecision): Promise<void> {
    try {
      await this.deps.replyPermission({ threadId: input.threadId, sessionId: input.sessionId, requestId: input.requestId, source: input.source, reply })
    } catch (err) { this.deps.log("permission reply failed", { requestId: input.requestId, error: String(err) }) }
  }
  private async rejectQuestionSafe(input: QuestionAsk): Promise<boolean> {
    try {
      await this.deps.rejectQuestion({ threadId: input.threadId, sessionId: input.sessionId, requestId: input.requestId, source: input.source })
      return true
    } catch (err) {
      const error = String(err)
      this.deps.log("question reject failed", { requestId: input.requestId, error })
      this.deps.onQuestionDeliveryFailed?.({ threadId: input.threadId, sessionId: input.sessionId, requestId: input.requestId, action: "reject", error })
      return false
    }
  }

  async requestPermission(input: PermissionAsk): Promise<ApprovalDecision> {
    if (this.deps.modeFor(input.threadId) !== "buttons") {
      this.deps.audit?.({ kind: "permission", threadId: input.threadId, actorId: "policy", detail: describePermission(input), decision: "reject" })
      await this.replyPermissionSafe(input, "reject")
      return "reject"
    }
    const components = [actionRow([
      button(approvalCustomId(input.requestId, "once"), "Approve once", ButtonStyle.Success),
      button(approvalCustomId(input.requestId, "always"), "Always allow", ButtonStyle.Primary),
      button(approvalCustomId(input.requestId, "reject"), "Reject", ButtonStyle.Danger),
    ])]
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => { void this.timeoutPermission(input.requestId) }, this.deps.timeoutMs)
      this.arm(timer)
      const message = this.sendSafe(input.threadId, `**Permission requested**\n${describePermission(input)}`, components)
      this.permissions.set(input.requestId, { input, message, resolve, timer })
    })
    return decision
  }

  resolvePermission(requestId: string, decision: ApprovalDecision, actorId: string): boolean {
    if (decision !== "once" && decision !== "always" && decision !== "reject") return false
    const pending = this.permissions.get(requestId)
    if (!pending) return false
    this.permissions.delete(requestId)
    clearTimeout(pending.timer)
    this.deps.audit?.({ kind: "permission", threadId: pending.input.threadId, actorId, detail: describePermission(pending.input), decision })
    void this.replyPermissionSafe(pending.input, decision)
    void this.editSafe(pending.input.threadId, pending.message, decisionText(decision, actorId))
    pending.resolve(decision)
    return true
  }

  private async timeoutPermission(requestId: string): Promise<void> {
    const pending = this.permissions.get(requestId)
    if (!pending) return
    this.permissions.delete(requestId)
    this.drop("permission", "timeout", { threadId: pending.input.threadId, sessionId: pending.input.sessionId, requestId })
    this.deps.audit?.({ kind: "permission", threadId: pending.input.threadId, actorId: "timeout", detail: describePermission(pending.input), decision: "reject" })
    await this.replyPermissionSafe(pending.input, "reject")
    await this.editSafe(pending.input.threadId, pending.message, "Permission request **timed out**; rejected.")
    pending.resolve("reject")
  }

  private async timeoutQuestion(requestId: string): Promise<void> {
    const pending = this.questions.get(requestId)
    if (!pending) return
    this.questions.delete(requestId)
    this.drop("question", "timeout", { threadId: pending.input.threadId, sessionId: pending.input.sessionId, requestId })
    this.deps.audit?.({ kind: "question", threadId: pending.input.threadId, actorId: "timeout", detail: describeQuestions(pending.input.questions), decision: "reject" })
    await this.rejectQuestionSafe(pending.input)
    this.emitQuestion(pending.input, renderQuestionStatus(pending.input.questions, "Questions **timed out**; rejected."), null)
    pending.resolve(null)
  }

  async askQuestion(input: QuestionAsk): Promise<string[][] | null> {
    if (this.deps.modeFor(input.threadId) !== "buttons") {
      this.deps.audit?.({ kind: "question", threadId: input.threadId, actorId: "policy", detail: describeQuestions(input.questions), decision: "reject" })
      await this.rejectQuestionSafe(input)
      return null
    }
    const answers: (string[] | undefined)[] = input.questions.map((_q, index) => (index >= MAX_QUESTION_ROWS ? [] : undefined))
    const asked = new Promise<string[][] | null>((resolve) => {
      const timer = setTimeout(() => { void this.timeoutQuestion(input.requestId) }, this.deps.timeoutMs)
      this.arm(timer)
      this.questions.set(input.requestId, { input, answers, resolve, timer })
      this.emitQuestion(input, renderQuestions(input.questions), questionComponents(input.requestId, input.questions))
    })
    return asked
  }

  answerOption(requestId: string, questionIndex: number, optionIndex: number, actorId: string): boolean {
    const pending = this.questions.get(requestId)
    const option = pending?.input.questions[questionIndex]?.options[optionIndex]
    if (!option) return false
    return this.answerQuestion(requestId, questionIndex, [option.label], actorId)
  }

  answerQuestion(requestId: string, questionIndex: number, answers: string[], actorId: string): boolean {
    const pending = this.questions.get(requestId)
    if (!pending || questionIndex < 0 || questionIndex >= pending.input.questions.length) return false
    pending.answers[questionIndex] = answers
    this.deps.audit?.({ kind: "question", threadId: pending.input.threadId, actorId, detail: describeQuestions(pending.input.questions), decision: answers.join(", ") || "empty" })
    if (pending.answers.every((answer) => answer !== undefined)) {
      this.questions.delete(requestId)
      clearTimeout(pending.timer)
      this.completeQuestion(pending, pending.answers.map((answer) => answer ?? []), actorId)
    } else {
      // Keep the remaining controls so the other questions can still be
      // answered, and show what has been picked so far.
      this.emitQuestion(
        pending.input,
        renderQuestionProgress(pending.input.questions, pending.answers),
        questionComponents(pending.input.requestId, pending.input.questions),
      )
    }
    return true
  }

  resolveQuestion(requestId: string, answers: string[][], actorId: string): boolean {
    const pending = this.questions.get(requestId)
    if (!pending || answers.length !== pending.input.questions.length) return false
    this.questions.delete(requestId)
    clearTimeout(pending.timer)
    this.deps.audit?.({ kind: "question", threadId: pending.input.threadId, actorId, detail: describeQuestions(pending.input.questions), decision: answers.map((a) => a.join(", ")).join(" | ") })
    this.completeQuestion(pending, answers, actorId)
    return true
  }

  rejectQuestion(requestId: string, actorId: string): boolean {
    const pending = this.questions.get(requestId)
    if (!pending) return false
    this.questions.delete(requestId)
    clearTimeout(pending.timer)
    this.deps.audit?.({ kind: "question", threadId: pending.input.threadId, actorId, detail: describeQuestions(pending.input.questions), decision: "reject" })
    void this.rejectQuestionSafe(pending.input)
    this.emitQuestion(pending.input, renderQuestionStatus(pending.input.questions, `Questions **rejected** by <@${actorId}>.`), null)
    pending.resolve(null)
    return true
  }

  cancel(sessionId: string, requestId: string, cause = "server-resolved"): void {
    const permission = this.permissions.get(requestId)
    if (permission) {
      this.permissions.delete(requestId)
      clearTimeout(permission.timer)
      this.drop("permission", cause, { threadId: permission.input.threadId, sessionId, requestId })
      void this.editSafe(permission.input.threadId, permission.message, "This request is no longer active.")
      permission.resolve("reject")
      return
    }
    const question = this.questions.get(requestId)
    if (question) {
      this.questions.delete(requestId)
      clearTimeout(question.timer)
      this.drop("question", cause, { threadId: question.input.threadId, sessionId, requestId })
      this.emitQuestion(question.input, renderQuestionStatus(question.input.questions, "This request is no longer active."), null)
      question.resolve(null)
    }
  }

  /**
   * Drop every pending request belonging to a thread. Called when a run ends
   * (idle/error) so requests opencode already discarded during an abort cannot
   * linger as live Discord buttons until the timeout fires.
   */
  cancelThread(threadId: string): void {
    for (const [requestId, permission] of [...this.permissions]) {
      if (permission.input.threadId !== threadId) continue
      this.permissions.delete(requestId)
      clearTimeout(permission.timer)
      this.drop("permission", "run-ended", { threadId, sessionId: permission.input.sessionId, requestId })
      void this.editSafe(permission.input.threadId, permission.message, "This request is no longer active.")
      permission.resolve("reject")
    }
    for (const [requestId, question] of [...this.questions]) {
      if (question.input.threadId !== threadId) continue
      this.questions.delete(requestId)
      clearTimeout(question.timer)
      this.drop("question", "run-ended", { threadId, sessionId: question.input.sessionId, requestId })
      this.emitQuestion(question.input, renderQuestionStatus(question.input.questions, "This request is no longer active."), null)
      question.resolve(null)
    }
  }

  private completeQuestion(pending: PendingQuestion, answers: string[][], actorId: string): void {
    void this.deps.replyQuestion({
      threadId: pending.input.threadId, sessionId: pending.input.sessionId,
      requestId: pending.input.requestId, source: pending.input.source, answers,
    }).catch((err) => {
      const error = String(err)
      this.deps.log("question reply failed", { requestId: pending.input.requestId, error })
      this.emitQuestion(pending.input, renderQuestionStatus(pending.input.questions, "The answer could not be delivered (the request expired). Aborting this run so the thread is not stuck."), null)
      this.deps.onQuestionDeliveryFailed?.({ threadId: pending.input.threadId, sessionId: pending.input.sessionId, requestId: pending.input.requestId, action: "reply", error })
    })
    this.emitQuestion(pending.input, renderQuestionProgress(pending.input.questions, answers, actorId), null)
    pending.resolve(answers)
  }
}
