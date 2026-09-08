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
  const result = await client.unarchiveAgent(input);
  return {
    ...result,
    archived: false,
    nextSteps: 'The agent accepts follow-ups again. Call send_followup to give it work.',
  };
}

export function registerUnarchiveAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'unarchive_agent',
    {
      title: 'Unarchive an agent',
      description:
        'Restores an archived agent so it accepts follow-up runs again. Use this after AgentArchivedError from send_followup. Idempotent: unarchiving a live agent succeeds with no change.',
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
