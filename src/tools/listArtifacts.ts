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
  const response = await client.listArtifacts(input);
  return {
    items: response.items,
    count: response.items.length,
    hint:
      response.items.length === 0
        ? 'This agent produced no artifacts.'
        : 'Pass a `path` from this list to download_artifact to get a presigned download URL. At most 100 artifacts are returned and there is no pagination.',
  };
}

export function registerListArtifacts({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'list_artifacts',
    {
      title: 'List agent artifacts',
      description:
        'Lists files the agent wrote to its workspace `artifacts/` directory (path, sizeBytes, updatedAt). Artifacts are AGENT-scoped, not run-scoped, because the workspace persists across runs. Use it after a run that was asked to produce a file (screenshot, report, build output), then call download_artifact for the ones you want. Capped at 100 items with no pagination.',
      inputSchema: listArtifactsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runListArtifacts({ client, input })),
  );
}
