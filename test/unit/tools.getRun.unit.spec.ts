import { describe, expect, it } from 'vitest';
import { runGetRun } from '../../src/tools/getRun.js';
import { makeClient } from '../helpers/client.js';
import { finishedRunFixture } from '../helpers/fixtures.js';
import { jsonResponse, recordingFetch } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('get_run', () => {
  it('returns the native run record, including unknown fields, without derived fields', async () => {
    const native = { ...finishedRunFixture, futureField: { nested: true } };
    const result = await runGetRun({
      client: makeClient({ fetch: recordingFetch([() => jsonResponse(native)]).fetch }),
      input: { agentId: AGENT, runId: RUN },
    });
    expect(result).toEqual(native);
    expect(result).not.toHaveProperty('isTerminal');
    expect(result).not.toHaveProperty('prUrls');
    expect(result).not.toHaveProperty('hint');
  });
});
