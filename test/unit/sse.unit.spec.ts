import { describe, expect, it } from 'vitest';
import { StreamExpiredError } from '../../src/client/errors.js';
import { makeClient } from '../helpers/client.js';
import { SSE_TRANSCRIPT, errorBody } from '../helpers/fixtures.js';
import { recordingFetch, sseResponse } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('streamRunEvents', () => {
  it('parses the documented transcript, drops framing events and advances the cursor', async () => {
    const { fetch, calls } = recordingFetch([() => sseResponse({ text: SSE_TRANSCRIPT, retentionSeconds: 900 })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 2000,
    });

    expect(result.events.map((event) => event.type)).toEqual(['assistant', 'tool_call', 'result', 'done']);
    expect(result.events[0]?.data).toEqual({ text: "I'll update the README now." });
    // The heartbeat is not returned, but its id still moved the cursor forward.
    expect(result.events.some((event) => event.type === 'heartbeat')).toBe(false);
    expect(result.lastEventId).toBe('1713033010000-0');
    expect(result.sawTerminal).toBe(true);
    expect(result.statusFromStream).toBe('FINISHED');
    expect(result.retentionSeconds).toBe(900);
    expect(calls[0]?.url).toContain(`/v1/agents/${AGENT}/runs/${RUN}/stream`);
    expect(calls[0]?.headers['accept']).toBe('text/event-stream');
  });

  it('advances lastEventId past a heartbeat when nothing else arrives', async () => {
    const text = ['id: hb-1', 'event: heartbeat', 'data: {}', '', ''].join('\n');
    const { fetch } = recordingFetch([() => sseResponse({ text })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 2000,
    });
    expect(result.events).toEqual([]);
    expect(result.lastEventId).toBe('hb-1');
    expect(result.sawTerminal).toBe(false);
    expect(result.closedByServer).toBe(true);
  });

  it('sends Last-Event-ID only when a cursor is supplied', async () => {
    const { fetch, calls } = recordingFetch([() => sseResponse({ text: SSE_TRANSCRIPT })]);
    const client = makeClient({ fetch });
    await client.streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500 });
    await client.streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 500,
      lastEventId: '1713033000000-0',
    });
    expect(calls[0]?.headers['last-event-id']).toBeUndefined();
    expect(calls[1]?.headers['last-event-id']).toBe('1713033000000-0');
  });

  it('returns partial events when maxWaitMs elapses on a stalled stream', async () => {
    const text = ['id: 1', 'event: assistant', 'data: {"text":"working"}', '', ''].join('\n');
    const { fetch } = recordingFetch([() => sseResponse({ text, stall: true })]);
    const started = Date.now();
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 400,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(result.events).toHaveLength(1);
    expect(result.sawTerminal).toBe(false);
    expect(result.closedByServer).toBe(false);
    expect(result.lastEventId).toBe('1');
  });

  it('stops at maxEvents', async () => {
    const text = [1, 2, 3, 4, 5]
      .map((n) => `id: e${n}\nevent: assistant\ndata: {"text":"${n}"}\n\n`)
      .join('');
    const { fetch } = recordingFetch([() => sseResponse({ text, stall: true })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 5000,
      maxEvents: 2,
    });
    expect(result.events).toHaveLength(2);
    expect(result.lastEventId).toBe('e2');
  });

  it('honours an explicit eventTypes filter while still detecting terminality', async () => {
    const { fetch } = recordingFetch([() => sseResponse({ text: SSE_TRANSCRIPT })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 2000,
      eventTypes: ['result'],
    });
    expect(result.events.map((event) => event.type)).toEqual(['result']);
    expect(result.sawTerminal).toBe(true);
  });

  it('drops interaction_update by default but returns it when asked for', async () => {
    const text = [
      'id: i1',
      'event: interaction_update',
      'data: {"type":"text-delta","text":"rich duplicate"}',
      '',
      'id: a1',
      'event: assistant',
      'data: {"text":"simple"}',
      '',
      '',
    ].join('\n');
    const client = makeClient({ fetch: recordingFetch([() => sseResponse({ text })]).fetch });
    const byDefault = await client.streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500 });
    expect(byDefault.events.map((event) => event.type)).toEqual(['assistant']);
    // ...but the cursor still moved past the event we dropped.
    expect(byDefault.lastEventId).toBe('a1');

    const optedIn = await makeClient({
      fetch: recordingFetch([() => sseResponse({ text })]).fetch,
    }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 500,
      eventTypes: ['interaction_update'],
    });
    expect(optedIn.events.map((event) => event.type)).toEqual(['interaction_update']);
  });

  it('parses non-JSON event data as a raw string', async () => {
    const text = ['id: 1', 'event: assistant', 'data: plain text', '', ''].join('\n');
    const { fetch } = recordingFetch([() => sseResponse({ text })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 500,
    });
    expect(result.events[0]?.data).toBe('plain text');
  });

  it('maps 410 to StreamExpiredError', async () => {
    const { fetch } = recordingFetch([
      () =>
        sseResponse({
          status: 410,
          body: JSON.stringify(errorBody('stream_expired', 'gone')),
        }),
    ]);
    await expect(
      makeClient({ fetch }).streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500 }),
    ).rejects.toBeInstanceOf(StreamExpiredError);
  });
});

