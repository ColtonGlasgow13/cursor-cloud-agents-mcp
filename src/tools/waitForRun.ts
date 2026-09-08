import { z } from 'zod';
import {
  InvalidEventCursorError,
  LocalRateLimitError,
  StreamExpiredError,
} from '../client/errors.js';
import type { CursorClient } from '../client/index.js';
import type { RunEvent } from '../client/sse.js';
import type { Run } from '../client/types.js';
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
/**
 * Floor on how long one stream window + probe may take before the next one
 * opens. Cursor may close the stream immediately (e.g. while the run is still
 * CREATING); this keeps that from becoming a request-burning spin loop.
 */
const MIN_WINDOW_SPACING_MS = 5000;

/** `result` event data is `{ runId, status, text?, durationMs?, git? }`. */
function readResultText(events: RunEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== 'result') continue;
    const { data } = event;
    if (typeof data === 'object' && data !== null && 'text' in data) {
      const { text } = data as { text: unknown };
      if (typeof text === 'string' && text !== '') return text;
    }
  }
  return undefined;
}

async function pauseBetweenWindows({
  now,
  sleep,
  deadline,
  windowStartedAt,
}: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadline: number;
  windowStartedAt: number;
}): Promise<void> {
  const spent = now() - windowStartedAt;
  const pauseMs = Math.min(MIN_WINDOW_SPACING_MS - spent, deadline - now());
  if (pauseMs > 0) await sleep(pauseMs);
}

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
  sleep = (ms) => new Promise<void>((resolve) => void setTimeout(resolve, ms)),
}: {
  client: CursorClient;
  input: WaitForRunArgs;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  let cursorDropped = false;
  let streamResultText: string | undefined;
  /** Set when a probe already read a terminal snapshot, so we do not re-GET it. */
  let terminalSnapshot: Run | undefined;

  while (!sawTerminal) {
    const remaining = deadline - now();
    if (remaining < MIN_USEFUL_WINDOW_MS) break;
    const windowStartedAt = now();
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
      streamResultText = readResultText(stream.events) ?? streamResultText;
      // A `result`/`done` event, or any framing event reporting a terminal
      // status, means there is nothing left to wait for.
      if (stream.sawTerminal || isTerminalRunStatus(stream.statusFromStream)) {
        sawTerminal = true;
        break;
      }
      if (stream.closedByServer) {
        const probe = await client.getRun({ agentId, runId });
        if (isTerminalRunStatus(probe.status)) {
          terminalSnapshot = probe;
          break;
        }
        // The server hung up on a live run. Without pacing, a stream that
        // closes instantly would re-open in a tight loop and spend the whole
        // ~20/min budget in a second.
        await pauseBetweenWindows({ now, sleep, deadline, windowStartedAt });
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
      if (error instanceof InvalidEventCursorError && !cursorDropped) {
        // Drop the bad cursor once and replay from the start of the retained
        // window. Retrying more than once would just loop on the same 400.
        cursorInvalid = true;
        cursorDropped = true;
        lastEventId = null;
        continue;
      }
      throw error;
    }
  }

  let run: Run | undefined = terminalSnapshot;
  try {
    run = run ?? (await client.getRun({ agentId, runId }));
  } catch (error) {
    // The local budget ran out while waiting. That is not a failure of the
    // wait: report what we know and tell the caller exactly how to resume.
    if (!(error instanceof LocalRateLimitError)) throw error;
  }

  const elapsedMs = now() - startedAt;
  const resume = lastEventId === null ? '(omit it)' : `"${lastEventId}"`;

  if (run === undefined) {
    return {
      isTerminal: false,
      runStatus: null,
      prUrls: [],
      eventCount,
      lastEventId,
      elapsedMs,
      streamExpired,
      cursorInvalid,
      budgetExhausted: true,
      hint: `The local request budget (CURSOR_MCP_RATE_LIMIT_PER_MIN) ran out before the run finished, so its final status could not be read. Wait ~60s, then call wait_for_run again with afterEventId=${resume}. Nothing failed on Cursor's side.`,
    };
  }

  const isTerminal = isTerminalRunStatus(run.status);
  const prUrls = extractPrUrls(run);
  const warning = unknownStatusWarning(run.status);
  // `Run.result` is only populated once the run record is terminal; the stream's
  // `result` event carries the same text and often arrives first.
  const resultText = run.result ?? streamResultText;

  return {
    isTerminal,
    runStatus: run.status,
    run,
    prUrls,
    ...(resultText === undefined ? {} : { result: resultText }),
    eventCount,
    lastEventId,
    elapsedMs,
    streamExpired,
    cursorInvalid,
    budgetExhausted: false,
    ...(warning === undefined ? {} : { warning }),
    hint: isTerminal
      ? `Run ended with status ${run.status} after ${Math.round(elapsedMs / 1000)}s.${
          prUrls.length > 0 ? ` PR(s): ${prUrls.join(', ')}.` : ''
        } \`result\` holds the final assistant reply.`
      : `Still running after ${Math.round(elapsedMs / 1000)}s; call wait_for_run again with afterEventId=${resume}. This is not an error.`,
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
