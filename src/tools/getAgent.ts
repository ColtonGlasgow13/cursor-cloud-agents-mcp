import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const getAgentInput = {
  agentId: z
    .string()
    .min(1)
    .describe('Agent id, e.g. "bc-00000000-0000-0000-0000-000000000001" (from launch_agent or list_agents).'),
};

export async function runGetAgent({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string };
}): Promise<ToolData> {
  const agent = await client.getAgent({ agentId: input.agentId });
  return {
    agent,
    nextSteps:
      agent.latestRunId === undefined
        ? 'This agent has no runs yet. Use send_followup to start one.'
        : `Latest run is ${agent.latestRunId}. Call get_run or wait_for_run with runId=${agent.latestRunId} for its state.`,
  };
}

export function registerGetAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_agent',
    {
      title: 'Get a cloud agent',
      description:
        'Fetches the full record for one Cursor cloud agent: status (ACTIVE/IDLE/ARCHIVED), env, repos, autoCreatePR, url, and latestRunId. Use it to find the current run id for an agent you already know, or to check whether an agent is archived before sending a follow-up. For per-run progress use get_run / get_run_events instead — agent status only says whether a turn is in flight.',
      inputSchema: getAgentInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetAgent({ client, input })),
  );
}
