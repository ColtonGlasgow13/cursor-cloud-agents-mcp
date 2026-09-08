import { afterAll, describe, expect, it } from 'vitest';
import { CursorClient } from '../../src/client/index.js';
import { runDeleteAgent } from '../../src/tools/deleteAgent.js';
import { runGetRun } from '../../src/tools/getRun.js';
import { runGetRunEvents } from '../../src/tools/getRunEvents.js';
import { runLaunchAgent } from '../../src/tools/launchAgent.js';

/**
 * Hits the REAL Cursor API. Opt in with:
 *   RUN_INTEGRATION=1 CURSOR_API_KEY=crsr_... pnpm test:integration
 * Kept to the minimum number of requests; never calls list_repositories.
 */
const enabled = process.env['RUN_INTEGRATION'] === '1' && (process.env['CURSOR_API_KEY'] ?? '') !== '';

describe.skipIf(!enabled)('cloud agent lifecycle (live API)', () => {
  const client = new CursorClient({
    apiKey: process.env['CURSOR_API_KEY'] ?? '',
    baseUrl: process.env['CURSOR_API_BASE'] ?? 'https://api.cursor.com',
  });
  let agentId: string | undefined;

  afterAll(async () => {
    if (agentId === undefined) return;
    await runDeleteAgent({ client, input: { agentId, confirm: true } }).catch(() => undefined);
  });

  it('launches a no-repo agent, polls it to a terminal status and deletes it', async () => {
    const launched = await runLaunchAgent({
      client,
      input: { prompt: 'Reply with the single word PONG and finish.', name: 'mcp integration smoke' },
    });
    agentId = String(launched['agentId']);
    const runId = String(launched['runId']);
    expect(agentId).toMatch(/^bc-/);

    let afterEventId: string | undefined;
    let terminal = false;
    for (let poll = 0; poll < 20 && !terminal; poll += 1) {
      const events = await runGetRunEvents({
        client,
        input: { agentId, runId, afterEventId, maxWaitMs: 15_000 },
      });
      terminal = events['isTerminal'] === true;
      const next = events['nextEventId'];
      if (typeof next === 'string') afterEventId = next;
    }
    expect(terminal, 'run did not reach a terminal status in time').toBe(true);

    const final = await runGetRun({ client, input: { agentId, runId } });
    expect(final['isTerminal']).toBe(true);
    expect(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']).toContain(String(final['runStatus'] ?? ''));
  }, 600_000);
});
