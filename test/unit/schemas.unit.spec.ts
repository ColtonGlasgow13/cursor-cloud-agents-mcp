import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  MAX_RAW_BODY_CHARS,
  MAX_REPORTED_ISSUES,
  ResponseValidationError,
  formatErrorForTool,
} from '../../src/client/errors.js';
import { agentSchema, runSchema, usageResponseSchema } from '../../src/client/schemas.js';
import { makeClient } from '../helpers/client.js';
import { agentFixture, finishedRunFixture, meServiceAccountFixture, usageFixture } from '../helpers/fixtures.js';
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

  it('types the undocumented fields the live API actually returns', () => {
    const agent = agentSchema.parse({ ...agentFixture, openAsCursorGithubApp: false });
    expect(agent.openAsCursorGithubApp).toBe(false);

    const usage = usageResponseSchema.parse({
      ...usageFixture,
      cost: { rawCostCents: 41, chargedCents: 0 },
      runs: [{ ...usageFixture.runs[0], cost: { rawCostCents: 41, chargedCents: 0 } }],
    });
    expect(usage.cost?.rawCostCents).toBe(41);
    expect(usage.runs?.[0]?.cost?.chargedCents).toBe(0);
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
    // The zod issues have to reach the model, not just the error object.
    const text = formatErrorForTool(validation);
    expect(text).toContain('ResponseValidationError');
    expect(text).toContain('Schema issues');
    expect(text).toContain('agentId');
  });

  it('puts the raw body in the tool error text, not just a promise of one', async () => {
    // The guidance says "the raw body is included above"; before this it never was.
    const broken = { ...finishedRunFixture, agentId: 42 };
    mswServer.use(http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}`, () => HttpResponse.json(broken)));

    const error = await makeClient()
      .getRun({ agentId: AGENT, runId: RUN })
      .catch((e: unknown) => e);
    const text = formatErrorForTool(error);

    expect(text).toContain('Schema issues');
    expect(text).toContain('agentId');
    expect(text).toContain('Raw body:');
    expect(text).toContain('"agentId":42');
    expect(text).toContain('The raw body is included above');
    expect(text.indexOf('Raw body:')).toBeLessThan(text.indexOf('The raw body is included above'));
  });

  it('truncates a huge raw body and says how much was cut', async () => {
    const broken = { ...finishedRunFixture, agentId: 42, padding: 'x'.repeat(6000) };
    mswServer.use(http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}`, () => HttpResponse.json(broken)));

    const error = await makeClient()
      .getRun({ agentId: AGENT, runId: RUN })
      .catch((e: unknown) => e);
    const text = formatErrorForTool(error);

    expect(text).toMatch(/\.\.\.\[truncated \d+ chars\]/);
    const rawSection = text.slice(text.indexOf('Raw body:'));
    expect(rawSection.length).toBeLessThan(MAX_RAW_BODY_CHARS + 200);
  });

  it('caps how many zod issues reach the model', async () => {
    // 25 list items each missing `agentId` -> 25 issues from one response.
    const items = Array.from({ length: 25 }, (_unused, index) => ({
      id: `run-${index}`,
      status: 'FINISHED',
      createdAt: '2026-04-13T18:30:00.000Z',
      updatedAt: '2026-04-13T18:30:00.000Z',
    }));
    mswServer.use(http.get(`${BASE}/v1/agents/${AGENT}/runs`, () => HttpResponse.json({ items })));

    const error = await makeClient()
      .listRuns({ agentId: AGENT })
      .catch((e: unknown) => e);
    const text = formatErrorForTool(error);

    expect((error as ResponseValidationError).issues).toHaveLength(25);
    // 20 listed issues plus the trailing "...and N more" line.
    expect(text.split('\n- ')).toHaveLength(MAX_REPORTED_ISSUES + 2);
    expect(text).toContain(`...and ${25 - MAX_REPORTED_ISSUES} more issue(s)`);
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
