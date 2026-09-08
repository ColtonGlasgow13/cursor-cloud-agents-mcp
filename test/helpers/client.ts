import { CursorClient, type CursorClientOptions, type FetchLike } from '../../src/client/index.js';
import { BASE } from './mswServer.js';

/** A client with instant retries and a huge budget, unless a test says otherwise. */
export function makeClient(overrides: Partial<CursorClientOptions> = {}): CursorClient {
  return new CursorClient({
    apiKey: 'crsr_test_key',
    baseUrl: BASE,
    rateLimitPerMin: 10_000,
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });
}

/** Deterministic clock whose `sleep` advances time. */
export function fakeClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  return {
    now: (): number => current,
    sleep: async (ms: number): Promise<void> => {
      current += ms;
    },
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

export type { FetchLike };
