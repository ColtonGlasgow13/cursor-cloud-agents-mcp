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
  const { run } = await client.createRun({
    agentId: input.agentId,
    body: buildCreateRunBody(input),
  });
  return {
    agentId: input.agentId,
    runId: run.id,
    runStatus: run.status,
    run,
    nextSteps: `Poll with get_run_events (agentId="${input.agentId}", runId="${run.id}", passing afterEventId=nextEventId each time) or call wait_for_run, then get_run for the final result.`,
  };
}

export function registerSendFollowup({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'send_followup',
    {
      title: 'Send a follow-up prompt to an agent',
      description:
        'Creates a new run on an EXISTING agent, reusing its conversation history and workspace. Use this to iterate ("also add tests", "address the review comments") instead of launching a fresh agent, which would start from a clean clone.\n\nOnly one run can be active per agent: if a run is still CREATING or RUNNING this returns AgentBusyError — wait for it with wait_for_run, or stop it with cancel_run, then retry. If the agent is archived, call unarchive_agent first.\n\nNEXT STEP: follow the new run with get_run_events or wait_for_run. This call is NEVER retried automatically, because a duplicate POST would queue a second run.',
      inputSchema: sendFollowupInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runSendFollowup({ client, input })),
  );
}
