import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AgentIdConflictError, BadRequestError } from '../../src/client/errors.js';
import { deleteAgentInput } from '../../src/tools/deleteAgent.js';
import { buildLaunchAgentBody, launchAgentInput, runLaunchAgent } from '../../src/tools/launchAgent.js';
import { buildCreateRunBody } from '../../src/tools/sendFollowup.js';
import { makeClient } from '../helpers/client.js';
import { createAgentFixture, errorBody } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';

describe('launch_agent request body', () => {
  it('forwards supplied fields and does not generate identity fields', () => {
    expect(buildLaunchAgentBody({ prompt: 'Do it' })).toEqual({ prompt: { text: 'Do it' } });
    expect(
      buildLaunchAgentBody({ prompt: 'Do it', agentId: AGENT, name: 'Caller name', env: { type: 'cloud' } }),
    ).toMatchObject({ agentId: AGENT, name: 'Caller name', env: { type: 'cloud' } });
  });

  it('normalizes repository strings and model parameters for the API', () => {
    const body = buildLaunchAgentBody({
      prompt: 'x',
      repos: ['https://github.com/a/b'],
      model: 'composer-2',
      modelParams: [{ id: 'thinking', value: 'high' }],
    });
    expect(body).toMatchObject({
      repos: [{ url: 'https://github.com/a/b' }],
      model: { id: 'composer-2', params: [{ id: 'thinking', value: 'high' }] },
    });
  });

  it('enforces known request constraints', () => {
    expect(() => buildLaunchAgentBody({ prompt: 'x', modelParams: [{ id: 'x', value: 'y' }] })).toThrow(
      BadRequestError,
    );
    expect(() => buildLaunchAgentBody({ prompt: 'x', agentId: AGENT, envVars: { FOO: 'bar' } })).toThrow(
      BadRequestError,
    );
  });

  it('keeps follow-up request shaping convenience', () => {
    expect(buildCreateRunBody({ agentId: AGENT, prompt: 'more', mode: 'plan' })).toEqual({
      prompt: { text: 'more' },
      mode: 'plan',
    });
  });

  it('does not expose launchTimeoutMs and delete requires only agentId', () => {
    expect(z.object(launchAgentInput).safeParse({ prompt: 'x', launchTimeoutMs: 1000 }).success).toBe(true);
    expect(Object.keys(launchAgentInput)).not.toContain('launchTimeoutMs');
    expect(z.object(deleteAgentInput).safeParse({ agentId: AGENT }).success).toBe(true);
    expect(Object.keys(deleteAgentInput)).toEqual(['agentId']);
  });
});

describe('launch_agent behavior', () => {
  useMswServer();

  it('awaits one POST and returns the complete native response', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => void (release = resolve));
    let posts = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async () => {
        posts += 1;
        await held;
        return HttpResponse.json({ ...createAgentFixture, upstreamField: { kept: true } }, { status: 201 });
      }),
    );

    let settled = false;
    const pending = runLaunchAgent({ client: makeClient(), input: { prompt: 'Add a README' } }).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();

    await expect(pending).resolves.toMatchObject({
      agent: createAgentFixture.agent,
      run: createAgentFixture.run,
      upstreamField: { kept: true },
    });
    expect(posts).toBe(1);
  });

  it('surfaces agent_id_conflict and performs no recovery GETs', async () => {
    let posts = 0;
    let gets = 0;
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () => {
        posts += 1;
        return HttpResponse.json(errorBody('agent_id_conflict', 'already exists'), { status: 409 });
      }),
      http.get(`${BASE}/v1/agents/${AGENT}`, () => {
        gets += 1;
        return HttpResponse.json({});
      }),
    );
    await expect(
      runLaunchAgent({ client: makeClient(), input: { prompt: 'x', agentId: AGENT } }),
    ).rejects.toBeInstanceOf(AgentIdConflictError);
    expect({ posts, gets }).toEqual({ posts: 1, gets: 0 });
  });
});
