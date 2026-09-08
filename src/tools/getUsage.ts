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
  return client.getUsage(input);
}

export function registerGetUsage({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_usage',
    {
      title: 'Get token usage for an agent',
      description:
        'Returns Cursor\'s complete usage response from GET /v1/agents/{agentId}/usage, optionally scoped to one run. Accounts without the early-access endpoint receive Cursor\'s feature_unavailable error.',
      inputSchema: getUsageInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetUsage({ client, input })),
  );
}
