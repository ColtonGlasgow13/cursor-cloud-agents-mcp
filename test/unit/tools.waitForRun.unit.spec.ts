import { describe, expect, it } from 'vitest';
import { runWaitForRun } from '../../src/tools/waitForRun.js';
import { fakeClock, makeClient } from '../helpers/client.js';
import { SSE_TRANSCRIPT, finishedRunFixture, runningRunFixture } from '../helpers/fixtures.js';
import { jsonResponse, routerFetch, sseResponse } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';
const isStream = (url: string): boolean => url.includes('/stream');
const isRunGet = (url: string): boolean => url.includes(`/runs/${RUN}`) && !url.includes('/stream');

describe('wait_for_run', () => {
  it('returns the terminal run with result text and PR URLs', async () => {
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: SSE_TRANSCRIPT })] },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 5000 },
    });

    expect(result['isTerminal']).toBe(true);
    expect(result['runStatus']).toBe('FINISHED');
    expect(result['result']).toBe(
      'Added README.md with installation instructions and usage examples.',
    );
    expect(result['prUrls']).toEqual(['https://github.com/your-org/your-repo/pull/123']);
    expect(result['eventCount']).toBe(4);
    expect(router.countFor(isStream)).toBe(1);
  });

  it('hitting the deadline is not an error: isTerminal false plus a resume cursor', async () => {
    const text = ['id: e1', 'event: assistant', 'data: {"text":"still going"}', '', ''].join('\n');
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text, stall: true })] },
      { match: isRunGet, responses: [() => jsonResponse(runningRunFixture)] },
    ]);

    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 1000 },
    });

    expect(result['isTerminal']).toBe(false);
    expect(result['runStatus']).toBe('RUNNING');
    expect(result['lastEventId']).toBe('e1');
    expect(String(result['hint'])).toContain('call wait_for_run again with afterEventId="e1"');
    expect(String(result['hint'])).toContain('not an error');
  });

  it('re-opens the stream in windows until the run finishes', async () => {
    const idle = ['id: k1', 'event: heartbeat', 'data: {}', '', ''].join('\n');
    const router = routerFetch([
      {
        match: isStream,
        responses: [() => sseResponse({ text: idle }), () => sseResponse({ text: SSE_TRANSCRIPT })],
      },
      { match: isRunGet, responses: [() => jsonResponse(runningRunFixture), () => jsonResponse(finishedRunFixture)] },
    ]);

    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 5000 },
      // The pause between windows is exercised in its own test below.
      sleep: async () => undefined,
    });

    expect(router.countFor(isStream)).toBe(2);
    expect(result['isTerminal']).toBe(true);
    expect(result['runStatus']).toBe('FINISHED');
  });

  it('falls back to the snapshot when the stream retention window has passed', async () => {
    const router = routerFetch([
      {
        match: isStream,
        responses: [() => jsonResponse({ error: { code: 'stream_expired', message: 'gone' } }, 410)],
      },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 5000 },
    });
    expect(result['streamExpired']).toBe(true);
    expect(result['isTerminal']).toBe(true);
  });
});

describe('wait_for_run pacing and budget', () => {
  it('paces windows when the server closes the stream immediately', async () => {
    // A stream that closes the instant it opens used to spin: stream + probe,
    // stream + probe, ... burning the whole ~20/min budget in milliseconds.
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: '' })] },
      { match: isRunGet, responses: [() => jsonResponse(runningRunFixture)] },
    ]);
    const clock = fakeClock(0);
    const slept: number[] = [];

    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch, now: clock.now, sleep: clock.sleep }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 30_000 },
      now: clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        clock.advance(ms);
      },
    });

    expect(result['isTerminal']).toBe(false);
    expect(slept.every((ms) => ms === 5000)).toBe(true);
    // 30s of budget at >=5s per window: a handful of opens, not hundreds.
    expect(router.countFor(isStream)).toBeLessThanOrEqual(6);
    expect(router.countFor(isStream)).toBeGreaterThan(1);
    expect(String(result['hint'])).toContain('not an error');
  });

  it('stops as soon as a framing event reports a terminal status', async () => {
    const text = ['event: status', `data: {"runId":"${RUN}","status":"CANCELLED"}`, '', ''].join('\n');
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text, stall: true })] },
      { match: isRunGet, responses: [() => jsonResponse({ ...finishedRunFixture, status: 'CANCELLED' })] },
    ]);
    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 10_000 },
      sleep: async () => undefined,
    });
    expect(result['isTerminal']).toBe(true);
    expect(result['runStatus']).toBe('CANCELLED');
    expect(router.countFor(isStream)).toBe(1);
  });

  it('falls back to the stream result text when the run record has no result yet', async () => {
    const withoutResult = { ...finishedRunFixture } as Record<string, unknown>;
    delete withoutResult['result'];
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: SSE_TRANSCRIPT })] },
      { match: isRunGet, responses: [() => jsonResponse(withoutResult)] },
    ]);
    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 5000 },
      sleep: async () => undefined,
    });
    expect(result['result']).toBe('Added README.md with installation instructions.');
  });

  it('drops an invalid cursor once instead of looping on the same 400', async () => {
    const router = routerFetch([
      {
        match: isStream,
        responses: [
          () => jsonResponse({ error: { code: 'invalid_last_event_id', message: 'bad' } }, 400),
          () => sseResponse({ text: SSE_TRANSCRIPT }),
        ],
      },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 5000, afterEventId: 'not-mine' },
      sleep: async () => undefined,
    });
    expect(result['cursorInvalid']).toBe(true);
    expect(result['isTerminal']).toBe(true);
    expect(router.countFor(isStream)).toBe(2);
    expect(router.calls[1]?.headers['last-event-id']).toBeUndefined();
  });

  it('reports an exhausted local budget as "call again", not as a failure', async () => {
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: '' })] },
      { match: isRunGet, responses: [() => jsonResponse(runningRunFixture)] },
    ]);
    // A budget of 2 requests: the first window spends both, everything after
    // it (including the final snapshot) is refused locally.
    const result = await runWaitForRun({
      client: makeClient({ fetch: router.fetch, rateLimitPerMin: 2 }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 4000 },
      sleep: async () => undefined,
    });
    expect(result['budgetExhausted']).toBe(true);
    expect(result['isTerminal']).toBe(false);
    expect(String(result['hint'])).toContain('wait_for_run again');
  });
});
