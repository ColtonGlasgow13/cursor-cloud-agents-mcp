import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ResponseValidationError } from '../../src/client/errors.js';
import { agentSchema, runSchema, usageResponseSchema } from '../../src/client/schemas.js';
import { createLogger } from '../../src/log.js';
import { makeClient } from '../helpers/client.js';
import { agentFixture, finishedRunFixture, usageFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('response schema tolerance', () => {
  it('keeps unknown fields and enum values', () => {
    expect(agentSchema.parse({ ...agentFixture, somethingNew: { nested: true } })['somethingNew']).toEqual({
      nested: true,
    });
    expect(runSchema.parse({ ...finishedRunFixture, status: 'PAUSED' }).status).toBe('PAUSED');
  });

  it('types known undocumented fields without rejecting other additions', () => {
    expect(agentSchema.parse({ ...agentFixture, openAsCursorGithubApp: false }).openAsCursorGithubApp).toBe(false);
    const usage = usageResponseSchema.parse({
      ...usageFixture,
      cost: { rawCostCents: 41, chargedCents: 0 },
      futureField: true,
    });
    expect(usage.cost?.rawCostCents).toBe(41);
    expect(usage['futureField']).toBe(true);
  });
});

describe('runtime response drift', () => {
  useMswServer();

  it('returns a valid JSON object even when known fields drift, with diagnostics on stderr', async () => {
    const drifted = { ...finishedRunFixture, agentId: 42, futureField: { kept: true } };
    const lines: string[] = [];
    mswServer.use(http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}`, () => HttpResponse.json(drifted)));
    const result = await makeClient({
      logger: createLogger({ level: 'warn', write: (line) => void lines.push(line) }),
    }).getRun({ agentId: AGENT, runId: RUN });
    expect(result).toEqual(drifted);
    expect(lines.join('\n')).toContain('response schema changed');
    expect(lines.join('\n')).toContain('agentId');
  });

  it('still rejects a non-JSON successful response', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}`, () => new HttpResponse('not json', { status: 200 })),
    );
    await expect(makeClient().getRun({ agentId: AGENT, runId: RUN })).rejects.toBeInstanceOf(
      ResponseValidationError,
    );
  });
});
