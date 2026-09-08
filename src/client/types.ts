import type { z } from 'zod';
import type {
  agentSchema,
  agentSummarySchema,
  artifactDownloadResponseSchema,
  createAgentResponseSchema,
  createRunResponseSchema,
  errorBodySchema,
  idResponseSchema,
  listAgentsResponseSchema,
  listArtifactsResponseSchema,
  listModelsResponseSchema,
  listRepositoriesResponseSchema,
  listRunsResponseSchema,
  meResponseSchema,
  modelSchema,
  runGitBranchSchema,
  runSchema,
  usageResponseSchema,
  AGENT_MODES,
  AGENT_STATUSES,
  ENV_TYPES,
  RUN_STATUSES,
} from './schemas.js';

/** Known value, or any other string the beta API may start returning. */
export type OpenEnum<T extends string> = T | (string & {});

export type RunStatus = OpenEnum<(typeof RUN_STATUSES)[number]>;
export type AgentStatus = OpenEnum<(typeof AGENT_STATUSES)[number]>;
export type AgentMode = (typeof AGENT_MODES)[number];
export type EnvType = (typeof ENV_TYPES)[number];

export type Agent = z.infer<typeof agentSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type Run = z.infer<typeof runSchema>;
export type RunGitBranch = z.infer<typeof runGitBranchSchema>;
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type ListRunsResponse = z.infer<typeof listRunsResponseSchema>;
export type IdResponse = z.infer<typeof idResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>;
export type ListRepositoriesResponse = z.infer<typeof listRepositoriesResponseSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
export type ListArtifactsResponse = z.infer<typeof listArtifactsResponseSchema>;
export type ArtifactDownloadResponse = z.infer<typeof artifactDownloadResponseSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;
