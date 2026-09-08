import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestError } from '../../src/client/errors.js';
import { AGENT_ID_PATTERN } from '../../src/client/schemas.js';
import { createLogger } from '../../src/log.js';
import { deleteAgentInput } from '../../src/tools/deleteAgent.js';
import {
  buildLaunchAgentBody,
  launchAgentInput,
  runLaunchAgent,
  type StartLaunchTimer,
} from '../../src/tools/launchAgent.js';
import { buildCreateRunBody } from '../../src/tools/sendFollowup.js';
import { makeClient } from '../helpers/client.js';
import { agentFixture, createAgentFixture, errorBody, listRunsFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';

/** A create the test holds open, so the launch timer can be made to win. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/** Captures the timer callback so a test can fire it deterministically. */
function manualTimer(): { start: StartLaunchTimer; fire: () => void; cancels: () => number } {
  let fire = (): void => {};
  let cancels = 0;
  return {
    start: (args) => {
      fire = args.fire;
      return {
        cancel: () => {
          cancels += 1;
        },
      };
    },
    fire: () => fire(),
    cancels: () => cancels,
  };
}

const neverFires: StartLaunchTimer = () => ({ cancel: () => undefined });

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
    expect(result['pending']).toBe(false);
    expect(String(result['nextSteps'])).toContain('get_run_events');
    expect(String(result['nextSteps'])).toContain('wait_for_run');
  });

  it('cancels the launch timer when the create wins the race', async () => {
    mswServer.use(http.post(`${BASE}/v1/agents`, () => HttpResponse.json(createAgentFixture, { status: 201 })));
    const timer = manualTimer();

    const result = await runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README' },
      startTimer: timer.start,
    });

    expect(result['pending']).toBe(false);
    expect(timer.cancels()).toBe(1);
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

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['agentId', 'prompt']);
    expect(parsed['prompt']).toEqual({ text: 'Add a README' });
    for (const key of ['repos', 'env', 'model', 'envVars', 'mcpServers', 'mode', 'images']) {
      expect(raw, key).not.toContain(key);
    }
    expect(raw).not.toContain('null');
  });

  it('pre-assigns a client-generated agentId matching the bc-<uuid> pattern', async () => {
    let raw = '';
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async ({ request }) => {
        raw = await request.text();
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
    );

    const result = await runLaunchAgent({ client: makeClient(), input: { prompt: 'Add a README' } });
    const sent = (JSON.parse(raw) as { agentId?: string }).agentId ?? '';

    expect(sent).toMatch(AGENT_ID_PATTERN);
    expect(result['agentIdSource']).toBe('client');
    expect(result['pending']).toBe(false);
  });

  it('pre-assigns no agentId when envVars is present, and names the agent so it can be found', async () => {
    let raw = '';
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async ({ request }) => {
        raw = await request.text();
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
    );

    const result = await runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README', envVars: { FOO: 'bar' } },
    });
    const sent = JSON.parse(raw) as { agentId?: string; name?: string };

    expect(sent.agentId).toBeUndefined();
    expect(sent.name).toMatch(/^mcp-launch-[0-9a-f]{8}$/);
    expect(result['agentIdSource']).toBe('server');
  });

  it('passes a caller-supplied agentId through untouched', async () => {
    let raw = '';
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async ({ request }) => {
        raw = await request.text();
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
      http.get(`${BASE}/v1/agents/${AGENT}`, () => HttpResponse.json(agentFixture)),
    );

    const result = await runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README', agentId: AGENT },
    });

    expect((JSON.parse(raw) as { agentId?: string }).agentId).toBe(AGENT);
    expect(result['agentIdSource']).toBe('caller');
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

describe('launch_agent create timeout (MCP client timeout safety)', () => {
  useMswServer();

  it('returns a pending success carrying the pre-assigned agentId when the timer wins', async () => {
    const held = gate();
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async () => {
        await held.wait;
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
    );
    const timer = manualTimer();

    const pending = runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README', launchTimeoutMs: 5000 },
      startTimer: timer.start,
    });
    timer.fire();
    const result = await pending;

    expect(result['pending']).toBe(true);
    expect(result['runId']).toBeNull();
    expect(result['agentStatus']).toBeNull();
    expect(result['runStatus']).toBeNull();
    expect(result['launchTimeoutMs']).toBe(5000);
    expect(result['agentIdSource']).toBe('client');
    expect(String(result['agentId'])).toMatch(AGENT_ID_PATTERN);
    const hint = String(result['hint']);
    expect(hint).toContain('still creating');
    expect(hint).toContain(`get_agent with agentId="${String(result['agentId'])}"`);
    expect(hint).toContain('list_runs');

    held.open();
  });

  it('tells the model to find the agent by name when envVars forced a server-minted id', async () => {
    const held = gate();
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async () => {
        await held.wait;
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
    );
    const timer = manualTimer();

    const pending = runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README', envVars: { FOO: 'bar' } },
      startTimer: timer.start,
    });
    timer.fire();
    const result = await pending;

    expect(result['pending']).toBe(true);
    expect(result['agentId']).toBeNull();
    const hint = String(result['hint']);
    expect(hint).toContain('list_agents');
    expect(hint).toContain(String(result['name']));
    expect(hint).toContain('Drop `envVars`');

    held.open();
  });

  it('logs, and never rejects, when the background create finishes after the pending result', async () => {
    const held = gate();
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async () => {
        await held.wait;
        return HttpResponse.json(createAgentFixture, { status: 201 });
      }),
    );
    const lines: string[] = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const timer = manualTimer();

    const pending = runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README' },
      logger: createLogger({ level: 'debug', write: (line) => void lines.push(line) }),
      startTimer: timer.start,
    });
    timer.fire();
    const result = await pending;
    expect(result['pending']).toBe(true);

    held.open();
    await vi.waitFor(() => expect(lines.join('')).toContain('launch_agent create finished'));
    expect(lines.join('')).toContain(AGENT);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('logs a warning, and never rejects, when the background create fails after the pending result', async () => {
    const held = gate();
    mswServer.use(
      http.post(`${BASE}/v1/agents`, async () => {
        await held.wait;
        return HttpResponse.json(errorBody('internal_error', 'boom'), { status: 500 });
      }),
    );
    const lines: string[] = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const timer = manualTimer();

    const pending = runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README' },
      logger: createLogger({ level: 'debug', write: (line) => void lines.push(line) }),
      startTimer: timer.start,
    });
    timer.fire();
    await pending;

    held.open();
    await vi.waitFor(() => expect(lines.join('')).toContain('launch_agent create failed'));
    await new Promise((resolve) => void setTimeout(resolve, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('never returns pending when the create answers first', async () => {
    mswServer.use(http.post(`${BASE}/v1/agents`, () => HttpResponse.json(createAgentFixture, { status: 201 })));

    const result = await runLaunchAgent({
      client: makeClient(),
      input: { prompt: 'Add a README' },
      startTimer: neverFires,
    });

    expect(result['pending']).toBe(false);
    expect(result['agentId']).toBe(AGENT);
    expect(result['runId']).toBe('run-00000000-0000-0000-0000-000000000001');
  });

  it('rejects a launchTimeoutMs outside 5000-120000 at the schema level', () => {
    const schema = z.object(launchAgentInput);
    expect(schema.safeParse({ prompt: 'x', launchTimeoutMs: 4999 }).success).toBe(false);
    expect(schema.safeParse({ prompt: 'x', launchTimeoutMs: 120001 }).success).toBe(false);
    expect(schema.safeParse({ prompt: 'x', launchTimeoutMs: 45000 }).success).toBe(true);
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
