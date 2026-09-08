import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const listModelsInput = {
  refresh: z.boolean().optional().describe('Bypass the 10-minute client cache and re-fetch.'),
};

export async function runListModels({
  client,
  input,
}: {
  client: CursorClient;
  input: { refresh?: boolean };
}): Promise<ToolData> {
  return client.listModels({ refresh: input.refresh ?? false });
}

export function registerListModels({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_models',
    {
      title: 'List available models',
      description:
        'Returns Cursor\'s complete model-list response from GET /v1/models. Results are cached for 10 minutes; pass refresh:true to bypass the cache.',
      inputSchema: listModelsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListModels({ client, input })),
  );
}
