import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const whoamiInput = {};

export async function runWhoami({ client }: { client: CursorClient }): Promise<ToolData> {
  const me = await client.me();
  return {
    ...me,
    keyScope: me.userId === undefined ? 'service-account' : 'user',
    nextSteps:
      'The API key works. Use list_repositories to see which repos are connected, or launch_agent to start work.',
  };
}

export function registerWhoami({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'whoami',
    {
      title: 'Show Cursor API key identity',
      description:
        'Returns the identity behind the configured Cursor API key (key name, creation time, and the user fields when it is a user-scoped key; service-account keys return only name + createdAt). Use this first when any other tool reports AuthError, to confirm the key is valid before debugging anything else. Never returns the key itself.',
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
