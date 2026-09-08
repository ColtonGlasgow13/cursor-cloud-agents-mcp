import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/client/cache.js';
import { fakeClock, makeClient } from '../helpers/client.js';
import { modelsFixture } from '../helpers/fixtures.js';
import { BASE, mswServer, useMswServer } from '../helpers/mswServer.js';

describe('TtlCache', () => {
  it('expires entries once the TTL passes', () => {
    const clock = fakeClock(0);
    const cache = new TtlCache<string>({ ttlMs: 1000, now: clock.now });
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
    clock.advance(999);
    expect(cache.get('k')).toBe('v');
    clock.advance(2);
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('list_models caching', () => {
  useMswServer();

  it('caches for 10 minutes and re-fetches afterwards, and on refresh', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/v1/models`, () => {
        calls += 1;
        return HttpResponse.json(modelsFixture);
      }),
    );
    const clock = fakeClock(0);
    const client = makeClient({ now: clock.now, sleep: clock.sleep });

    const first = await client.listModels();
    await client.listModels();
    expect(calls).toBe(1);
    expect(first.items[0]?.id).toBe('composer-2');

    clock.advance(9 * 60 * 1000);
    await client.listModels();
    expect(calls).toBe(1);

    clock.advance(2 * 60 * 1000);
    await client.listModels();
    expect(calls).toBe(2);

    await client.listModels({ refresh: true });
    expect(calls).toBe(3);
  });
});
