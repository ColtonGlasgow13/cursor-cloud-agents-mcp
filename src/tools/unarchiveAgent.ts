import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const unarchiveAgentInput = {
  agentId: z.string().min(1).describe('Agent id to unarchive, e.g. "bc-<uuid>".'),
};

export async function runUnarchiveAgent({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string };
}): Promise<ToolData> {
  return client.unarchiveAgent(input);
}

export function registerUnarchiveAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'unarchive_agent',
    {
      title: 'Unarchive an agent',
      description:
        'Unarchives an agent with POST /v1/agents/{agentId}/unarchive and returns Cursor\'s complete response. The agent can accept follow-up runs again.',
      inputSchema: unarchiveAgentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runUnarchiveAgent({ client, input })),
  );
}
