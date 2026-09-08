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
  const result = await client.cancelRun(input);
  return {
    ...result,
    cancelled: true,
    nextSteps:
      'The run transitions to CANCELLED and cannot be resumed. Call get_run to confirm, or send_followup to continue the conversation with a new run.',
  };
}

export function registerCancelRun({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel an active run',
      description:
        'Stops the active run on an agent. Cancellation is TERMINAL: the run becomes CANCELLED and cannot be resumed — to continue the conversation, call send_followup which starts a new run on the same agent (the workspace is preserved). Use this when a run is going the wrong way, or to clear an AgentBusyError before sending a follow-up. Cancelling an already-terminal run returns RunNotCancellableError, which is safe to ignore.',
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
