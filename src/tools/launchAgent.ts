import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentIdConflictError, BadRequestError } from '../client/errors.js';
import type { CursorClient } from '../client/index.js';
import type { CreateAgentResponse } from '../client/types.js';
import { silentLogger, type Logger } from '../log.js';
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

/**
 * Below the MCP SDK's 60s default client timeout (DEFAULT_REQUEST_TIMEOUT_MSEC),
 * because `POST /v1/agents` blocks until the first run is provisioned and has
 * been measured at 61.9s for a trivial no-repo agent. Returning a `pending`
 * result at 45s is the difference between the caller learning the agentId and
 * the client aborting on a billed agent nobody can find.
 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 45_000;

/** Resolved by the timer arm of the create race. */
const LAUNCH_TIMED_OUT = 'launch-timed-out';

/** Cancellable timer, injected in tests. `sleep` cannot be cancelled, so it is not enough here. */
export type StartLaunchTimer = (args: { ms: number; fire: () => void }) => { cancel: () => void };

const defaultStartTimer: StartLaunchTimer = ({ ms, fire }) => {
  const handle = setTimeout(fire, ms);
  return { cancel: () => clearTimeout(handle) };
};

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
  launchTimeoutMs: z
    .number()
    .int()
    .min(5000)
    .max(120000)
    .optional()
    .describe(
      "How long to wait for the Cursor API's create call before returning a pending result. The create endpoint blocks until the first run is provisioned (often 60s+). Keep this below your MCP client's tool timeout. 5000-120000 ms, default 45000.",
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
  launchTimeoutMs?: number;
};

/** Who chose the agent id: the caller, this server, or the Cursor API. */
export type AgentIdSource = 'caller' | 'client' | 'server';

/**
 * Every launch gets an agentId up front when it can, so a create that outlives
 * the MCP client's timeout is still recoverable: the id is in the pending
 * result, `get_agent` finds it once the API catches up, and re-sending it turns
 * a duplicate launch into a 409 agent_id_conflict this tool resolves.
 *
 * `envVars` is the one case where the API mints the id itself, so there is
 * nothing to pre-assign; a generated `name` becomes the only handle on it.
 */
export function resolveLaunchIdentity(input: LaunchAgentArgs): {
  agentId: string | undefined;
  agentIdSource: AgentIdSource;
  name: string | undefined;
} {
  if (input.agentId !== undefined) {
    return { agentId: input.agentId, agentIdSource: 'caller', name: input.name };
  }
  if (input.envVars !== undefined) {
    return {
      agentId: undefined,
      agentIdSource: 'server',
      name: input.name ?? `mcp-launch-${randomUUID().slice(0, 8)}`,
    };
  }
  return { agentId: `bc-${randomUUID()}`, agentIdSource: 'client', name: input.name };
}

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

function pendingHint({ agentId, name }: { agentId: string | undefined; name: string | undefined }): string {
  if (agentId !== undefined) {
    return `The Cursor API is still creating this agent; the request continues in the background of this MCP server. Poll get_agent with agentId="${agentId}" about every 10s (it returns NotFoundError until the agent exists), then list_runs with that agentId to get the first runId, then get_run_events or wait_for_run. Do NOT launch again without an agentId — that would create a second billed agent; calling launch_agent again with agentId="${agentId}" is safe and returns this same agent.`;
  }
  return `The Cursor API is still creating this agent and \`envVars\` forces a server-minted agent id, so this server does not know the id yet. Call list_agents about every 10s and find the agent named "${
    name ?? '(the name you passed)'
  }", then list_runs with its id to get the first runId, then get_run_events or wait_for_run. Do NOT launch again — that would create a second billed agent. Drop \`envVars\` next time so a retry-safe agentId can be pre-assigned client-side.`;
}

