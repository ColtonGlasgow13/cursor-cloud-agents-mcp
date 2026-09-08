import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { RateLimitedError, ServerError, formatErrorForTool } from '../../src/client/errors.js';
import { makeClient } from '../helpers/client.js';
import { createAgentFixture, createRunFixture, errorBody, meUserFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';

describe('retry policy', () => {
  useMswServer();

  it('retries a 429 GET after honouring Retry-After, then succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    mswServer.use(
      http.get(`${BASE}/v1/me`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(errorBody('rate_limit_exceeded', 'slow down'), {
            status: 429,
            headers: { 'Retry-After': '2' },
          });
        }
        return HttpResponse.json(meUserFixture);
      }),
    );

    const client = makeClient({ sleep: async (ms) => void waits.push(ms) });
    await expect(client.me()).resolves.toMatchObject({ apiKeyName: 'Production API Key' });
    expect(calls).toBe(2);
    // random() is stubbed to 0, so the wait is exactly the Retry-After value.
    expect(waits).toEqual([2000]);
  });

  it('caps a single Retry-After wait at 30s', async () => {
    let calls = 0;
    const waits: number[] = [];
    mswServer.use(
      http.get(`${BASE}/v1/me`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(errorBody('rate_limit_exceeded', 'slow down'), {
            status: 429,
            headers: { 'Retry-After': '600' },
          });
        }
        return HttpResponse.json(meUserFixture);
      }),
    );
    const client = makeClient({ sleep: async (ms) => void waits.push(ms) });
    await client.me();
    expect(waits).toEqual([30_000]);
  });

  it('reports the full Retry-After to the caller even though a single wait is capped', async () => {
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () =>
        HttpResponse.json(errorBody('rate_limit_exceeded', 'slow down'), {
          status: 429,
          headers: { 'Retry-After': '600' },
        }),
      ),
    );
    const error = await makeClient()
      .launchAgent({ prompt: { text: 'x' } })
      .catch((e: unknown) => e);
    // Capping this at 30s would tell the model to retry ten minutes early.
    expect((error as RateLimitedError).retryAfterMs).toBe(600_000);
    expect(formatErrorForTool(error)).toContain('600s');
  });

  it('parses an HTTP-date Retry-After', async () => {
    const now = Date.parse('2026-04-13T18:30:00.000Z');
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () =>
        HttpResponse.json(errorBody('rate_limit_exceeded', 'slow down'), {
          status: 429,
          headers: { 'Retry-After': 'Mon, 13 Apr 2026 18:30:45 GMT' },
        }),
      ),
    );
    const error = await makeClient({ now: () => now })
      .launchAgent({ prompt: { text: 'x' } })
      .catch((e: unknown) => e);
    expect((error as RateLimitedError).retryAfterMs).toBe(45_000);
  });

  it('never puts the API key or request headers into error details', async () => {
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () =>
        HttpResponse.json(errorBody('rate_limit_exceeded', 'slow down'), {
          status: 429,
          headers: { 'Retry-After': '7', 'X-RateLimit-Remaining': '0' },
        }),
      ),
    );
    const error = await makeClient()
      .launchAgent({ prompt: { text: 'x' } })
      .catch((e: unknown) => e);
    const serialized = JSON.stringify({
      details: (error as RateLimitedError).details,
      text: formatErrorForTool(error),
    });
    expect(serialized).not.toContain('crsr_test_key');
    expect(serialized.toLowerCase()).not.toContain('authorization');
    // The rate-limit RESPONSE headers are still surfaced for diagnosis.
    expect(serialized).toContain('"remaining":"0"');
  });

  it('applies exponential backoff with full jitter between GET retries', async () => {
    const waits: number[] = [];
    mswServer.use(
      http.get(`${BASE}/v1/me`, () => HttpResponse.json(errorBody('internal_error', 'boom'), { status: 500 })),
    );
    const client = makeClient({ sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
    await expect(client.me()).rejects.toBeInstanceOf(ServerError);
    // base 500ms doubling, halved by the stubbed jitter: 500*0.5, 1000*0.5.
    expect(waits).toEqual([250, 500]);
  });

  it('does NOT retry a 429 on a write and surfaces retryAfterMs', async () => {
    let calls = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () => {
        calls += 1;
        return HttpResponse.json(errorBody('rate_limit_exceeded', 'slow down'), {
          status: 429,
          headers: { 'Retry-After': '7', 'X-RateLimit-Remaining': '0' },
        });
      }),
    );

    const error = await makeClient()
      .launchAgent({ prompt: { text: 'x' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterMs).toBe(7000);
    expect(calls).toBe(1);
  });

  it('retries a 5xx GET up to 3 attempts then throws ServerError', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/v1/me`, () => {
        calls += 1;
        return HttpResponse.json(errorBody('internal_error', 'boom'), { status: 500 });
      }),
    );
    await expect(makeClient().me()).rejects.toBeInstanceOf(ServerError);
    expect(calls).toBe(3);
  });

  it('never retries launchAgent (POST /v1/agents) on 5xx', async () => {
    let calls = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () => {
        calls += 1;
        return HttpResponse.json(errorBody('internal_error', 'boom'), { status: 500 });
      }),
    );
    await expect(makeClient().launchAgent({ prompt: { text: 'x' } })).rejects.toBeInstanceOf(ServerError);
    expect(calls).toBe(1);
  });

  it('never retries createRun (POST /v1/agents/{id}/runs) on 5xx', async () => {
    let calls = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents/${AGENT}/runs`, () => {
        calls += 1;
        return HttpResponse.json(errorBody('internal_error', 'boom'), { status: 500 });
      }),
    );
    await expect(
      makeClient().createRun({ agentId: AGENT, body: { prompt: { text: 'x' } } }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(calls).toBe(1);
  });

  it('never retries DELETE on 5xx', async () => {
    let calls = 0;
    mswServer.use(
      http.delete(`${BASE}/v1/agents/${AGENT}`, () => {
        calls += 1;
        return HttpResponse.json(errorBody('internal_error', 'boom'), { status: 500 });
      }),
    );
    await expect(makeClient().deleteAgent({ agentId: AGENT })).rejects.toBeInstanceOf(ServerError);
    expect(calls).toBe(1);
  });

  it('retries a GET that fails at the network level, then succeeds', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/v1/me`, () => {
        calls += 1;
        if (calls < 3) return HttpResponse.error();
        return HttpResponse.json(meUserFixture);
      }),
    );
    await expect(makeClient().me()).resolves.toMatchObject({ apiKeyName: 'Production API Key' });
    expect(calls).toBe(3);
  });

  it('does not retry a write that fails at the network level', async () => {
    let calls = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents/${AGENT}/runs`, () => {
        calls += 1;
        return HttpResponse.error();
      }),
    );
    await expect(
      makeClient().createRun({ agentId: AGENT, body: { prompt: { text: 'x' } } }),
    ).rejects.toThrow(/never retried automatically|Could not reach/);
    expect(calls).toBe(1);
  });

  it('succeeds without retrying when the write works', async () => {
    let creates = 0;
    let runs = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () => {
        creates += 1;
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
      http.post(`${BASE}/v1/agents/${AGENT}/runs`, () => {
        runs += 1;
        return HttpResponse.json(createRunFixture, { status: 201 });
      }),
    );
    const client = makeClient();
    await client.launchAgent({ prompt: { text: 'x' } });
    await client.createRun({ agentId: AGENT, body: { prompt: { text: 'x' } } });
    expect(creates).toBe(1);
    expect(runs).toBe(1);
  });
});
