import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const getRunInput = {
  agentId: z.string().min(1).describe('Agent id.'),
  runId: z.string().min(1).describe('Run id.'),
};

export async function runGetRun({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; runId: string };
}): Promise<ToolData> {
  return client.getRun(input);
}

export function registerGetRun({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_run',
    {
      title: 'Get a run',
      description:
        'Returns Cursor\'s complete run record from GET /v1/agents/{agentId}/runs/{runId}, including status, result, git data, and unknown fields added by the API.',
      inputSchema: getRunInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetRun({ client, input })),
  );
}
