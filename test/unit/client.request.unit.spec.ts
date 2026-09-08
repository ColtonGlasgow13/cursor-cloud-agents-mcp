import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.js';
import { makeClient } from '../helpers/client.js';
import { createAgentFixture, errorBody, listAgentsFixture, meUserFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

/** Collects every stderr line a client would write at debug level. */
function captureLog(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger({ level: 'debug', write: (line) => void lines.push(line) }) };
}

describe('CursorClient request plumbing', () => {
  useMswServer();

  it('sends bearer auth, accept and a versioned user-agent on every request', async () => {
    let seen: Headers | undefined;
    mswServer.use(
      http.get(`${BASE}/v1/me`, ({ request }) => {
        seen = request.headers;
        return HttpResponse.json(meUserFixture);
      }),
    );

    await makeClient().me();

    expect(seen?.get('authorization')).toBe('Bearer crsr_test_key');
    expect(seen?.get('accept')).toBe('application/json');
    expect(seen?.get('user-agent')).toMatch(/^cursor-cloud-agents-mcp\/\d+\.\d+\.\d+$/);
  });

  it('serializes query params and drops undefined ones', async () => {
    let url: URL | undefined;
    mswServer.use(
      http.get(`${BASE}/v1/agents`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(listAgentsFixture);
      }),
    );

    await makeClient().listAgents({ limit: 5, includeArchived: false, cursor: undefined });

    expect(url?.searchParams.get('limit')).toBe('5');
    expect(url?.searchParams.get('includeArchived')).toBe('false');
    expect(url?.searchParams.has('cursor')).toBe(false);
    expect(url?.searchParams.has('prUrl')).toBe(false);
  });

  it('sends a JSON content-type only when there is a body', async () => {
    const contentTypes: (string | null)[] = [];
    mswServer.use(
      http.get(`${BASE}/v1/me`, ({ request }) => {
        contentTypes.push(request.headers.get('content-type'));
        return HttpResponse.json(meUserFixture);
      }),
      http.post(`${BASE}/v1/agents`, async ({ request }) => {
        contentTypes.push(request.headers.get('content-type'));
        return HttpResponse.json({ agent: null, run: null }, { status: 500 });
      }),
    );

    const client = makeClient();
    await client.me();
    await client.launchAgent({ prompt: { text: 'hi' } }).catch(() => undefined);

    expect(contentTypes[0]).toBeNull();
    expect(contentTypes[1]).toBe('application/json');
  });

  it('strips a trailing slash from the base URL', async () => {
    mswServer.use(http.get(`${BASE}/v1/me`, () => HttpResponse.json(meUserFixture)));
    const client = makeClient({ baseUrl: `${BASE}///` });
    await expect(client.me()).resolves.toMatchObject({ apiKeyName: 'Production API Key' });
  });
});

describe('CursorClient request logging', () => {
  useMswServer();

  it('logs one debug line per request with method, path, status and duration', async () => {
    mswServer.use(
      http.get(`${BASE}/v1/agents`, () => HttpResponse.json(listAgentsFixture)),
      http.get(`${BASE}/v1/me`, () => HttpResponse.json(meUserFixture)),
    );
    const { lines, logger } = captureLog();
    const client = makeClient({ logger });

    await client.listAgents({ limit: 5 });
    await client.me();

    const requestLines = lines.filter((line) => line.includes(' -> '));
    expect(requestLines).toHaveLength(2);
    expect(requestLines[0]).toMatch(/GET \/v1\/agents\?limit=5 -> 200 \(\d+ms\)/);
    expect(requestLines[1]).toMatch(/GET \/v1\/me -> 200 \(\d+ms\)/);
  });

  it('logs no headers, no body and no key material', async () => {
    mswServer.use(
      http.post(`${BASE}/v1/agents`, () => HttpResponse.json(createAgentFixture, { status: 201 })),
    );
    const { lines, logger } = captureLog();

    await makeClient({ logger }).launchAgent({
      prompt: { text: 'a secret prompt' },
      envVars: { SECRET_TOKEN: 'hunter2' },
    });

    const text = lines.join('');
    expect(text).toContain('POST /v1/agents -> 201');
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text).not.toContain('crsr_test_key');
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('a secret prompt');
    expect(text).not.toContain('hunter2');
  });

  it('notes rate-limited and retrying attempts on the request line', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/v1/me`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(errorBody('rate_limited', 'slow down'), {
            status: 429,
            headers: { 'retry-after': '0' },
          });
        }
        return HttpResponse.json(meUserFixture);
      }),
    );
    const { lines, logger } = captureLog();

    await makeClient({ logger }).me();

    const requestLines = lines.filter((line) => line.includes(' -> '));
    expect(requestLines[0]).toContain('rate-limited');
    expect(requestLines[0]).toContain('retrying');
    expect(requestLines[1]).toMatch(/GET \/v1\/me -> 200 \(\d+ms\)$/m);
  });

  it('logs nothing at the default level (warn)', async () => {
    mswServer.use(http.get(`${BASE}/v1/me`, () => HttpResponse.json(meUserFixture)));
    const lines: string[] = [];
    await makeClient({
      logger: createLogger({ level: 'warn', write: (line) => void lines.push(line) }),
    }).me();
    expect(lines).toEqual([]);
  });
});
