import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const listArtifactsInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
};

export async function runListArtifacts({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string };
}): Promise<ToolData> {
  return client.listArtifacts(input);
}

export function registerListArtifacts({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_artifacts',
    {
      title: 'List agent artifacts',
      description:
        'Returns Cursor\'s complete artifact-list response from GET /v1/agents/{agentId}/artifacts. Artifacts are agent-scoped and the endpoint is not paginated.',
      inputSchema: listArtifactsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListArtifacts({ client, input })),
  );
}
