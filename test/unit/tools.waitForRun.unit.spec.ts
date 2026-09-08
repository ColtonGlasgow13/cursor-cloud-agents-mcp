import { describe, expect, it } from 'vitest';
import { runWaitForRun } from '../../src/tools/waitForRun.js';
import { makeClient } from '../helpers/client.js';
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
