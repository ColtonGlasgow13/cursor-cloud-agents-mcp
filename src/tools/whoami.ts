import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const whoamiInput = {};

export async function runWhoami({ client }: { client: CursorClient }): Promise<ToolData> {
  return client.me();
}

export function registerWhoami({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'whoami',
    {
      title: 'Show Cursor API key identity',
      description:
        'Returns Cursor\'s complete GET /v1/me response for the configured API key. The API key itself is never returned.',
      inputSchema: whoamiInput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => withErrorHandling(() => runWhoami({ client })),
  );
}