export async function runLaunchAgent({
  client,
  input,
  logger = silentLogger,
  startTimer = defaultStartTimer,
}: {
  client: CursorClient;
  input: LaunchAgentArgs;
  logger?: Logger;
  startTimer?: StartLaunchTimer;
}): Promise<ToolData> {
  const { agentId: launchAgentId, agentIdSource, name } = resolveLaunchIdentity(input);
  const body = buildLaunchAgentBody({ ...input, agentId: launchAgentId, name });
  const launchTimeoutMs = input.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;

  const inFlight = client.launchAgent(body);
  // Attached before anything can await: if the timer wins the race below this
  // promise outlives the tool call, and an unobserved rejection would otherwise
  // reach process-level unhandledRejection handling.
  inFlight
    .then((created) => {
      logger.info('launch_agent create finished', {
        agentId: created.agent.id,
        runId: created.run.id,
        runStatus: created.run.status,
      });
    })
    .catch((error: unknown) => {
      logger.warn('launch_agent create failed', {
        agentId: launchAgentId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    });

  // Cancelled on every exit path, so a create that answers in 300ms does not
  // leave a 45s handle armed on the event loop.
  let cancelTimer = (): void => {};
  const timeout = new Promise<typeof LAUNCH_TIMED_OUT>((resolve) => {
    const armed = startTimer({ ms: launchTimeoutMs, fire: () => resolve(LAUNCH_TIMED_OUT) });
    cancelTimer = armed.cancel;
  });

  try {
    const outcome: CreateAgentResponse | typeof LAUNCH_TIMED_OUT = await Promise.race([
      inFlight,
      timeout,
    ]);

    if (outcome === LAUNCH_TIMED_OUT) {
      return {
        pending: true,
        agentId: launchAgentId ?? null,
        agentIdSource,
        runId: null,
        agentStatus: null,
        runStatus: null,
        ...(name === undefined ? {} : { name }),
        launchTimeoutMs,
        hint: pendingHint({ agentId: launchAgentId, name }),
      };
    }

    const { agent, run } = outcome;
    return {
      pending: false,
      agentId: agent.id,
      agentIdSource,
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
      pending: false,
      agentId: agent.id,
      agentIdSource,
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
  } finally {
    cancelTimer();
  }
}

export function registerLaunchAgent({ server, client, logger }: RegisterToolArgs): void {
  server.registerTool(
    'launch_agent',
    {
      title: 'Launch a Cursor cloud agent',
      description:
        'Creates a Cursor cloud agent and starts its first run. Use this to hand a coding task to Cursor\'s cloud: it clones the repos you name, works autonomously, pushes a `cursor/*` branch and (with autoCreatePR) opens a PR.\n\nIMPORTANT — this call can be slow: Cursor\'s create endpoint blocks until the first run is provisioned and has been measured at 60s+ even for a trivial no-repo agent. If it has not answered within `launchTimeoutMs` (default 45s, deliberately under the MCP default 60s tool timeout) this tool returns a SUCCESS result with `pending: true` and the `agentId` it pre-assigned, while the create keeps running in the background. That is not a failure and the agent is NOT lost: follow the `hint` — poll get_agent with that agentId, then list_runs for the first runId. Never re-launch without passing that agentId; that bills a second agent.\n\nNEXT STEP on a normal (non-pending) result: follow the run with get_run_events (pass afterEventId=nextEventId on each poll) or wait_for_run, then get_run for the final result text and PR URLs.\n\nNotes: omit BOTH `repos` and `env` for a cheap no-repo agent (good for prompt-only work). `mode:"plan"` produces a plan instead of changes. `envVars` is beta-gated, is SILENTLY IGNORED when the account does not have it, and forces a server-minted agent id — so a launch that uses it cannot be pre-assigned an id and must be recovered by `name` via list_agents. Otherwise this server always sends a client-generated `agentId` ("bc-<uuid>", `agentIdSource: "client"`) so the launch is retry-safe: re-sending the same id returns the existing agent with alreadyExisted:true instead of launching twice. This call is NEVER retried automatically, because a duplicate POST would launch a second agent.',
      inputSchema: launchAgentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => withErrorHandling(() => runLaunchAgent({ client, input, logger })),
  );
}
