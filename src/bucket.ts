export interface BucketOptions {
  capacity: number
  refillPerSecond: number
  now(): number
  sleep(ms: number): Promise<void>
}

export class TokenBucket {
  private tokens: number
  private lastRefill: number
  private pausedUntil = 0
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly opts: BucketOptions) {
    this.tokens = opts.capacity
    this.lastRefill = opts.now()
  }
  private refill(): void {
    const now = this.opts.now()
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return
    this.tokens = Math.min(this.opts.capacity, this.tokens + (elapsed / 1000) * this.opts.refillPerSecond)
    this.lastRefill = now
  }
  /** Hold every queued send until `ms` from now, e.g. after a Discord 429. */
  pause(ms: number): void {
    const until = this.opts.now() + Math.max(0, ms)
    if (until > this.pausedUntil) this.pausedUntil = until
  }
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      for (;;) {
        const now = this.opts.now()
        if (now < this.pausedUntil) { await this.opts.sleep(this.pausedUntil - now); continue }
        this.refill()
        if (this.tokens >= 1) { this.tokens -= 1; break }
        const needed = ((1 - this.tokens) / this.opts.refillPerSecond) * 1000
        await this.opts.sleep(Math.max(1, Math.ceil(needed)))
      }
      return fn()
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Discord surfaces rate limits as 429 errors with a `retry_after` (seconds, in
 * the raw error) or a `retryAfter` (ms). Returns the pause in ms for a 429 and
 * `undefined` for anything else, so callers only pause on rate limits.
 */
export function retryAfterMs(error: unknown, fallbackMs: number): number | undefined {
  const e = error as { status?: unknown; retryAfter?: unknown; rawError?: { retry_after?: unknown; retryAfter?: unknown } } | undefined
  const status = e?.status ?? (e?.rawError as { status?: unknown } | undefined)?.status
  if (status !== 429) return undefined
  const millis = e?.retryAfter ?? e?.rawError?.retryAfter
  if (typeof millis === "number" && Number.isFinite(millis) && millis >= 0) return millis
  const seconds = e?.rawError?.retry_after
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  return fallbackMs
}

export interface ChannelBucketsOptions {
  idleMs?: number
  now?(): number
}

export class ChannelBuckets {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastUsed: number }>()
  constructor(private readonly factory: () => TokenBucket, private readonly options: ChannelBucketsOptions = {}) {}
  private now(): number { return this.options.now ? this.options.now() : Date.now() }
  private evict(now: number): void {
    const idleMs = this.options.idleMs ?? 30 * 60_000
    for (const [id, entry] of this.buckets) {
      if (now - entry.lastUsed > idleMs) this.buckets.delete(id)
    }
  }
  for(channelId: string): TokenBucket {
    const now = this.now()
    this.evict(now)
    let entry = this.buckets.get(channelId)
    if (!entry) { entry = { bucket: this.factory(), lastUsed: now }; this.buckets.set(channelId, entry) }
    entry.lastUsed = now
    return entry.bucket
  }
  size(): number { return this.buckets.size }
}
