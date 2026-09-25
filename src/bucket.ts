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

export class ChannelBuckets {
  private readonly buckets = new Map<string, TokenBucket>()
  constructor(private readonly factory: () => TokenBucket) {}
  for(channelId: string): TokenBucket {
    let bucket = this.buckets.get(channelId)
    if (!bucket) { bucket = this.factory(); this.buckets.set(channelId, bucket) }
    return bucket
  }
}
