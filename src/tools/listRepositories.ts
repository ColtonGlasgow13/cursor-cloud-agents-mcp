import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const listRepositoriesInput = {
  refresh: z
    .boolean()
    .optional()
    .describe('Bypass the 10-minute client cache.'),
};

export async function runListRepositories({
  client,
  input,
}: {
  client: CursorClient;
  input: { refresh?: boolean };
}): Promise<ToolData> {
  return client.listRepositories({ refresh: input.refresh ?? false });
}

export function registerListRepositories({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_repositories',
    {
      title: 'List connected GitHub repositories',
      description:
        'Returns Cursor\'s complete connected-repositories response from GET /v1/repositories. Results are cached for 10 minutes; pass refresh:true to bypass the cache.',
      inputSchema: listRepositoriesInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListRepositories({ client, input })),
  );
}
