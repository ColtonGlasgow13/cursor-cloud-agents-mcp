import { z } from 'zod';

/**
 * Response schemas for Cursor Cloud Agents API v1.
 *
 * The API is in public beta and its OpenAPI spec already disagrees with its own
 * prose (agent status is documented as 2 values in the schema and 3 in the
 * docs). So: every object is `looseObject` (unknown fields pass through) and
 * every enum-ish field is typed `z.string()` with the known values exported
 * separately as const arrays. Unknown values must never fail parsing.
 */

/** Documented run statuses. `status` itself is parsed as an open string. */
export const RUN_STATUSES = [
  'CREATING',
  'RUNNING',
  'FINISHED',
  'ERROR',
  'CANCELLED',
  'EXPIRED',
] as const;

/** Statuses that populate `durationMs` / `result` / `git` and end the run. */
export const TERMINAL_RUN_STATUSES = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'] as const;

export const NON_TERMINAL_RUN_STATUSES = ['CREATING', 'RUNNING'] as const;

/** ACTIVE/ARCHIVED per the OpenAPI enum, IDLE per the prose docs. Open string. */
export const AGENT_STATUSES = ['ACTIVE', 'IDLE', 'ARCHIVED'] as const;

export const AGENT_MODES = ['agent', 'plan'] as const;

export const ENV_TYPES = ['cloud', 'pool', 'machine'] as const;

/** Client-supplied agent ids must be `bc-<uuid>`. */
export const AGENT_ID_PATTERN =
  /^bc-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const agentEnvSchema = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
});

export const repoConfigSchema = z.looseObject({
  url: z.string(),
  startingRef: z.string().optional(),
  prUrl: z.string().optional(),
});

export const agentSummarySchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  status: z.string(),
  env: agentEnvSchema,
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRunId: z.string().optional(),
  /** Undocumented, observed live on create, get_agent AND list items. */
  openAsCursorGithubApp: z.boolean().optional(),
});

export const agentSchema = agentSummarySchema.extend({
  repos: z.array(repoConfigSchema).optional(),
  workOnCurrentBranch: z.boolean().optional(),
  autoCreatePR: z.boolean().optional(),
  skipReviewerRequest: z.boolean().optional(),
  customSubagents: z.array(z.looseObject({ name: z.string() })).optional(),
});

/** `repoUrl` comes back WITHOUT the scheme (e.g. `github.com/org/repo`). */
export const runGitBranchSchema = z.looseObject({
  repoUrl: z.string(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
});

export const runGitSchema = z.looseObject({
  branches: z.array(runGitBranchSchema).optional(),
});

export const runSchema = z.looseObject({
  id: z.string(),
  agentId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  durationMs: z.number().optional(),
  result: z.string().optional(),
  git: runGitSchema.optional(),
});

export const createAgentResponseSchema = z.looseObject({
  agent: agentSchema,
  run: runSchema,
});

export const createRunResponseSchema = z.looseObject({
  run: runSchema,
});

/** `nextCursor` is OMITTED (not null) when there are no more pages. */
export const listAgentsResponseSchema = z.looseObject({
  items: z.array(agentSummarySchema),
  nextCursor: z.string().optional(),
});

export const listRunsResponseSchema = z.looseObject({
  items: z.array(runSchema),
  nextCursor: z.string().optional(),
});

export const idResponseSchema = z.looseObject({
  id: z.string(),
});

/** user-scoped keys return the user fields; service-account keys omit them. */
export const meResponseSchema = z.looseObject({
  apiKeyName: z.string(),
  createdAt: z.string(),
  userId: z.number().optional(),
  userEmail: z.string().optional(),
  userFirstName: z.string().optional(),
  userLastName: z.string().optional(),
});

export const modelParameterValueSchema = z.looseObject({
  value: z.string(),
  displayName: z.string().optional(),
});

export const modelParameterSchema = z.looseObject({
  id: z.string(),
  displayName: z.string().optional(),
  values: z.array(modelParameterValueSchema).optional(),
});

export const modelVariantSchema = z.looseObject({
  params: z.array(z.looseObject({ id: z.string(), value: z.string() })).optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});

export const modelSchema = z.looseObject({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  parameters: z.array(modelParameterSchema).optional(),
  variants: z.array(modelVariantSchema).optional(),
});

export const listModelsResponseSchema = z.looseObject({
  items: z.array(modelSchema),
});

export const repositorySchema = z.looseObject({
  url: z.string(),
});

export const listRepositoriesResponseSchema = z.looseObject({
  items: z.array(repositorySchema),
});

export const tokenUsageSchema = z.looseObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

/** Undocumented, observed live at the top level AND inside each `runs[]` entry. */
export const usageCostSchema = z.looseObject({
  rawCostCents: z.number().optional(),
  chargedCents: z.number().optional(),
});

// Early-access endpoint: keep everything optional so a partial rollout shape
// still parses instead of blowing up the tool call.
export const usageResponseSchema = z.looseObject({
  totalUsage: tokenUsageSchema.optional(),
  cost: usageCostSchema.optional(),
  runs: z
    .array(
      z.looseObject({
        id: z.string(),
        usageUuid: z.string().optional(),
        usage: tokenUsageSchema.optional(),
        cost: usageCostSchema.optional(),
      }),
    )
    .optional(),
});

export const artifactSchema = z.looseObject({
  path: z.string(),
  sizeBytes: z.number().optional(),
  updatedAt: z.string().optional(),
});

export const listArtifactsResponseSchema = z.looseObject({
  items: z.array(artifactSchema),
});

export const artifactDownloadResponseSchema = z.looseObject({
  url: z.string(),
  expiresAt: z.string().optional(),
});

/** `{"error": {"code", "message", "helpUrl"?, "provider"?}}` — nested, not flat. */
export const errorBodySchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    helpUrl: z.string().optional(),
    provider: z.string().optional(),
  }),
});