describe('streamRunEvents transport hygiene', () => {
  it('parses events whose SSE lines are split across chunks', async () => {
    // Cut the transcript into 7-byte pieces: every field line, and several
    // multi-byte JSON payloads, straddle a chunk boundary.
    const chunks: string[] = [];
    for (let index = 0; index < SSE_TRANSCRIPT.length; index += 7) {
      chunks.push(SSE_TRANSCRIPT.slice(index, index + 7));
    }
    const { fetch } = recordingFetch([() => sseResponse({ chunks })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 2000,
    });

    expect(chunks.length).toBeGreaterThan(50);
    expect(result.events.map((event) => event.type)).toEqual(['assistant', 'tool_call', 'result', 'done']);
    expect(result.events[0]?.data).toEqual({ text: "I'll update the README now." });
    expect(result.lastEventId).toBe('1713033010000-0');
    expect(result.sawTerminal).toBe(true);
  });

  it('cancels the body and aborts the request when maxWaitMs expires', async () => {
    let cancelled = false;
    const text = ['id: 1', 'event: assistant', 'data: {"text":"working"}', '', ''].join('\n');
    const { fetch, calls } = recordingFetch([
      () => sseResponse({ text, stall: true, onCancel: () => void (cancelled = true) }),
    ]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 300,
    });

    expect(result.events).toHaveLength(1);
    // No leaked reader and no in-flight request once we return.
    expect(cancelled).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('aborts the request even when the response has no body', async () => {
    const { fetch, calls } = recordingFetch([
      () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    ]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 300,
    });
    expect(result.closedByServer).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('treats an `error` event as terminal', async () => {
    const text = [
      'id: e1',
      'event: error',
      'data: {"code":"upstream_error","message":"model provider failed"}',
      '',
      '',
    ].join('\n');
    const { fetch } = recordingFetch([() => sseResponse({ text, stall: true })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 5000,
    });
    expect(result.sawTerminal).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual(['error']);
  });

  it('keeps the cursor and the filter independent: filtered-out events still advance it', async () => {
    const text = [
      'id: a1',
      'event: assistant',
      'data: {"text":"hidden"}',
      '',
      'id: t1',
      'event: tool_call',
      'data: {"callId":"c1","name":"read_file","status":"running"}',
      '',
      '',
    ].join('\n');
    const { fetch } = recordingFetch([() => sseResponse({ text })]);
    const result = await makeClient({ fetch }).streamRunEvents({
      agentId: AGENT,
      runId: RUN,
      maxWaitMs: 1000,
      eventTypes: ['tool_call'],
    });
    expect(result.events.map((event) => event.type)).toEqual(['tool_call']);
    // The assistant event was filtered out of the payload but must not be
    // replayed on the next poll, so the cursor has to have moved past it.
    expect(result.lastEventId).toBe('t1');
  });
});
