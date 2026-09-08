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
  const response = await client.listRuns(input);
  return {
    items: response.items,
    ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
    hint:
      response.nextCursor === undefined
        ? 'Last page.'
        : `More results available: call list_runs again with cursor="${response.nextCursor}".`,
  };
}

export function registerListRuns({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_runs',
    {
      title: 'List runs for an agent',
      description:
        "Lists the runs on one agent (each follow-up prompt creates a run), newest-first, with status and — for terminal runs — durationMs, result text and git branches. Use it to review an agent's history or to find the run id you lost. Returns `items` and `nextCursor` (absent on the last page).",
      inputSchema: listRunsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListRuns({ client, input })),
  );
}
