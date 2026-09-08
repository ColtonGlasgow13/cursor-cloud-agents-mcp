import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const deleteAgentInput = {
  agentId: z.string().min(1).describe('Agent id to delete permanently, e.g. "bc-<uuid>".'),
};

export async function runDeleteAgent({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string };
}): Promise<ToolData> {
  return client.deleteAgent(input);
}

export function registerDeleteAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'delete_agent',
    {
      title: 'Delete an agent permanently',
      description:
        'Permanently deletes an agent with DELETE /v1/agents/{agentId} and returns Cursor\'s complete response. This removes its run history and workspace and cannot be undone.',
      inputSchema: deleteAgentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runDeleteAgent({ client, input })),
  );
}
