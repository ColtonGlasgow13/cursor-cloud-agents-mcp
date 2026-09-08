import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const BASE = 'http://cursor.test';

export const mswServer = setupServer();

/** Call inside a describe block to wire msw lifecycle hooks. */
export function useMswServer(): void {
  beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());
}
