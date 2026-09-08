import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import {
  extractPrUrls,
  hasUnpublishedBranches,
  isTerminalRunStatus,
  readRunResultText,
  suggestedPollDelayMs,
  unknownStatusWarning,
  withErrorHandling,
  PLAN_ARTIFACT_HINT,
  RESERVED_BRANCH_CAVEAT,
  type RegisterToolArgs,
  type ToolData,
} from './shared.js';

/**
 * A terminal run does NOT always carry `result`: CANCELLED, ERROR and EXPIRED
 * runs routinely have none, so the hint must not send the model looking for it.
 */
function terminalHint({
  status,
  resultText,
  prSuffix,
  unpublishedBranches,
}: {
  status: string;
  resultText: string | undefined;
  prSuffix: string;
  unpublishedBranches: boolean;
}): string {
  const head =
    resultText === undefined
      ? `Run ended with status ${status} and produced no result text — there is no final assistant reply to read${prSuffix}.`
      : `Run finished with status ${status}. \`run.result\` holds the final assistant reply${prSuffix}.`;
  return [
    head,
    unpublishedBranches ? RESERVED_BRANCH_CAVEAT : undefined,
    status === 'FINISHED' ? PLAN_ARTIFACT_HINT : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}

export const getRunInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  runId: z.string().min(1).describe('Run id, e.g. "run-<uuid>" (from launch_agent, send_followup or list_runs).'),
};

export async function runGetRun({
  client,
  input,
}: {
  client: CursorClient;
  input: { agentId: string; runId: string };
}): Promise<ToolData> {
  const run = await client.getRun(input);
  const isTerminal = isTerminalRunStatus(run.status);
  const prUrls = extractPrUrls(run);
  const warning = unknownStatusWarning(run.status);
  const prSuffix = prUrls.length > 0 ? `; open the PR(s): ${prUrls.join(', ')}` : '';
  return {
    run,
    isTerminal,
    prUrls,
    suggestedPollDelayMs: suggestedPollDelayMs(isTerminal),
    ...(warning === undefined ? {} : { warning }),
    hint: isTerminal
      ? terminalHint({
          status: run.status,
          resultText: readRunResultText(run),
          prSuffix,
          unpublishedBranches: hasUnpublishedBranches(run),
        })
      : `Run is ${run.status}. Sleep ~5s, then call get_run again — or call wait_for_run / get_run_events to follow progress instead of polling snapshots.`,
  };
}

export function registerGetRun({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_run',
    {
      title: 'Get a run snapshot',
      description:
        'Returns one run: status, timestamps, and once terminal also durationMs, `result` (the final assistant reply, when there is one) and git branches. Adds `isTerminal`, `prUrls` (extracted from git.branches[].prUrl) and `suggestedPollDelayMs`. Use this as the FINAL step after a run ends, and as the cheap fallback whenever streaming is unavailable. Terminal statuses: FINISHED, ERROR, CANCELLED, EXPIRED — and a terminal run does not always have `result` (a cancelled or errored one usually has none).\n\nReading `git`: it is per-agent state, so entries may come from earlier runs on the same agent, and Cursor RESERVES a branch name when a run starts — a branch entry is NOT proof anything was pushed (a live run listed `cursor/...` for a ref that never existed). A `prUrl` is the only reliable signal that work was published. Plan-mode runs put the plan in an artifact rather than in `result`: use list_artifacts + download_artifact.',
      inputSchema: getRunInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetRun({ client, input })),
  );
}
