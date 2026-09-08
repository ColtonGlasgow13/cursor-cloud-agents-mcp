import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const listRunsInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100. Default 20.'),
  cursor: z.string().optional().describe('Pagination cursor: pass the `nextCursor` from a previous call.'),
};

export async function runListRuns({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; limit?: number; cursor?: string };
}): Promise<ToolData> {
  return client.listRuns(input);
}

export function registerListRuns({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_runs',
    {
      title: 'List runs for an agent',
      description:
        'Returns Cursor\'s complete paginated run-list response from GET /v1/agents/{agentId}/runs. Pass nextCursor back as cursor for another page.',
      inputSchema: listRunsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListRuns({ client, input })),
  );
}
