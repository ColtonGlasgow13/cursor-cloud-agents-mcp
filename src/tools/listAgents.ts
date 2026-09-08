import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const listAgentsInput = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100. Default 20.'),
  cursor: z.string().optional().describe('Pagination cursor: pass the `nextCursor` from a previous call.'),
  prUrl: z.string().optional().describe('Filter to agents associated with this GitHub PR URL.'),
  includeArchived: z
    .boolean()
    .optional()
    .describe('Include archived agents. The API default is true; pass false to see only live agents.'),
};

export async function runListAgents({
  client,
  input,
}: {
  client: CursorClient;
  input: { limit?: number; cursor?: string; prUrl?: string; includeArchived?: boolean };
}): Promise<ToolData> {
  const response = await client.listAgents({
    limit: input.limit,
    cursor: input.cursor,
    prUrl: input.prUrl,
    includeArchived: input.includeArchived,
  });
  return response;
}

export function registerListAgents({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_agents',
    {
      title: 'List cloud agents',
      description:
        'Returns Cursor\'s complete paginated agent-list response from GET /v1/agents. Supports PR, archive, and pagination filters.',
      inputSchema: listAgentsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListAgents({ client, input })),
  );
}
