import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const downloadArtifactInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  path: z
    .string()
    .min(1)
    .describe('Artifact path from list_artifacts, relative to the workspace, e.g. "artifacts/screenshot.png".'),
};

export async function runDownloadArtifact({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; path: string };
}): Promise<ToolData> {
  return client.getArtifactDownloadUrl(input);
}

export function registerDownloadArtifact({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'download_artifact',
    {
      title: 'Get an artifact download URL',
      description:
        'Requests an artifact download response from GET /v1/agents/{agentId}/artifacts/download. Returns Cursor\'s complete response, including the presigned URL; it does not fetch the artifact bytes.',
      inputSchema: downloadArtifactInput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runDownloadArtifact({ client, input })),
  );
}
