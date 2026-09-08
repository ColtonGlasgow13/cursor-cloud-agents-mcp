import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const cancelRunInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  runId: z.string().min(1).describe('Run id to cancel, e.g. "run-<uuid>".'),
};

export async function runCancelRun({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; runId: string };
}): Promise<ToolData> {
  return client.cancelRun(input);
}

export function registerCancelRun({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel an active run',
      description:
        'Cancels an active run with POST /v1/agents/{agentId}/runs/{runId}/cancel and returns Cursor\'s complete response. A cancelled run cannot be resumed.',
      inputSchema: cancelRunInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runCancelRun({ client, input })),
  );
}
