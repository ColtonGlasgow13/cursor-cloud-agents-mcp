import { describe, expect, it } from 'vitest';
import { NetworkError, RateLimitedError, StreamExpiredError } from '../../src/client/errors.js';
import { makeClient, type FetchLike } from '../helpers/client.js';
import { SSE_TRANSCRIPT, errorBody } from '../helpers/fixtures.js';
import { jsonResponse, recordingFetch, sseResponse } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('streamRunEvents', () => {
  it('returns status and interaction events by default, drops heartbeats, and advances the cursor', async () => {
    const text = [
      'event: status',
      `data: {"runId":"${RUN}","status":"RUNNING"}`,
      '',
      'id: i1',
      'event: interaction_update',
      'data: {"text":"delta"}',
      '',
      'id: hb1',
      'event: heartbeat',
      'data: {}',
      '',
      '',
    ].join('\n');
    const result = await makeClient({
      fetch: recordingFetch([() => sseResponse({ text, retentionSeconds: 900 })]).fetch,
    }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500 });

    expect(result.events.map((event) => event.type)).toEqual(['status', 'interaction_update']);
    expect(result.events[0]?.data).toEqual({ runId: RUN, status: 'RUNNING' });
    expect(result.lastEventId).toBe('hb1');
    expect(result.statusFromStream).toBe('RUNNING');
    expect(result.retentionSeconds).toBe(900);
  });

  it('supports explicit filters and parses non-JSON data as text', async () => {
    const text = ['id: 1', 'event: assistant', 'data: plain text', '', ''].join('\n');
    const result = await makeClient({
      fetch: recordingFetch([() => sseResponse({ text })]).fetch,
    }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500, eventTypes: ['assistant'] });
    expect(result.events).toEqual([{ id: '1', type: 'assistant', data: 'plain text' }]);
  });

  it('parses lines split across chunks and stops at maxEvents', async () => {
    const chunks: string[] = [];
    for (let index = 0; index < SSE_TRANSCRIPT.length; index += 7) chunks.push(SSE_TRANSCRIPT.slice(index, index + 7));
    const result = await makeClient({
      fetch: recordingFetch([() => sseResponse({ chunks })]).fetch,
    }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 1000, maxEvents: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.data).toEqual({ runId: RUN, status: 'RUNNING' });
    expect(result.events[1]?.data).toEqual({ text: "I'll update the README now." });
  });

  it('bounds header connection time and aborts the request', async () => {
    let calls = 0;
    let seenSignal: AbortSignal | undefined;
    const fetch: FetchLike = async (_input, init) => {
      calls += 1;
      seenSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    const started = Date.now();
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.events).toEqual([]);
    expect(calls).toBe(1);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('returns partial events, cancels the body, and aborts on the drain deadline', async () => {
    let cancelled = false;
    const { fetch, calls } = recordingFetch([
      () =>
        sseResponse({
          text: ['id: 1', 'event: assistant', 'data: {"text":"working"}', '', ''].join('\n'),
          stall: true,
          onCancel: () => void (cancelled = true),
        }),
    ]);
    const result = await makeClient({ fetch }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 100 });
    expect(result.events).toHaveLength(1);
    expect(cancelled).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('does not call fetch when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = recordingFetch([() => sseResponse()]);
    await expect(
      makeClient({ fetch }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500, signal: controller.signal }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(0);
  });

  it('cancels a retry sleep and sends no further request', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      throw new Error('network down');
    };
    const waiting = makeClient({
      fetch,
      sleep: async () => new Promise<void>(() => undefined),
      random: () => 0.5,
    }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 5000, signal: controller.signal });
    const outcome = waiting.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(outcome).resolves.toBeInstanceOf(NetworkError);
    expect(calls).toBe(1);
  });

  it('does not shorten a long Retry-After or issue another stream request', async () => {
    const { fetch, calls } = recordingFetch([
      () => jsonResponse(errorBody('rate_limit_exceeded', 'slow down'), 429, { 'Retry-After': '60' }),
    ]);
    const error = await makeClient({ fetch })
      .streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500 })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterMs).toBe(60_000);
    expect(calls).toHaveLength(1);
  });

  it('preserves stream_expired', async () => {
    const { fetch } = recordingFetch([
      () => jsonResponse(errorBody('stream_expired', 'gone'), 410),
    ]);
    await expect(
      makeClient({ fetch }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500 }),
    ).rejects.toBeInstanceOf(StreamExpiredError);
  });
});
