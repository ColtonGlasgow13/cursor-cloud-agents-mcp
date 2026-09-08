import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../src/client/errors.js';
import { deleteAgentInput } from '../../src/tools/deleteAgent.js';
import { buildLaunchAgentBody, runLaunchAgent } from '../../src/tools/launchAgent.js';
import { buildCreateRunBody } from '../../src/tools/sendFollowup.js';
import { makeClient } from '../helpers/client.js';
import { agentFixture, createAgentFixture, errorBody, listRunsFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';

describe('launch_agent request body', () => {
  it('omits repos and env entirely when they are not supplied', () => {
    const body = buildLaunchAgentBody({ prompt: 'Do the thing' });
    expect(body).toEqual({ prompt: { text: 'Do the thing' } });
    expect(Object.keys(body)).not.toContain('repos');
    expect(Object.keys(body)).not.toContain('env');
    expect(JSON.stringify(body)).not.toContain('null');
  });

  it('normalizes repo URL strings into RepoConfig objects', () => {
    const body = buildLaunchAgentBody({
      prompt: 'x',
      repos: ['https://github.com/your-org/your-repo', { url: 'https://github.com/a/b', startingRef: 'dev' }],
    });
    expect(body['repos']).toEqual([
      { url: 'https://github.com/your-org/your-repo' },
      { url: 'https://github.com/a/b', startingRef: 'dev' },
    ]);
  });

  it('wraps the model id and params into the API shape', () => {
    const body = buildLaunchAgentBody({
      prompt: 'x',
      model: 'composer-2',
      modelParams: [{ id: 'fast', value: 'true' }],
    });
    expect(body['model']).toEqual({ id: 'composer-2', params: [{ id: 'fast', value: 'true' }] });
  });

  it('rejects modelParams without a model, and agentId together with envVars', () => {
    expect(() => buildLaunchAgentBody({ prompt: 'x', modelParams: [{ id: 'fast', value: 'true' }] })).toThrow(
      BadRequestError,
    );
    expect(() =>
      buildLaunchAgentBody({ prompt: 'x', agentId: AGENT, envVars: { FOO: 'bar' } }),
    ).toThrow(BadRequestError);
  });

  it('builds a follow-up body with only the keys that were provided', () => {
    expect(buildCreateRunBody({ agentId: AGENT, prompt: 'more' })).toEqual({ prompt: { text: 'more' } });
    expect(buildCreateRunBody({ agentId: AGENT, prompt: 'more', mode: 'plan' })).toEqual({
      prompt: { text: 'more' },
      mode: 'plan',
    });
  });
});

describe('launch_agent behaviour', () => {
  useMswServer();

  it('returns ids and a polling next step', async () => {
    mswServer.use(http.post(`${BASE}/v1/agents`, () => HttpResponse.json(createAgentFixture, { status: 201 })));
    const result = await runLaunchAgent({ client: makeClient(), input: { prompt: 'Add a README' } });

    expect(result['agentId']).toBe(AGENT);
    expect(result['runId']).toBe('run-00000000-0000-0000-0000-000000000001');
    expect(result['runStatus']).toBe('CREATING');
    expect(result['alreadyExisted']).toBe(false);
    expect(String(result['nextSteps'])).toContain('get_run_events');
    expect(String(result['nextSteps'])).toContain('wait_for_run');
  });

  it('puts no undefined or null keys on the wire (raw body string)', async () => {
    let raw = '';
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async ({ request }) => {
        raw = await request.text();
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
    );

    await runLaunchAgent({ client: makeClient(), input: { prompt: 'Add a README' } });

    expect(raw).toBe('{"prompt":{"text":"Add a README"}}');
    for (const key of ['repos', 'env', 'model', 'envVars', 'mcpServers', 'mode', 'agentId', 'images']) {
      expect(raw, key).not.toContain(key);
    }
    expect(raw).not.toContain('null');
  });

  it('recovers when agent_id_conflict comes back as a 400 rather than a 409', async () => {
    // The OpenAPI spec says 409, but Cursor's prose docs have also called this
    // a 400. Either way the launch must resolve to the existing agent.
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () =>
        HttpResponse.json(errorBody('agent_id_conflict', 'already exists'), { status: 400 }),
      ),
      http.get(`${BASE}/v1/agents/${AGENT}`, () => HttpResponse.json(agentFixture)),
      http.get(`${BASE}/v1/agents/${AGENT}/runs`, () => HttpResponse.json(listRunsFixture)),
    );

    const result = await runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README', agentId: AGENT },
    });
    expect(result['alreadyExisted']).toBe(true);
    expect(result['agentId']).toBe(AGENT);
  });

  it('recovers from 409 agent_id_conflict by returning the existing agent', async () => {
    let creates = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () => {
        creates += 1;
        return HttpResponse.json(errorBody('agent_id_conflict', 'already exists'), { status: 409 });
      }),
      http.get(`${BASE}/v1/agents/${AGENT}`, () => HttpResponse.json(agentFixture)),
      http.get(`${BASE}/v1/agents/${AGENT}/runs`, () => HttpResponse.json(listRunsFixture)),
    );

    const result = await runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README', agentId: AGENT },
    });

    expect(creates).toBe(1);
    expect(result['alreadyExisted']).toBe(true);
    expect(result['agentId']).toBe(AGENT);
    expect(result['runId']).toBe('run-00000000-0000-0000-0000-000000000002');
    expect(String(result['nextSteps'])).toContain('nothing new was launched');
  });

  it('still fails on agent_id_conflict when the caller did not supply an agentId', async () => {
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () =>
        HttpResponse.json(errorBody('agent_id_conflict', 'already exists'), { status: 409 }),
      ),
    );
    await expect(runLaunchAgent({ client: makeClient(), input: { prompt: 'x' } })).rejects.toThrow(
      /already exists/,
    );
  });
});

describe('delete_agent input validation', () => {
  it('refuses to run without confirm: true', () => {
    const schema = z.object(deleteAgentInput);
    expect(schema.safeParse({ agentId: AGENT }).success).toBe(false);
    expect(schema.safeParse({ agentId: AGENT, confirm: false }).success).toBe(false);
    expect(schema.safeParse({ agentId: AGENT, confirm: true }).success).toBe(true);
  });
});
