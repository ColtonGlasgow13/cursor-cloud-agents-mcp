import { describe, expect, it } from 'vitest';
import { RateLimitedError, ServerError } from '../../src/client/errors.js';
import { runWaitForRun } from '../../src/tools/waitForRun.js';
import { fakeClock, makeClient } from '../helpers/client.js';
import { errorBody, finishedRunFixture, runningRunFixture } from '../helpers/fixtures.js';
import { jsonResponse, recordingFetch } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('wait_for_run', () => {
  it('polls raw run status and preserves the final native record', async () => {
    const clock = fakeClock();
    const { fetch, calls } = recordingFetch([
      () => jsonResponse(runningRunFixture),
      () => jsonResponse({ ...finishedRunFixture, futureField: true }),
    ]);
    const result = await runWaitForRun({
      client: makeClient({ fetch, now: clock.now, sleep: clock.sleep }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 10_000 },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toMatchObject({ isTerminal: true, pollCount: 2, pollIntervalMs: 5000 });
    expect(result['run']).toMatchObject({ status: 'FINISHED', futureField: true });
    expect(calls).toHaveLength(2);
  });

  it('does not issue a final request after the deadline', async () => {
    const clock = fakeClock();
    const { fetch, calls } = recordingFetch([() => jsonResponse(runningRunFixture)]);
    const result = await runWaitForRun({
      client: makeClient({ fetch, now: clock.now, sleep: clock.sleep }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 1000 },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toMatchObject({ isTerminal: false, pollCount: 1, elapsedMs: 1000 });
    expect(calls).toHaveLength(1);
  });

  it('stops during a polling sleep when the caller cancels and sends no further request', async () => {
    const controller = new AbortController();
    const { fetch, calls } = recordingFetch([() => jsonResponse(runningRunFixture)]);
    const waiting = runWaitForRun({
      client: makeClient({ fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 60_000 },
      sleep: async () => new Promise<void>(() => undefined),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ isTerminal: false, pollCount: 1 });
    expect(calls).toHaveLength(1);
  });

  it('surfaces the original 429 immediately when Retry-After cannot fit the deadline', async () => {
    const { fetch, calls } = recordingFetch([
      () => jsonResponse(errorBody('rate_limit_exceeded', 'slow down'), 429, { 'Retry-After': '20' }),
    ]);
    const started = Date.now();
    await expect(
      runWaitForRun({
        client: makeClient({ fetch }),
        input: { agentId: AGENT, runId: RUN, maxWaitMs: 1000 },
      }),
    ).rejects.toMatchObject({ constructor: RateLimitedError, message: 'slow down', retryAfterMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(1);
  });

  it('does not suppress native API errors', async () => {
    const { fetch, calls } = recordingFetch([
      () => jsonResponse(errorBody('internal_error', 'native failure'), 500),
    ]);
    await expect(
      runWaitForRun({
        client: makeClient({ fetch, sleep: async () => undefined }),
        input: { agentId: AGENT, runId: RUN, maxWaitMs: 1000 },
      }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(3);
  });
});
