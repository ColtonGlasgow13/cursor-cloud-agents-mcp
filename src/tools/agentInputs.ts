import { z } from 'zod';
import { AGENT_ID_PATTERN, AGENT_MODES, ENV_TYPES } from '../client/schemas.js';

/** Request-side input shapes shared by launch_agent and send_followup. */

export const imageInput = z
  .object({
    data: z.string().optional().describe('Base64-encoded image bytes, max 15 MB. Mutually exclusive with `url`.'),
    url: z.string().optional().describe('HTTP(S) URL Cursor fetches. Mutually exclusive with `data`.'),
    mimeType: z
      .string()
      .optional()
      .describe('Required when `data` is set, forbidden with `url`. One of image/png, image/jpeg, image/gif, image/webp.'),
    dimension: z
      .object({ width: z.number().int().min(1), height: z.number().int().min(1) })
      .optional(),
  })
  .describe('An image attachment. Provide either `data` + `mimeType`, or `url`.');

export const repoInput = z
  .union([
    z.string().describe('Repository URL, e.g. "https://github.com/your-org/your-repo".'),
    z.object({
      url: z.string().describe('Repository URL. Required even when prUrl is set.'),
      startingRef: z.string().optional().describe('Branch name or commit SHA. Ignored when prUrl is set.'),
      prUrl: z.string().optional().describe('GitHub PR URL to continue work on.'),
    }),
  ])
  .describe('A repo URL string, or an object with url/startingRef/prUrl.');

export const mcpServerInput = z
  .union([
    z.object({
      name: z.string(),
      type: z.literal('stdio').optional(),
      command: z.string().describe('Executable run inside the agent VM.'),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      name: z.string(),
      type: z.enum(['http', 'sse']).optional(),
      url: z.string().describe('Remote MCP endpoint. Userinfo in the URL is not allowed.'),
      headers: z.record(z.string(), z.string()).optional(),
      auth: z
        .object({
          CLIENT_ID: z.string(),
          CLIENT_SECRET: z.string().optional(),
          scopes: z.array(z.string()).optional(),
        })
        .optional(),
    }),
  ])
  .describe('An MCP server for the cloud agent to use: stdio (name + command) or remote (name + url).');

export const customSubagentInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .describe('Unique name. Cannot collide with the built-ins: explore, shell, debug, computerUse, cursorGuide.'),
    description: z.string().min(1).max(1000),
    prompt: z.string().min(1).max(8192),
    model: z
      .union([
        z.literal('inherit'),
        z.string(),
        z.object({
          id: z.string(),
          params: z.array(z.object({ id: z.string(), value: z.string() })).optional(),
        }),
      ])
      .optional(),
  })
  .describe('A custom subagent definition available to the cloud agent.');

export const envInput = z
  .object({
    type: z.enum(ENV_TYPES).describe('cloud | pool | machine.'),
    name: z.string().optional().describe('Pool/environment/machine name. Defaults to "default" for type=pool.'),
  })
  .describe('Execution environment. Mutually exclusive with `repos` when a NAMED cloud env is used.');

export const modeInput = z
  .enum(AGENT_MODES)
  .describe('"agent" (default) makes changes; "plan" produces a plan without implementing it.');

export const agentIdInput = z
  .string()
  .regex(
    AGENT_ID_PATTERN,
    'agentId must look like "bc-<uuid>", e.g. bc-00000000-0000-0000-0000-000000000001.',
  );

export type RepoInput = z.infer<typeof repoInput>;

/** Repos may be given as bare URLs; the API always wants objects. */
export function normalizeRepos(repos: RepoInput[] | undefined): { url: string }[] | undefined {
  if (repos === undefined) return undefined;
  return repos.map((repo) => (typeof repo === 'string' ? { url: repo } : repo));
}
