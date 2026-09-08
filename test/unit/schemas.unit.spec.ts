import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ResponseValidationError } from '../../src/client/errors.js';
import { agentSchema, runSchema } from '../../src/client/schemas.js';
import { makeClient } from '../helpers/client.js';
import { agentFixture, finishedRunFixture, meServiceAccountFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('response schema tolerance', () => {
  it('keeps unknown extra fields instead of stripping them', () => {
    const parsed = agentSchema.parse({ ...agentFixture, somethingNew: { nested: true } });
    expect(parsed['somethingNew']).toEqual({ nested: true });
  });

  it('accepts unknown enum values as plain strings', () => {
    expect(agentSchema.parse({ ...agentFixture, status: 'HIBERNATING' }).status).toBe('HIBERNATING');
    expect(runSchema.parse({ ...finishedRunFixture, status: 'PAUSED' }).status).toBe('PAUSED');
  });

  it('accepts a service-account /v1/me body with the user fields absent', () => {
    expect(() => runSchema.parse(finishedRunFixture)).not.toThrow();
    expect(meServiceAccountFixture).not.toHaveProperty('userId');
  });

  it('treats an omitted nextCursor as "no more pages"', () => {
    expect(runSchema.parse(finishedRunFixture).git?.branches?.[0]?.prUrl).toBe(
      'https://github.com/your-org/your-repo/pull/123',
    );
  });
});

describe('ResponseValidationError', () => {
  useMswServer();

  it('throws with zod issues and the raw body when a required field is missing', async () => {
    const broken = { ...finishedRunFixture } as Record<string, unknown>;
    delete broken['agentId'];
    mswServer.use(http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}`, () => HttpResponse.json(broken)));

    const error = await makeClient()
      .getRun({ agentId: AGENT, runId: RUN })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResponseValidationError);
    const validation = error as ResponseValidationError;
    expect(validation.issues.join(' ')).toContain('agentId');
    expect(validation.rawBody).toEqual(broken);
    expect(validation.message).toContain('/v1/agents');
  });

  it('throws when the body is not JSON at all', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}`, () => new HttpResponse('not json', { status: 200 })),
    );
    const error = await makeClient()
      .getRun({ agentId: AGENT, runId: RUN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseValidationError);
    expect((error as ResponseValidationError).rawBody).toBe('not json');
  });
});
