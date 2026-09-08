import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { LocalRateLimitError } from '../../src/client/errors.js';
import { RateLimiter, TokenBucket } from '../../src/client/rateLimiter.js';
import { fakeClock, makeClient } from '../helpers/client.js';
import { repositoriesFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

describe('TokenBucket', () => {
  it('refills continuously and reports the wait for the next token', () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket({ capacity: 2, refillIntervalMs: 60_000, now: clock.now });

    expect(bucket.msUntilToken()).toBe(0);
    bucket.consume();
    bucket.consume();
    // Empty: 2 tokens per 60s means one token every 30s.
    expect(bucket.msUntilToken()).toBe(30_000);

    clock.advance(30_000);
    expect(bucket.msUntilToken()).toBe(0);
    bucket.consume();
    expect(bucket.msUntilToken()).toBe(30_000);
  });

  it('never accumulates more than its capacity', () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket({ capacity: 3, refillIntervalMs: 1000, now: clock.now });
    clock.advance(60_000);
    bucket.consume();
    bucket.consume();
    bucket.consume();
    expect(bucket.msUntilToken()).toBeGreaterThan(0);
  });
});

describe('RateLimiter', () => {
  it('waits for the global bucket when the wait is short', async () => {
    const clock = fakeClock(0);
    const limiter = new RateLimiter({ perMinute: 60, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 60; i += 1) await limiter.acquire();
    const before = clock.now();
    await limiter.acquire();
    expect(clock.now() - before).toBe(1000);
  });

  it('refuses instead of waiting when the wait exceeds the ceiling', async () => {
    const clock = fakeClock(0);
    const limiter = new RateLimiter({ perMinute: 2, now: clock.now, sleep: clock.sleep });
    await limiter.acquire();
    await limiter.acquire();
    const error = await limiter.acquire().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalRateLimitError);
    expect((error as LocalRateLimitError).retryAfterMs).toBe(30_000);
  });

  it('refuses a second /v1/repositories call inside the same minute', async () => {
    const clock = fakeClock(0);
    const limiter = new RateLimiter({ perMinute: 100, now: clock.now, sleep: clock.sleep });
    await limiter.acquire('repositories');
    const error = await limiter.acquire('repositories').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalRateLimitError);
    expect((error as LocalRateLimitError).retryAfterMs).toBe(60_000);
    expect((error as LocalRateLimitError).message).toContain('1 request/minute');
    // ... while ordinary calls are unaffected.
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});

describe('list_repositories budget in the client', () => {
  useMswServer();

  it('serves the second call from cache without touching the API', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/v1/repositories`, () => {
        calls += 1;
        return HttpResponse.json(repositoriesFixture);
      }),
    );
    const clock = fakeClock(0);
    const client = makeClient({ now: clock.now, sleep: clock.sleep, rateLimitPerMin: 100 });

    await client.listRepositories();
    await client.listRepositories();
    expect(calls).toBe(1);

    // Forcing a refresh inside the same minute is refused locally, not sent.
    await expect(client.listRepositories({ refresh: true })).rejects.toBeInstanceOf(LocalRateLimitError);
    expect(calls).toBe(1);
  });
});

describe('RateLimiter wait ceiling', () => {
  it('never waits longer than maxWaitMs in total, even across repeated retries', async () => {
    // A sleep that does not advance the clock stands in for a competing caller
    // stealing the token we just waited for.
    const clock = fakeClock(0);
    const slept: number[] = [];
    const limiter = new RateLimiter({
      perMinute: 6, // one token every 10s once empty
      maxWaitMs: 15_000,
      now: clock.now,
      sleep: async (ms) => void slept.push(ms),
    });
    for (let i = 0; i < 6; i += 1) await limiter.acquire();

    const error = await limiter.acquire().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalRateLimitError);
    const total = slept.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(15_000);
    expect(slept.every((ms) => ms > 0)).toBe(true);
  });

  it('enforces the hourly repositories budget on top of the per-minute one', async () => {
    const clock = fakeClock(0);
    const limiter = new RateLimiter({ perMinute: 1000, now: clock.now, sleep: clock.sleep });
    // Spacing every call a full minute apart keeps the 1/minute bucket happy,
    // so anything that refuses here can only be the hourly bucket. (It is a
    // token bucket: 30 burst tokens plus 30/hour of refill, so it binds after
    // roughly an hour of once-a-minute calls rather than after exactly 30.)
    let succeeded = 0;
    let error: unknown;
    for (let call = 0; call < 200; call += 1) {
      try {
        await limiter.acquire('repositories');
        succeeded += 1;
        clock.advance(60_000);
      } catch (thrown) {
        error = thrown;
        break;
      }
    }

    expect(error).toBeInstanceOf(LocalRateLimitError);
    expect(succeeded).toBeLessThan(70);
    expect((error as LocalRateLimitError).retryAfterMs).toBeGreaterThan(15_000);
    expect((error as LocalRateLimitError).message).toContain('30/hour');
  });
});
