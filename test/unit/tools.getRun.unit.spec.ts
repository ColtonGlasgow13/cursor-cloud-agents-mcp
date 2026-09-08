import { describe, expect, it } from 'vitest';
import { runGetRun } from '../../src/tools/getRun.js';
import { makeClient } from '../helpers/client.js';
import { finishedRunFixture, runningRunFixture } from '../helpers/fixtures.js';
import { jsonResponse, recordingFetch } from '../helpers/sse.js';

const AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const RUN = 'run-00000000-0000-0000-0000-000000000001';

describe('get_run hints', () => {
  it('promises `run.result` only when the terminal run actually carries one', async () => {
    const { fetch } = recordingFetch([() => jsonResponse(finishedRunFixture)]);
    const result = await runGetRun({
      client: makeClient({ fetch }),
      input: { agentId: AGENT, runId: RUN },
    });

    expect(result['isTerminal']).toBe(true);
    const hint = String(result['hint']);
    expect(hint).toContain('`run.result` holds the final assistant reply');
    expect(hint).toContain('https://github.com/your-org/your-repo/pull/123');
    // A prUrl is present, so no reserved-branch caveat is needed.
    expect(hint).not.toContain('not proof of a push');
    // FINISHED: the plan may live in an artifact rather than in `result`.
    expect(hint).toContain('list_artifacts');
  });

  it('warns that a branch with no prUrl is reserved, not pushed', async () => {
    // Live: git.branches named cursor/mcp-live-... for a ref that never existed.
    const reserved = {
      ...finishedRunFixture,
      git: { branches: [{ repoUrl: 'github.com/your-org/your-repo', branch: 'cursor/mcp-live-da98' }] },
    };
    const { fetch } = recordingFetch([() => jsonResponse(reserved)]);

    const result = await runGetRun({
      client: makeClient({ fetch }),
      input: { agentId: AGENT, runId: RUN },
    });

    expect(result['prUrls']).toEqual([]);
    const hint = String(result['hint']);
    expect(hint).toContain('not proof of a push');
    expect(hint).toContain('`prUrl` is the only reliable signal');
  });

  it('says a terminal run produced no result text when `result` is absent', async () => {
    // A live CANCELLED run: terminal, but with no assistant reply at all.
    const cancelled = { ...finishedRunFixture, status: 'CANCELLED' } as Record<string, unknown>;
    delete cancelled['result'];
    delete cancelled['git'];
    const { fetch } = recordingFetch([() => jsonResponse(cancelled)]);

    const result = await runGetRun({
      client: makeClient({ fetch }),
      input: { agentId: AGENT, runId: RUN },
    });

    expect(result['isTerminal']).toBe(true);
    const hint = String(result['hint']);
    expect(hint).toContain('status CANCELLED');
    expect(hint).toContain('no result text');
    expect(hint).not.toContain('holds the final assistant reply');
    // The plan-artifact pointer is for FINISHED runs only.
    expect(hint).not.toContain('list_artifacts');
  });

  it('treats an empty-string result as no result text', async () => {
    const { fetch } = recordingFetch([
      () => jsonResponse({ ...finishedRunFixture, status: 'ERROR', result: '' }),
    ]);
    const result = await runGetRun({
      client: makeClient({ fetch }),
      input: { agentId: AGENT, runId: RUN },
    });
    expect(String(result['hint'])).toContain('no result text');
  });

  it('keeps the polling hint for a non-terminal run', async () => {
    const { fetch } = recordingFetch([() => jsonResponse(runningRunFixture)]);
    const result = await runGetRun({
      client: makeClient({ fetch }),
      input: { agentId: AGENT, runId: RUN },
    });
    expect(result['isTerminal']).toBe(false);
    expect(String(result['hint'])).toContain('Run is RUNNING');
  });
});
