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
  const artifact = await client.getArtifactDownloadUrl(input);
  return {
    path: input.path,
    url: artifact.url,
    expiresAt: artifact.expiresAt,
    hint: 'This is a presigned URL that expires in about 15 minutes. Fetch or hand it to the user promptly; call this tool again for a fresh URL (generating one takes 30-40s).',
  };
}

export function registerDownloadArtifact({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'download_artifact',
    {
      title: 'Get an artifact download URL',
      description:
        'Returns a short-lived presigned URL (`url` + `expiresAt`, roughly 15 minutes) for one artifact. This call can take 30-40s while Cursor generates the presigned URL (37.7s measured live), so allow for it and do not treat a slow response as a failure. This tool does NOT fetch the bytes — use the URL with your own download step or give it to the user. Paths must be the relative `artifacts/...` values from list_artifacts; absolute legacy v0 paths are rejected. Plan-mode plans land here as `artifacts/plans/<name>.plan.md`.',
      inputSchema: downloadArtifactInput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runDownloadArtifact({ client, input })),
  );
}
