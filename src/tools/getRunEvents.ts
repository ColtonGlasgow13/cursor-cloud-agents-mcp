import { z } from 'zod';
import type { CursorClient } from '../client/index.js';
import { ALL_EVENT_TYPES } from '../client/sse.js';
import { withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const DEFAULT_MAX_WAIT_MS = 4000;
export const DEFAULT_MAX_EVENTS = 200;

export const getRunEventsInput = {
  agentId: z.string().min(1).describe('Agent id.'),
  runId: z.string().min(1).describe('Run id.'),
  afterEventId: z.string().optional().describe('Resume cursor from nextEventId in a previous response.'),
  maxWaitMs: z
    .number()
    .int()
    .min(500)
    .max(20000)
    .optional()
    .describe('Total connection and drain window, 500-20000 ms. Default 4000.'),
  maxEvents: z.number().int().min(1).max(1000).optional().describe('Maximum events to return. Default 200.'),
  eventTypes: z
    .array(z.enum(ALL_EVENT_TYPES))
    .optional()
    .describe('Optional event-type filter. By default all events except transport heartbeats are returned.'),
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
  signal,
}: {
  client: CursorClient;
  input: GetRunEventsArgs;
  signal?: AbortSignal;
}): Promise<ToolData> {
  const stream = await client.streamRunEvents({
    agentId: input.agentId,
    runId: input.runId,
    lastEventId: input.afterEventId,
    maxWaitMs: input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    maxEvents: input.maxEvents ?? DEFAULT_MAX_EVENTS,
    eventTypes: input.eventTypes,
    signal,
  });

  return {
    events: stream.events,
    eventCount: stream.events.length,
    nextEventId: stream.lastEventId,
    ...(stream.statusFromStream === null ? {} : { status: stream.statusFromStream }),
    ...(stream.retentionSeconds === null ? {} : { retentionSeconds: stream.retentionSeconds }),
  };
}

export function registerGetRunEvents({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'get_run_events',
    {
      title: 'Get run events',
      description:
        'Opens the run SSE endpoint for one bounded window and returns parsed events plus nextEventId for resuming. Status and interaction_update events are included by default; transport heartbeats are omitted. Cursor stream errors, including expired streams and invalid cursors, are returned as errors.',
      inputSchema: getRunEventsInput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withErrorHandling(() => runGetRunEvents({ client, input, signal: extra.signal })),
  );
}
