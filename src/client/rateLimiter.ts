import { LocalRateLimitError } from './errors.js';

/**
 * Client-side request budget.
 *
 * The API's documented default is 20 requests/minute, and GET /v1/repositories
 * is far stricter (1/minute AND 30/hour). Spending the budget locally is much
 * cheaper than discovering it through 429s.
 */

export interface TokenBucketOptions {
  /** Maximum tokens held at once. */
  capacity: number;
  /** Milliseconds it takes to refill `capacity` tokens (continuous refill). */
  refillIntervalMs: number;
  now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly tokensPerMs: number;
  private readonly now: () => number;
  private tokens: number;
  private updatedAt: number;

  constructor({ capacity, refillIntervalMs, now = Date.now }: TokenBucketOptions) {
    this.capacity = capacity;
    this.tokensPerMs = capacity / refillIntervalMs;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  private refill(): void {
    const at = this.now();
    const elapsed = Math.max(0, at - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.tokensPerMs);
    this.updatedAt = at;
  }

  /** Milliseconds until one token is available (0 if available now). */
  msUntilToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.tokensPerMs);
  }

  /** Spends one token. Call only after `msUntilToken()` returned 0. */
  consume(): void {
    this.refill();
    this.tokens -= 1;
  }
}

export type BucketName = 'global' | 'repositories';

export interface RateLimiterOptions {
  /** Global budget, from CURSOR_MCP_RATE_LIMIT_PER_MIN. */
  perMinute: number;
  /** Longest we will silently wait for a token before failing fast. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_WAIT_MS = 15_000;

export class RateLimiter {
  private readonly global: TokenBucket;
  private readonly repositoriesPerMinute: TokenBucket;
  private readonly repositoriesPerHour: TokenBucket;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    perMinute,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    now = Date.now,
    sleep = (ms) => new Promise<void>((resolve) => void setTimeout(resolve, ms)),
  }: RateLimiterOptions) {
    this.maxWaitMs = maxWaitMs;
    this.sleep = sleep;
    this.global = new TokenBucket({ capacity: perMinute, refillIntervalMs: 60_000, now });
    // Documented override: 1 request/user/minute and 30/user/hour.
    this.repositoriesPerMinute = new TokenBucket({ capacity: 1, refillIntervalMs: 60_000, now });
    this.repositoriesPerHour = new TokenBucket({ capacity: 30, refillIntervalMs: 3_600_000, now });
  }

  private bucketsFor(name: BucketName): TokenBucket[] {
    if (name === 'repositories') {
      return [this.global, this.repositoriesPerMinute, this.repositoriesPerHour];
    }
    return [this.global];
  }

  /**
   * Waits (up to maxWaitMs) for a token in every bucket the call touches, then
   * spends one from each. Throws LocalRateLimitError if the wait would be
   * longer — no request is sent in that case.
   */
  async acquire(name: BucketName = 'global'): Promise<void> {
    const buckets = this.bucketsFor(name);
    // Budget is cumulative across retries: a caller must never sit here for
    // longer than maxWaitMs in total, however many times a concurrent acquire
    // steals the token we were waiting for.
    let remainingBudgetMs = this.maxWaitMs;
    for (;;) {
      const waitMs = Math.max(0, ...buckets.map((bucket) => bucket.msUntilToken()));
      if (waitMs === 0) {
        for (const bucket of buckets) bucket.consume();
        return;
      }
      if (waitMs > remainingBudgetMs) throw this.refuse(name, waitMs);
      remainingBudgetMs -= waitMs;
      await this.sleep(waitMs);
    }
  }

  private refuse(name: BucketName, retryAfterMs: number): LocalRateLimitError {
    const seconds = Math.ceil(retryAfterMs / 1000);
    const scope =
      name === 'repositories'
        ? 'GET /v1/repositories is limited to 1 request/minute and 30/hour'
        : 'the client request budget (CURSOR_MCP_RATE_LIMIT_PER_MIN) is exhausted';
    return new LocalRateLimitError({
      message: `Request not sent: ${scope}. Try again in ${seconds}s.`,
      retryAfterMs,
      guidance:
        name === 'repositories'
          ? `Wait ${seconds}s and call list_repositories again, or reuse the repository URLs you already have — results are cached for 10 minutes.`
          : `Wait ${seconds}s before retrying. If you are polling a run, increase the delay between get_run_events calls (each poll costs one request).`,
    });
  }
}
