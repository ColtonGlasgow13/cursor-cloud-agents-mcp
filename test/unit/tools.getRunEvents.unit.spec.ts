import { describe, expect, it } from 'vitest';
import { runGetRunEvents } from '../../src/tools/getRunEvents.js';
import { makeClient } from '../helpers/client.js';
import { SSE_TRANSCRIPT, errorBody, finishedRunFixture, runningRunFixture } from '../helpers/fixtures.js';
import { jsonResponse, routerFetch, sseResponse } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

const isStream = (url: string): boolean => url.includes('/stream');
const isRunGet = (url: string): boolean => url.includes(`/runs/${RUN}`) && !url.includes('/stream');

describe('get_run_events', () => {
  it('returns events, a resume cursor and a poll hint without an extra GET while running', async () => {
    const text = [
      'event: status',
      'data: {"runId":"' + RUN + '","status":"RUNNING"}',
      '',
      'id: 1713033000000-0',
      'event: assistant',
      'data: {"text":"working"}',
      '',
      '',
    ].join('\n');
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text, stall: true })] },
      { match: isRunGet, responses: [() => jsonResponse(runningRunFixture)] },
    ]);

    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 500 },
    });

    expect(result['runStatus']).toBe('RUNNING');
    expect(result['isTerminal']).toBe(false);
    expect(result['nextEventId']).toBe('1713033000000-0');
    expect(result['suggestedPollDelayMs']).toBe(5000);
    expect(String(result['hint'])).toContain('afterEventId="1713033000000-0"');
    // The status framing event told us the status, so no snapshot GET was needed.
    expect(router.countFor(isRunGet)).toBe(0);
  });

  it('threads afterEventId through as the Last-Event-ID header', async () => {
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: SSE_TRANSCRIPT })] },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, afterEventId: 'cursor-9', maxWaitMs: 500 },
    });
    expect(router.calls[0]?.headers['last-event-id']).toBe('cursor-9');
  });

  it('marks the run terminal from the stream and points at get_run', async () => {
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: SSE_TRANSCRIPT })] },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 1000 },
    });
    expect(result['isTerminal']).toBe(true);
    expect(result['runStatus']).toBe('FINISHED');
    expect(result['suggestedPollDelayMs']).toBe(0);
    expect(String(result['hint'])).toContain('get_run');
  });

  it('falls back to a get_run snapshot when the server closes without saying anything', async () => {
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: '' })] },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 500 },
    });
    expect(router.countFor(isRunGet)).toBe(1);
    expect(result['isTerminal']).toBe(true);
    expect(result['runStatus']).toBe('FINISHED');
    expect(result['prUrls']).toEqual(['https://github.com/your-org/your-repo/pull/123']);
  });

  it('falls back to a snapshot on 410 stream_expired', async () => {
    const router = routerFetch([
      {
        match: isStream,
        responses: [() => jsonResponse(errorBody('stream_expired', 'gone'), 410)],
      },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 500 },
    });
    expect(result['streamExpired']).toBe(true);
    expect(result['events']).toEqual([]);
    expect(result['nextEventId']).toBeNull();
    expect(result['isTerminal']).toBe(true);
    expect(String(result['hint'])).toContain('get_run');
  });

  it('reports an invalid cursor instead of failing the call', async () => {
    const router = routerFetch([
      {
        match: isStream,
        responses: [() => jsonResponse(errorBody('invalid_last_event_id', 'bad cursor'), 400)],
      },
      { match: isRunGet, responses: [() => jsonResponse(runningRunFixture)] },
    ]);
    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, afterEventId: 'nope', maxWaitMs: 500 },
    });
    expect(result['cursorInvalid']).toBe(true);
    expect(result['streamExpired']).toBe(false);
    expect(result['runStatus']).toBe('RUNNING');
    expect(String(result['hint'])).toContain('without afterEventId');
  });

  it('flags an unrecognised run status instead of guessing', async () => {
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: '' })] },
      { match: isRunGet, responses: [() => jsonResponse({ ...runningRunFixture, status: 'HIBERNATED' })] },
    ]);
    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 500 },
    });
    expect(result['isTerminal']).toBe(false);
    expect(String(result['warning'])).toContain('HIBERNATED');
  });
});

describe('get_run_events terminal-status consistency', () => {
  it('reports a terminal status from a framing event even when no `done` arrives', async () => {
    // The run finished just before we connected: the sticky `status` event says
    // FINISHED and then the stream goes quiet until maxWaitMs.
    const text = [
      'event: status',
      `data: {"runId":"${RUN}","status":"FINISHED"}`,
      '',
      '',
    ].join('\n');
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text, stall: true })] },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);

    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 300 },
    });

    expect(result['runStatus']).toBe('FINISHED');
    // Previously this returned isTerminal:false with the hint "Not finished
    // (status FINISHED). Sleep ~5s..." — an endless poll.
    expect(result['isTerminal']).toBe(true);
    expect(result['suggestedPollDelayMs']).toBe(0);
    expect(String(result['hint'])).toContain('get_run');
    expect(String(result['hint'])).not.toContain('Not finished');
  });

  it('never claims "finished" with a non-terminal status, and asks for exactly one snapshot', async () => {
    // `done` arrives before the run record catches up: the snapshot still says
    // RUNNING, so the answer must stay non-terminal AND stay consistent.
    const text = ['id: d1', 'event: done', 'data: {}', '', ''].join('\n');
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text })] },
      { match: isRunGet, responses: [() => jsonResponse(runningRunFixture)] },
    ]);

    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 500 },
    });

    expect(router.countFor(isRunGet)).toBe(1);
    expect(result['isTerminal']).toBe(false);
    expect(result['runStatus']).toBe('RUNNING');
    expect(String(result['hint'])).toContain('Not finished (status RUNNING)');
    expect(String(result['hint'])).toContain('afterEventId="d1"');
  });

  it('spends no snapshot GET when the stream already reported a terminal result', async () => {
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text: SSE_TRANSCRIPT })] },
      { match: isRunGet, responses: [() => jsonResponse(finishedRunFixture)] },
    ]);
    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 1000 },
    });
    expect(result['isTerminal']).toBe(true);
    expect(router.countFor(isRunGet)).toBe(0);
  });
});
