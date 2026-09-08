import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import {
  extractPrUrls,
  isTerminalRunStatus,
  suggestedPollDelayMs,
  unknownStatusWarning,
  withErrorHandling,
  type RegisterToolArgs,
  type ToolData,
} from './shared.js';

export const getRunInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  runId: z.string().min(1).describe('Run id, e.g. "run-<uuid>" (from launch_agent, send_followup or list_runs).'),
};

export async function runGetRun({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; runId: string };
}): Promise<ToolData> {
  const run = await client.getRun(input);
  const isTerminal = isTerminalRunStatus(run.status);
  const prUrls = extractPrUrls(run);
  const warning = unknownStatusWarning(run.status);
  return {
    run,
    isTerminal,
    prUrls,
    suggestedPollDelayMs: suggestedPollDelayMs(isTerminal),
    ...(warning === undefined ? {} : { warning }),
    hint: isTerminal
      ? `Run finished with status ${run.status}. \`run.result\` holds the final assistant reply${prUrls.length > 0 ? `; open the PR(s): ${prUrls.join(', ')}` : ''}.`
      : `Run is ${run.status}. Sleep ~5s, then call get_run again — or call wait_for_run / get_run_events to follow progress instead of polling snapshots.`,
  };
}

export function registerGetRun({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_run',
    {
      title: 'Get a run snapshot',
      description:
        'Returns one run: status, timestamps, and once terminal also durationMs, `result` (the final assistant reply) and git branches. Adds `isTerminal`, `prUrls` (extracted from git.branches[].prUrl) and `suggestedPollDelayMs`. Use this as the FINAL step after a run ends, and as the cheap fallback whenever streaming is unavailable. Terminal statuses: FINISHED, ERROR, CANCELLED, EXPIRED. Note: `git` is per-agent state, so PR URLs may include branches from earlier runs on the same agent.',
      inputSchema: getRunInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetRun({ client, input })),
  );
}
