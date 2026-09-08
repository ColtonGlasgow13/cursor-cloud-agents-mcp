import { z } from 'zod';
import { BadRequestError } from '../client/errors.js';
import type { CursorClient } from '../client/index.js';
import {
  agentIdInput,
  customSubagentInput,
  envInput,
  imageInput,
  mcpServerInput,
  modeInput,
  normalizeRepos,
  repoInput,
} from './agentInputs.js';
import { compact, withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const launchAgentInput = {
  prompt: z.string().min(1).describe('Instruction for the first run.'),
  images: z.array(imageInput).max(5).optional().describe('Up to 5 image attachments.'),
  repos: z.array(repoInput).max(20).optional().describe('Repository URLs or repository configuration objects.'),
  env: envInput.optional(),
  model: z.string().optional().describe('Model id from list_models. Omit to use the account default.'),
  modelParams: z
    .array(z.object({ id: z.string(), value: z.string() }))
    .optional()
    .describe('Model parameters. Requires model.'),
  name: z.string().max(100).optional().describe('Optional agent display name.'),
  mode: modeInput.optional(),
  autoCreatePR: z.boolean().optional().describe('Whether Cursor should open a pull request.'),
  skipReviewerRequest: z.boolean().optional().describe('With autoCreatePR, do not request reviewers.'),
  workOnCurrentBranch: z.boolean().optional().describe('Work on the starting branch instead of a new branch.'),
  envVars: z
    .record(z.string(), z.string())
    .optional()
    .describe('Agent environment variables. Cannot be combined with agentId.'),
  mcpServers: z.array(mcpServerInput).max(50).optional().describe('MCP servers available to the cloud agent.'),
  customSubagents: z.array(customSubagentInput).max(20).optional(),
  agentId: agentIdInput.optional().describe('Optional client-supplied agent id. Cannot be combined with envVars.'),
};

type LaunchAgentArgs = {
  prompt: string;
  images?: z.infer<typeof imageInput>[];
  repos?: z.infer<typeof repoInput>[];
  env?: z.infer<typeof envInput>;
  model?: string;
  modelParams?: { id: string; value: string }[];
  name?: string;
  mode?: z.infer<typeof modeInput>;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  workOnCurrentBranch?: boolean;
  envVars?: Record<string, string>;
  mcpServers?: z.infer<typeof mcpServerInput>[];
  customSubagents?: z.infer<typeof customSubagentInput>[];
  agentId?: string;
};

export function buildLaunchAgentBody(input: LaunchAgentArgs): Record<string, unknown> {
  if (input.modelParams !== undefined && input.model === undefined) {
    throw new BadRequestError({
      message: 'modelParams was provided without model.',
      guidance: 'Pass model alongside modelParams, or omit modelParams.',
    });
  }
  if (input.agentId !== undefined && input.envVars !== undefined) {
    throw new BadRequestError({
      message: 'agentId cannot be combined with envVars.',
      guidance: 'Omit either agentId or envVars.',
    });
  }

  return compact({
    prompt: compact({ text: input.prompt, images: input.images }),
    model: input.model === undefined ? undefined : compact({ id: input.model, params: input.modelParams }),
    name: input.name,
    agentId: input.agentId,
    env: input.env,
    repos: normalizeRepos(input.repos),
    workOnCurrentBranch: input.workOnCurrentBranch,
    autoCreatePR: input.autoCreatePR,
    skipReviewerRequest: input.skipReviewerRequest,
    envVars: input.envVars,
    mcpServers: input.mcpServers,
    customSubagents: input.customSubagents,
    mode: input.mode,
  });
}

export async function runLaunchAgent({
  client,
  input,
}: {
  client: CursorClient;
  input: LaunchAgentArgs;
}): Promise<ToolData> {
  return client.launchAgent(buildLaunchAgentBody(input));
}

export function registerLaunchAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'launch_agent',
    {
      title: 'Launch a Cursor cloud agent',
      description:
        'Creates an agent and starts its first run with POST /v1/agents. Returns Cursor\'s complete create response. The API call is awaited and can take more than a minute, so configure the MCP client tool timeout to at least 180 seconds. Writes are never retried automatically; after an ambiguous network or server failure, inspect list_agents before launching again.',
      inputSchema: launchAgentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runLaunchAgent({ client, input })),
  );
}
