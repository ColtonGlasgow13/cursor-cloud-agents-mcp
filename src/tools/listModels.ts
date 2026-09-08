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
  const response = await client.listModels({ refresh: input.refresh ?? false });
  return {
    items: response.items,
    hint: 'Pass one of these `id` values as `model` to launch_agent. Omit `model` entirely to use the account default (user default, then team default, then system default).',
  };
}

export function registerListModels({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_models',
    {
      title: 'List available models',
      description:
        'Lists the models this API key may pass to launch_agent, with their ids, display names, and any tunable parameters/variants (e.g. {"id":"thinking","value":"high"}). Use it before launch_agent when the user names a model, or after an invalid_model error. Results are cached for 10 minutes; pass refresh:true to bypass.',
      inputSchema: listModelsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListModels({ client, input })),
  );
}
