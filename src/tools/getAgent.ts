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
  return client.getAgent(input);
}

export function registerGetAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_agent',
    {
      title: 'Get a cloud agent',
      description:
        'Returns Cursor\'s complete agent record from GET /v1/agents/{agentId}, including unknown fields added by the API.',
      inputSchema: getAgentInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetAgent({ client, input })),
  );
}
