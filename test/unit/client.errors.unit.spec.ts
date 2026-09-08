import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  AgentArchivedError,
  AgentBusyError,
  AgentIdConflictError,
  AuthError,
  BadRequestError,
  ConflictError,
  FeatureUnavailableError,
  ForbiddenError,
  InvalidEventCursorError,
  NotFoundError,
  RunNotCancellableError,
  StreamExpiredError,
  RateLimitedError,
  formatErrorForTool,
} from '../../src/client/errors.js';
import { toolFailure } from '../../src/tools/shared.js';
import { makeClient } from '../helpers/client.js';
import { errorBody } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('HTTP error mapping', () => {
  useMswServer();

  it('maps 401 to AuthError without echoing the key', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/me`, () =>
        HttpResponse.json(errorBody('unauthorized', 'Invalid API key'), { status: 401 }),
      ),
    );
    const error = await makeClient().me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    const text = formatErrorForTool(error);
    expect(text).toContain('CURSOR_API_KEY');
    expect(text).not.toContain('crsr_test_key');
  });

  it('maps 403 plan_required to ForbiddenError and feature_unavailable to FeatureUnavailableError', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/agents/${AGENT}`, () =>
        HttpResponse.json(errorBody('plan_required', 'Upgrade required'), { status: 403 }),
      ),
      http.get(`${BASE}/v1/agents/${AGENT}/usage`, () =>
        HttpResponse.json(errorBody('feature_unavailable', 'Usage is early access'), { status: 403 }),
      ),
    );
    const client = makeClient();
    await expect(client.getAgent({ agentId: AGENT })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(client.getUsage({ agentId: AGENT })).rejects.toBeInstanceOf(FeatureUnavailableError);
  });

  it('maps 404 to NotFoundError naming what was looked up', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}`, () =>
        HttpResponse.json(errorBody('run_not_found', 'Run not found'), { status: 404 }),
      ),
    );
    const error = await makeClient()
      .getRun({ agentId: AGENT, runId: RUN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe('Run not found');
    expect(formatErrorForTool(error)).toContain(RUN);
    expect(formatErrorForTool(error)).toContain(AGENT);
  });

  it('splits 409 by error code', async () => {
    const cases = [
      ['agent_busy', AgentBusyError],
      ['agent_archived', AgentArchivedError],
      ['agent_id_conflict', AgentIdConflictError],
      ['run_not_cancellable', RunNotCancellableError],
      ['something_new', ConflictError],
    ] as const;

    for (const [code, ctor] of cases) {
      mswServer.use(
        http.post(`${BASE}/v1/agents/${AGENT}/runs`, () =>
          HttpResponse.json(errorBody(code, `conflict: ${code}`), { status: 409 }),
        ),
      );
      const error = await makeClient()
        .createRun({ agentId: AGENT, body: { prompt: { text: 'x' } } })
        .catch((e: unknown) => e);
      expect(error, code).toBeInstanceOf(ctor);
    }
  });

  it('gives AgentBusyError actionable guidance naming the agent', async () => {
    mswServer.use(
      http.post(`${BASE}/v1/agents/${AGENT}/runs`, () =>
        HttpResponse.json(errorBody('agent_busy', 'Agent is busy', { runId: RUN }), { status: 409 }),
      ),
    );
    const error = await makeClient()
      .createRun({ agentId: AGENT, body: { prompt: { text: 'x' } } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentBusyError);
    const text = formatErrorForTool(error);
    expect(text).toContain(AGENT);
    expect(text).toContain('cancel_run');
    expect(text).toContain('wait_for_run');
  });

  it('maps 410 to StreamExpiredError', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}/stream`, () =>
        HttpResponse.json(errorBody('stream_expired', 'Retention window elapsed'), { status: 410 }),
      ),
    );
    await expect(
      makeClient().streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500 }),
    ).rejects.toBeInstanceOf(StreamExpiredError);
  });

  it('maps 400 invalid_last_event_id to InvalidEventCursorError and other 400s to BadRequestError', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/agents/${AGENT}/runs/${RUN}/stream`, () =>
        HttpResponse.json(errorBody('invalid_last_event_id', 'Bad cursor'), { status: 400 }),
      ),
      http.post(`${BASE}/v1/agents`, () =>
        HttpResponse.json(errorBody('invalid_model', 'Unknown model "nope"'), { status: 400 }),
      ),
    );
    const client = makeClient();
    await expect(
      client.streamRunEvents({ agentId: AGENT, runId: RUN, maxWaitMs: 500, lastEventId: 'x' }),
    ).rejects.toBeInstanceOf(InvalidEventCursorError);

    const error = await client.launchAgent({ prompt: { text: 'x' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).message).toBe('Unknown model "nope"');
  });

  it('tolerates a non-JSON error body', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/me`, () => new HttpResponse('<html>gateway</html>', { status: 403 })),
    );
    const error = await makeClient().me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).message).toContain('HTTP 403');
  });

  it('includes helpUrl in the tool-facing text when the API supplies one', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/me`, () =>
        HttpResponse.json(
          errorBody('integration_not_connected', 'GitHub is not connected', {
            helpUrl: 'https://cursor.com/docs/integrations',
          }),
          { status: 403 },
        ),
      ),
    );
    const error = await makeClient().me().catch((e: unknown) => e);
    expect(formatErrorForTool(error)).toContain('https://cursor.com/docs/integrations');
  });
});

describe('MCP error structure', () => {
  it('preserves native error metadata alongside isError text', () => {
    const result = toolFailure(
      new RateLimitedError({
        message: 'slow down',
        status: 429,
        code: 'rate_limit_exceeded',
        requestId: 'req-123',
        retryAfterMs: 7000,
        details: { remaining: '0' },
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        name: 'RateLimitedError',
        message: 'slow down',
        status: 429,
        code: 'rate_limit_exceeded',
        requestId: 'req-123',
        retryAfterMs: 7000,
        details: { remaining: '0' },
      },
    });
  });
});
