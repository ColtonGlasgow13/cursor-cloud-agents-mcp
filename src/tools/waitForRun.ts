import { z } from 'zod';
import {
  InvalidEventCursorError,
  LocalRateLimitError,
  StreamExpiredError,
} from '../client/errors.js';
import type { CursorClient } from '../client/index.js';
import {
  extractPrUrls,
  isTerminalRunStatus,
  unknownStatusWarning,
  withErrorHandling,
  type RegisterToolArgs,
  type ToolData,
} from './shared.js';

export const DEFAULT_WAIT_MS = 55_000;
/** One MCP tool call re-opens the stream in windows this long. */
export const STREAM_WINDOW_MS = 20_000;
const MIN_USEFUL_WINDOW_MS = 500;

export const waitForRunInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  runId: z.string().min(1).describe('Run id, e.g. "run-<uuid>".'),
  maxWaitMs: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .describe('How long to block waiting for the run to finish, 1000-120000 ms. Default 55000.'),
  afterEventId: z
    .string()
    .optional()
    .describe('Resume cursor from a previous wait_for_run or get_run_events call.'),
};

interface WaitForRunArgs {
  agentId: string;
  runId: string;
  maxWaitMs?: number;
  afterEventId?: string;
}

export async function runWaitForRun({
  client,
  input,
  now = Date.now,
}: {
  client: CursorClient;
  input: WaitForRunArgs;
  now?: () => number;
}): Promise<ToolData> {
  const { agentId, runId } = input;
  const maxWaitMs = input.maxWaitMs ?? DEFAULT_WAIT_MS;
  const startedAt = now();
  const deadline = startedAt + maxWaitMs;

  let lastEventId: string | null = input.afterEventId ?? null;
  let eventCount = 0;
  let sawTerminal = false;
  let streamExpired = false;
  let cursorInvalid = false;

  while (!sawTerminal) {
    const remaining = deadline - now();
    if (remaining < MIN_USEFUL_WINDOW_MS) break;
    try {
      const stream = await client.streamRunEvents({
        agentId,
        runId,
        lastEventId: lastEventId ?? undefined,
        maxWaitMs: Math.min(STREAM_WINDOW_MS, remaining),
        maxEvents: 1000,
      });
      eventCount += stream.events.length;
      lastEventId = stream.lastEventId ?? lastEventId;
      if (stream.sawTerminal) {
        sawTerminal = true;
        break;
      }
      if (stream.closedByServer) {
        const probe = await client.getRun({ agentId, runId });
        if (isTerminalRunStatus(probe.status)) break;
      }
    } catch (error) {
      if (error instanceof StreamExpiredError) {
        streamExpired = true;
        break;
      }
      if (error instanceof LocalRateLimitError) {
        // Our own budget is spent; stop re-opening the stream and report the
        // snapshot instead of failing the whole call.
        break;
      }
      if (error instanceof InvalidEventCursorError) {
        // Drop the bad cursor and replay from the start of the retained window.
        cursorInvalid = true;
        lastEventId = null;
        continue;
      }
      throw error;
    }
  }

  const run = await client.getRun({ agentId, runId });
  const isTerminal = isTerminalRunStatus(run.status);
  const elapsedMs = now() - startedAt;
  const prUrls = extractPrUrls(run);
  const warning = unknownStatusWarning(run.status);

  return {
    isTerminal,
    runStatus: run.status,
    run,
    prUrls,
    ...(run.result === undefined ? {} : { result: run.result }),
    eventCount,
    lastEventId,
    elapsedMs,
    streamExpired,
    cursorInvalid,
    ...(warning === undefined ? {} : { warning }),
    hint: isTerminal
      ? `Run ended with status ${run.status} after ${Math.round(elapsedMs / 1000)}s.${
          prUrls.length > 0 ? ` PR(s): ${prUrls.join(', ')}.` : ''
        } \`result\` holds the final assistant reply.`
      : `Still running after ${Math.round(elapsedMs / 1000)}s; call wait_for_run again with afterEventId=${
          lastEventId === null ? '(omit it)' : `"${lastEventId}"`
        }. This is not an error.`,
  };
}

export function registerWaitForRun({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'wait_for_run',
    {
      title: 'Wait for a run to finish',
      description:
        'Blocks until the run reaches a terminal status (FINISHED/ERROR/CANCELLED/EXPIRED) or maxWaitMs elapses (default 55s), then returns the final run snapshot, `result` text, PR URLs and how many events went by. Use this instead of get_run_events when you do not need to see intermediate output — it is far cheaper on the request budget than polling.\n\nHitting the deadline is NOT an error: you get isTerminal:false and a lastEventId. Call wait_for_run again with afterEventId=<lastEventId> to keep waiting. Cloud agent runs often take several minutes, so expect to call this a few times.',
      inputSchema: waitForRunInput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runWaitForRun({ client, input })),
  );
}
