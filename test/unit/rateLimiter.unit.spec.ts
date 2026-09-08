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
