import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const listRepositoriesInput = {
  refresh: z
    .boolean()
    .optional()
    .describe('Bypass the 10-minute client cache. Use sparingly — the server-side limit is 1 request per minute.'),
};

export async function runListRepositories({
  client,
  input,
}: {
  client: CursorClient;
  input: { refresh?: boolean };
}): Promise<ToolData> {
  const response = await client.listRepositories({ refresh: input.refresh ?? false });
  return {
    items: response.items,
    count: response.items.length,
    hint: 'Pass one of these `url` values in launch_agent `repos`. Cached for 10 minutes — do not call this in a loop.',
  };
}

export function registerListRepositories({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_repositories',
    {
      title: 'List connected GitHub repositories',
      description:
        'Lists the GitHub repositories Cursor can clone for this account (url only). Use it once to discover exact repo URLs for launch_agent, or after a repository_access error.\n\nRATE LIMIT WARNING: the Cursor API allows only 1 request per minute and 30 per hour for this endpoint, and it can take tens of seconds to answer for large orgs. This server caches results for 10 minutes and refuses extra calls locally rather than burning the budget — do not call it in a loop, and prefer a repo URL the user already gave you.',
      inputSchema: listRepositoriesInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListRepositories({ client, input })),
  );
}
