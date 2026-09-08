import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { imageInput, mcpServerInput, modeInput } from './agentInputs.js';
import { compact, withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const sendFollowupInput = {
  agentId: z.string().min(1).describe('Agent id to continue, e.g. "bc-<uuid>".'),
  prompt: z.string().min(1).describe('The follow-up instruction. The agent keeps its conversation and workspace.'),
  images: z.array(imageInput).max(5).optional().describe('Up to 5 image attachments.'),
  mode: modeInput.optional().describe('Omit to keep the conversation in its current mode.'),
  mcpServers: z
    .array(mcpServerInput)
    .max(50)
    .optional()
    .describe('REPLACES (does not merge with) the MCP servers configured at create time, for this run only.'),
};

type SendFollowupArgs = {
  agentId: string;
  prompt: string;
  images?: z.infer<typeof imageInput>[];
  mode?: z.infer<typeof modeInput>;
  mcpServers?: z.infer<typeof mcpServerInput>[];
};

export function buildCreateRunBody(input: SendFollowupArgs): Record<string, unknown> {
  return compact({
    prompt: compact({ text: input.prompt, images: input.images }),
    mode: input.mode,
    mcpServers: input.mcpServers,
  });
}

export async function runSendFollowup({
  client,
  input,
}: {
  client: CursorClient;
  input: SendFollowupArgs;
}): Promise<ToolData> {
  return client.createRun({
    agentId: input.agentId,
    body: buildCreateRunBody(input),
  });
}

export function registerSendFollowup({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'send_followup',
    {
      title: 'Send a follow-up prompt to an agent',
      description:
        'Creates a run on an existing agent with POST /v1/agents/{agentId}/runs and returns Cursor\'s complete response. The run reuses the agent conversation and workspace. Writes are never retried automatically.',
      inputSchema: sendFollowupInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runSendFollowup({ client, input })),
  );
}
