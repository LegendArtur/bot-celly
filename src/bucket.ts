export interface BucketOptions {
  capacity: number
  refillPerSecond: number
  now(): number
  sleep(ms: number): Promise<void>
}

export class TokenBucket {
  private tokens: number
  private lastRefill: number
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
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      for (;;) {
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
