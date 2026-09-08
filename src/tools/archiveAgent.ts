import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const archiveAgentInput = {
  agentId: z.string().min(1).describe('Agent id to archive, e.g. "bc-<uuid>".'),
};

export async function runArchiveAgent({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string };
}): Promise<ToolData> {
  return client.archiveAgent(input);
}

export function registerArchiveAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'archive_agent',
    {
      title: 'Archive an agent',
      description:
        'Archives an agent with POST /v1/agents/{agentId}/archive and returns Cursor\'s complete response. An archived agent cannot accept follow-up runs until it is unarchived.',
      inputSchema: archiveAgentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runArchiveAgent({ client, input })),
  );
}
