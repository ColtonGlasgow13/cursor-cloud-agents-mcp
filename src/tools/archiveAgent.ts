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
  const result = await client.archiveAgent(input);
  return {
    ...result,
    archived: true,
    nextSteps: 'Reversible: call unarchive_agent with the same agentId to bring it back.',
  };
}

export function registerArchiveAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'archive_agent',
    {
      title: 'Archive an agent',
      description:
        'Archives an agent so it stops appearing in the default agent list and its machine can be released. This is the REVERSIBLE way to clean up — prefer it over delete_agent. Idempotent: re-archiving an already-archived agent succeeds with no change, so you never need to check state first. A follow-up to an archived agent fails until you call unarchive_agent.',
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
