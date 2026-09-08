import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CursorClient } from '../client/index.js';
import { formatErrorForTool } from '../client/errors.js';
import { RUN_STATUSES, TERMINAL_RUN_STATUSES } from '../client/schemas.js';
import type { Run } from '../client/types.js';
import type { Logger } from '../log.js';

/** Every tool returns a JSON object; the SDK sends it as text + structuredContent. */
export type ToolData = Record<string, unknown>;

export interface RegisterToolArgs {
  server: McpServer;
  client: CursorClient;
  /**
   * stderr logger. Only tools that leave work in flight after the call returns
   * (launch_agent) need it; everything else reports through its result.
   */
  logger?: Logger;
}

export const POLL_DELAY_MS = 5000;

export function toolSuccess(data: ToolData): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function toolFailure(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: formatErrorForTool(error) }],
  };
}

/**
 * Converts any thrown error into an `isError` tool result. A transport-level
 * throw would look like a broken server to the client; an error result is
 * something the model can read and act on.
 */
export async function withErrorHandling(run: () => Promise<ToolData>): Promise<CallToolResult> {
  try {
    return toolSuccess(await run());
  } catch (error) {
    return toolFailure(error);
  }
}

const TERMINAL = new Set<string>(TERMINAL_RUN_STATUSES);
const KNOWN = new Set<string>(RUN_STATUSES);

/** FINISHED | ERROR | CANCELLED | EXPIRED. Unknown statuses are non-terminal. */
export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL.has(status);
}

/** Unknown statuses are reported rather than silently treated as running. */
export function unknownStatusWarning(status: string | null | undefined): string | undefined {
  if (status === null || status === undefined || KNOWN.has(status)) return undefined;
  return `Cursor returned run status "${status}", which this server does not know. It is being treated as non-terminal; call get_run again or check https://cursor.com/agents.`;
}

export function suggestedPollDelayMs(isTerminal: boolean): number {
  return isTerminal ? 0 : POLL_DELAY_MS;
}

/**
 * PR URLs from `git.branches[].prUrl`.
 * NOTE: `Run.git` is per-AGENT state, so these can include branches from
 * earlier runs on the same agent. A branch entry WITHOUT a prUrl proves
 * nothing: see RESERVED_BRANCH_CAVEAT.
 */
export function extractPrUrls(run: Pick<Run, 'git'>): string[] {
  const urls = (run.git?.branches ?? [])
    .map((branch) => branch.prUrl)
    .filter((url): url is string => typeof url === 'string' && url !== '');
  return [...new Set(urls)];
}

/**
 * Cursor RESERVES a branch name when a run starts. A live plan-mode run came
 * back with `git.branches[0].branch = "cursor/..."` while that ref did not
 * exist on GitHub at all, so a branch entry must never be read as a push.
 */
export const RESERVED_BRANCH_CAVEAT =
  '`git.branches` lists reserved/target branch names and is not proof of a push; a `prUrl` is the only reliable signal that work was published.';

/** Plan-mode runs put the plan in an artifact; `result` is only the closing line. */
export const PLAN_ARTIFACT_HINT =
  'If this was a plan-mode run, the plan is stored as an artifact — call list_artifacts then download_artifact.';

/** Branch names but no PR: reserved, and possibly never pushed. */
export function hasUnpublishedBranches(run: Pick<Run, 'git'>): boolean {
  return (run.git?.branches ?? []).length > 0 && extractPrUrls(run).length === 0;
}

/**
 * `Run.result` when it is actually there. A terminal run is NOT guaranteed to
 * have one — CANCELLED / ERROR / EXPIRED runs routinely finish without any
 * assistant reply — so hints have to branch on this instead of promising it.
 */
export function readRunResultText(run: Pick<Run, 'result'>): string | undefined {
  return typeof run.result === 'string' && run.result !== '' ? run.result : undefined;
}

/** Drops undefined keys so request bodies never carry `"repos": null`. */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
