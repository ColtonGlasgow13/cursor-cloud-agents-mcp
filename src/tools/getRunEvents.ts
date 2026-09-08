import { z } from 'zod';
import { InvalidEventCursorError, StreamExpiredError } from '../client/errors.js';
import type { CursorClient } from '../client/index.js';
import { ALL_EVENT_TYPES } from '../client/sse.js';
import {
  extractPrUrls,
  isTerminalRunStatus,
  readRunResultText,
  suggestedPollDelayMs,
  unknownStatusWarning,
  withErrorHandling,
  type RegisterToolArgs,
  type ToolData,
} from './shared.js';

export const DEFAULT_MAX_WAIT_MS = 4000;
export const DEFAULT_MAX_EVENTS = 200;

export const getRunEventsInput = {
  agentId: z.string().min(1).describe('Agent id, e.g. "bc-<uuid>".'),
  runId: z.string().min(1).describe('Run id, e.g. "run-<uuid>".'),
  afterEventId: z
    .string()
    .optional()
    .describe('Resume cursor: pass `nextEventId` from the previous call. Omit on the first call to replay from the start.'),
  maxWaitMs: z
    .number()
    .int()
    .min(500)
    .max(20000)
    .optional()
    .describe('How long to hold the stream open before returning, 500-20000 ms. Default 4000.'),
  maxEvents: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Return at most this many events. Default 200.'),
  eventTypes: z
    .array(z.enum(ALL_EVENT_TYPES))
    .optional()
    .describe(
      'Event types to include. Default: assistant, thinking, tool_call, result, error, done (status/heartbeat/interaction_update are dropped to keep responses small). heartbeat is never returned.',
    ),
};

interface GetRunEventsArgs {
  agentId: string;
  runId: string;
  afterEventId?: string;
  maxWaitMs?: number;
  maxEvents?: number;
  eventTypes?: string[];
}

export async function runGetRunEvents({
  client,
  input,
}: {
  client: CursorClient;
  input: GetRunEventsArgs;
}): Promise<ToolData> {
  const { agentId, runId } = input;
  const maxWaitMs = input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxEvents = input.maxEvents ?? DEFAULT_MAX_EVENTS;

  try {
    const stream = await client.streamRunEvents({
      agentId,
      runId,
      lastEventId: input.afterEventId,
      maxWaitMs,
      maxEvents,
      eventTypes: input.eventTypes,
    });

    let runStatus = stream.statusFromStream;
    // `isTerminal` is always derived from `runStatus` so the two can never
    // disagree in the response (a "not finished, status FINISHED" hint would
    // send the caller into an endless poll). A leading `status` event can
    // report a terminal status with no `done` ever following, and conversely a
    // `done` can arrive before the run record catches up.
    let isTerminal = isTerminalRunStatus(runStatus);
    let snapshot: Awaited<ReturnType<CursorClient['getRun']>> | undefined;

    // Exactly one cheap GET when the stream did not leave a consistent status:
    // it never reported one, or it ended (done/result, or the socket closed)
    // while the status we hold is still non-terminal.
    if (runStatus === null || ((stream.sawTerminal || stream.closedByServer) && !isTerminal)) {
      snapshot = await client.getRun({ agentId, runId });
      runStatus = snapshot.status;
      isTerminal = isTerminalRunStatus(runStatus);
    }

    const nextEventId = stream.lastEventId;
    const warning = unknownStatusWarning(runStatus);
    // Only claim there is result text when a snapshot proved it: a CANCELLED or
    // ERROR run reaches a terminal status with no assistant reply at all.
    const noResultText = snapshot !== undefined && readRunResultText(snapshot) === undefined;
    return {
      events: stream.events,
      eventCount: stream.events.length,
      nextEventId,
      isTerminal,
      runStatus,
      streamExpired: false,
      cursorInvalid: false,
      retentionSeconds: stream.retentionSeconds,
      ...(snapshot === undefined ? {} : { run: snapshot, prUrls: extractPrUrls(snapshot) }),
      suggestedPollDelayMs: suggestedPollDelayMs(isTerminal),
      ...(warning === undefined ? {} : { warning }),
      hint: isTerminal
        ? `Finished with status ${runStatus ?? 'unknown'}. ${
            noResultText
              ? 'This run produced no result text; call get_run for the final state and PR URLs.'
              : 'Call get_run for the final result text and PR URLs.'
          }`
        : `Not finished (status ${runStatus ?? 'unknown'}). Sleep ~5s, then call get_run_events again with afterEventId=${
            nextEventId === null ? '(omit it)' : `"${nextEventId}"`
          }. Each poll costs one request against the ~20/min budget, so do not poll faster than every few seconds.`,
    };
  } catch (error) {
    if (error instanceof StreamExpiredError) {
      const run = await client.getRun({ agentId, runId });
      const isTerminal = isTerminalRunStatus(run.status);
      return {
        events: [],
        eventCount: 0,
        nextEventId: null,
        isTerminal,
        runStatus: run.status,
        streamExpired: true,
        cursorInvalid: false,
        run,
        prUrls: extractPrUrls(run),
        suggestedPollDelayMs: suggestedPollDelayMs(isTerminal),
        hint: 'Stream retention window passed; use get_run for the final state. Do not call get_run_events again for this run.',
      };
    }
    if (error instanceof InvalidEventCursorError) {
      const run = await client.getRun({ agentId, runId });
      const isTerminal = isTerminalRunStatus(run.status);
      return {
        events: [],
        eventCount: 0,
        nextEventId: null,
        isTerminal,
        runStatus: run.status,
        streamExpired: false,
        cursorInvalid: true,
        run,
        prUrls: extractPrUrls(run),
        suggestedPollDelayMs: suggestedPollDelayMs(isTerminal),
        hint: 'cursor was not valid for this run; call again without afterEventId (replays from the start) or use get_run.',
      };
    }
    throw error;
  }
}

export function registerGetRunEvents({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_run_events',
    {
      title: 'Poll a run for new events',
      description:
        "The SSE-to-poll bridge: opens the run's event stream, collects whatever arrives within maxWaitMs (default 4s), closes it, and returns the events plus a resume cursor. This is the main way to watch a cloud agent work.\n\nHOW TO USE: call once with no afterEventId, then repeatedly with afterEventId=<the nextEventId you were just given>, sleeping ~5s between calls, until isTerminal is true. Then call get_run for the final result text and PR URLs. Every call costs one request against the ~20 requests/minute budget — do not poll in a tight loop. For a single longer wait, use wait_for_run instead.\n\nReturns assistant/thinking/tool_call/result/error/done events by default when they occur; heartbeats and status framing are dropped. Do NOT wait for a `done` or `result` event: some runs (a 3-minute plan-mode run, live) finish without ever emitting one, and their completion is visible only in the run status. `isTerminal` is derived from that status and is the only signal to trust. If `streamExpired` is true the retention window has passed and you must switch to get_run. If `cursorInvalid` is true your afterEventId did not belong to this run — call again without it.",
      inputSchema: getRunEventsInput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => withErrorHandling(() => runGetRunEvents({ client, input })),
  );
}
