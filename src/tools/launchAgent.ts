import { z } from 'zod';
import { AgentIdConflictError, BadRequestError } from '../client/errors.js';
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
  prompt: z.string().min(1).describe('What the agent should do. Be specific; this is the whole task brief.'),
  images: z.array(imageInput).max(5).optional().describe('Up to 5 image attachments.'),
  repos: z
    .array(repoInput)
    .max(20)
    .optional()
    .describe(
      'Repositories to work in, as URLs or {url,startingRef,prUrl} objects. OMIT this (and `env`) for a cheap no-repo agent.',
    ),
  env: envInput.optional(),
  model: z.string().optional().describe('Model id from list_models, e.g. "composer-2". Omit to use the account default.'),
  modelParams: z
    .array(z.object({ id: z.string(), value: z.string() }))
    .optional()
    .describe('Model parameters, e.g. [{"id":"thinking","value":"high"}]. Requires `model`.'),
  name: z.string().max(100).optional().describe('Display name. Auto-derived from the prompt when omitted.'),
  mode: modeInput.optional(),
  autoCreatePR: z.boolean().optional().describe('Open a pull request automatically when the run finishes. Default false.'),
  skipReviewerRequest: z.boolean().optional().describe('Only meaningful with autoCreatePR: do not request reviewers.'),
  workOnCurrentBranch: z.boolean().optional().describe('Commit to the starting branch instead of a new cursor/* branch.'),
  envVars: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'BETA and silently ignored unless enabled for the account: environment variables for the agent VM. Max 50, keys cannot start with CURSOR_. Cannot be combined with `agentId`.',
    ),
  mcpServers: z.array(mcpServerInput).max(50).optional().describe('MCP servers the cloud agent may call.'),
  customSubagents: z.array(customSubagentInput).max(20).optional(),
  agentId: agentIdInput
    .optional()
    .describe(
      'Optional client-supplied id ("bc-<uuid>") that makes this launch safe to retry: re-sending the same id returns the EXISTING agent instead of creating a duplicate. Cannot be combined with envVars.',
    ),
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
      guidance: 'Pass `model` (an id from list_models) alongside `modelParams`, or drop `modelParams`.',
    });
  }
  if (input.agentId !== undefined && input.envVars !== undefined) {
    throw new BadRequestError({
      message: 'agentId cannot be combined with envVars.',
      guidance:
        'The Cursor API mints the agent id itself when secrets are involved. Drop `agentId` to use `envVars`, or drop `envVars` to keep the retry-safe `agentId`.',
    });
  }

  return compact({
    prompt: compact({ text: input.prompt, images: input.images }),
    model:
      input.model === undefined ? undefined : compact({ id: input.model, params: input.modelParams }),
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
  const body = buildLaunchAgentBody(input);

  try {
    const { agent, run } = await client.launchAgent(body);
    return {
      agentId: agent.id,
      runId: run.id,
      agentStatus: agent.status,
      runStatus: run.status,
      name: agent.name,
      url: agent.url,
      alreadyExisted: false,
      agent,
      run,
      nextSteps: `Poll with get_run_events (agentId="${agent.id}", runId="${run.id}", then pass afterEventId=nextEventId each time) or call wait_for_run. When it is terminal, call get_run for the final result text and PR URLs.`,
    };
  } catch (error) {
    // Quasi-idempotency: the API refuses a duplicate client-supplied agentId
    // instead of replaying the original create, so fetch what already exists.
    if (!(error instanceof AgentIdConflictError) || input.agentId === undefined) throw error;
    const agentId = input.agentId;
    const agent = await client.getAgent({ agentId });
    const runs = await client.listRuns({ agentId, limit: 1 });
    const run = runs.items[0];
    return {
      agentId: agent.id,
      runId: run?.id,
      agentStatus: agent.status,
      runStatus: run?.status,
      name: agent.name,
      url: agent.url,
      alreadyExisted: true,
      agent,
      run,
      nextSteps:
        run === undefined
          ? 'An agent with this agentId already existed and has no runs yet. Use send_followup to give it work.'
          : `An agent with this agentId already existed — nothing new was launched. Its latest run is ${run.id} (${run.status}); follow it with get_run_events or wait_for_run.`,
    };
  }
}

export function registerLaunchAgent({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'launch_agent',
    {
      title: 'Launch a Cursor cloud agent',
      description:
        'Creates a Cursor cloud agent and immediately starts its first run. Use this to hand a coding task to Cursor\'s cloud: it clones the repos you name, works autonomously, pushes a `cursor/*` branch and (with autoCreatePR) opens a PR. Returns agentId + runId right away — the run is asynchronous and begins in status CREATING.\n\nNEXT STEP after calling this: follow the run with get_run_events (pass afterEventId=nextEventId on each poll) or wait_for_run, then get_run for the final result text and PR URLs.\n\nNotes: omit BOTH `repos` and `env` for a cheap no-repo agent (good for prompt-only work). `mode:"plan"` produces a plan instead of changes. `envVars` is beta-gated and is SILENTLY IGNORED when the account does not have it — verify before relying on it. Pass a fixed `agentId` ("bc-<uuid>") to make the launch safe to retry: a duplicate id returns the existing agent with alreadyExisted:true instead of launching twice. This call is NEVER retried automatically, because a duplicate POST would launch a second agent.',
      inputSchema: launchAgentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runLaunchAgent({ client, input })),
  );
}
