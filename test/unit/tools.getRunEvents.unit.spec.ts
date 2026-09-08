import { describe, expect, it } from 'vitest';
import { InvalidEventCursorError, StreamExpiredError } from '../../src/client/errors.js';
import { runGetRunEvents } from '../../src/tools/getRunEvents.js';
import { makeClient } from '../helpers/client.js';
import { errorBody } from '../helpers/fixtures.js';
import { jsonResponse, routerFetch, sseResponse } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';
const isStream = (url: string): boolean => url.includes('/stream');
const isSnapshot = (url: string): boolean => url.includes(`/runs/${RUN}`) && !url.includes('/stream');

describe('get_run_events', () => {
  it('returns native event payloads, status and interaction updates without a snapshot request', async () => {
    const text = [
      'event: status',
      `data: {"runId":"${RUN}","status":"RUNNING","newField":1}`,
      '',
      'id: i1',
      'event: interaction_update',
      'data: {"type":"text-delta","text":"hello"}',
      '',
      '',
    ].join('\n');
    const router = routerFetch([
      { match: isStream, responses: [() => sseResponse({ text })] },
      { match: isSnapshot, responses: [() => jsonResponse({})] },
    ]);
    const result = await runGetRunEvents({
      client: makeClient({ fetch: router.fetch }),
      input: { agentId: AGENT, runId: RUN, maxWaitMs: 500 },
    });
    expect((result['events'] as { type: string; data: unknown }[]).map((event) => event.type)).toEqual([
      'status',
      'interaction_update',
    ]);
    expect(result['status']).toBe('RUNNING');
    expect(result['nextEventId']).toBe('i1');
    expect(result).not.toHaveProperty('isTerminal');
    expect(router.countFor(isSnapshot)).toBe(0);
  });

  it('preserves stream_expired and invalid cursor as errors without snapshots', async () => {
    for (const [status, code, ctor] of [
      [410, 'stream_expired', StreamExpiredError],
      [400, 'invalid_last_event_id', InvalidEventCursorError],
    ] as const) {
      const router = routerFetch([
        { match: isStream, responses: [() => jsonResponse(errorBody(code, code), status)] },
        { match: isSnapshot, responses: [() => jsonResponse({})] },
      ]);
      await expect(
        runGetRunEvents({
          client: makeClient({ fetch: router.fetch }),
          input: { agentId: AGENT, runId: RUN, maxWaitMs: 500 },
        }),
      ).rejects.toBeInstanceOf(ctor);
      expect(router.countFor(isSnapshot)).toBe(0);
    }
  });
});
