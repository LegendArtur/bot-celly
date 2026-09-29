import { unrefTimer } from "./helpers.js"

export interface TypingDeps {
  bucketFor(threadId: string): string
  sendTyping(threadId: string, bucketChannelId: string): Promise<void>
}

export function createTypingIndicators(deps: TypingDeps): { start(threadId: string): void; stop(threadId: string): void } {
  const timers = new Map<string, ReturnType<typeof setInterval>>()
  const stop = (threadId: string): void => {
    const timer = timers.get(threadId)
    if (timer) { clearInterval(timer); timers.delete(threadId) }
  }
  const start = (threadId: string): void => {
    if (timers.has(threadId)) return
    const bucketChannelId = deps.bucketFor(threadId)
    const tick = async (): Promise<void> => {
      try { await deps.sendTyping(threadId, bucketChannelId) } catch {}
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 8000)
    unrefTimer(timer)
    timers.set(threadId, timer)
  }
  return { start, stop }
}
