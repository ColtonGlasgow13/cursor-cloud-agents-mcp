import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const deleteAgentInput = {
  agentId: z.string().min(1).describe('Agent id to delete permanently, e.g. "bc-<uuid>".'),
  confirm: z
    .literal(true)
    .describe('Must be true. Deletion is permanent — the agent, its runs and its workspace are gone.'),
};

export async function runDeleteAgent({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; confirm: true };
}): Promise<ToolData> {
  const result = await client.deleteAgent({ agentId: input.agentId });
  return {
    ...result,
    deleted: true,
    nextSteps: 'Permanent. The agent id now returns NotFoundError; its run history and artifacts are unrecoverable.',
  };
}

export function registerDeleteAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'delete_agent',
    {
      title: 'Delete an agent permanently',
      description:
        'Permanently deletes an agent, its run history and its workspace. IRREVERSIBLE — prefer archive_agent unless the user explicitly asked for deletion. Requires confirm:true. Use it to clean up throwaway agents (e.g. a no-repo test agent you just launched).',
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
