// Session -> thread routing (spec §8). A session can be attached to more than
// one thread after /resume, so routes are one-to-many. A session-originated
// event goes to the thread that owns the current run, else the most recently
// active thread.
export class SessionRoutes {
  private map = new Map<string, string[]>()

  register(sessionId: string, threadId: string): void {
    if (!sessionId) return
    const list = (this.map.get(sessionId) ?? []).filter((id) => id !== threadId)
    list.push(threadId)
    this.map.set(sessionId, list)
  }

  threadsFor(sessionId: string): string[] {
    return [...(this.map.get(sessionId) ?? [])]
  }

  forgetThread(threadId: string): void {
    for (const [sessionId, list] of this.map) {
      const remaining = list.filter((id) => id !== threadId)
      if (remaining.length) this.map.set(sessionId, remaining)
      else this.map.delete(sessionId)
    }
  }

  forgetThreads(threadIds: Iterable<string>): void {
    for (const threadId of threadIds) this.forgetThread(threadId)
  }

  route(
    sessionId: string,
    isActive: (threadId: string) => boolean,
    lastActiveAt: (threadId: string) => number,
  ): string | undefined {
    const list = this.map.get(sessionId)
    if (!list || list.length === 0) return undefined
    const active = list.find((id) => isActive(id))
    if (active) return active
    let best: string | undefined
    let bestAt = Number.NEGATIVE_INFINITY
    for (const id of list) {
      const at = lastActiveAt(id)
      if (best === undefined || at > bestAt) { best = id; bestAt = at }
    }
    return best
  }
}
