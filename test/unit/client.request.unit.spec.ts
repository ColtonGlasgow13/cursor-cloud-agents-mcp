import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { makeClient } from '../helpers/client.js';
import { listAgentsFixture, meUserFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

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
