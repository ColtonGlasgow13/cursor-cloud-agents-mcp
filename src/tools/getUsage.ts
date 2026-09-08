import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const getUsageInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  runId: z.string().optional().describe('Optional: scope the report to a single run.'),
};

export async function runGetUsage({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; runId?: string };
}): Promise<ToolData> {
  const usage = await client.getUsage(input);
  return {
    agentId: input.agentId,
    ...usage,
    hint: 'Token counts match the team usage events endpoint. Runs with no recorded usage yet report zeros.',
  };
}

export function registerGetUsage({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_usage',
    {
      title: 'Get token usage for an agent',
      description:
        'Reports token usage (input/output/cache-read/cache-write/total) for an agent, optionally scoped to one run. Use it to answer "how much did that cost" after a run finishes.\n\nThis endpoint is EARLY ACCESS: accounts without it get FeatureUnavailableError (HTTP 403 feature_unavailable). That is not a bug and retrying will not help — report that usage data is unavailable and move on.',
      inputSchema: getUsageInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetUsage({ client, input })),
  );
}
