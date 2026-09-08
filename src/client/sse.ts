import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type { Logger } from '../log.js';
import { silentLogger } from '../log.js';

/**
 * Bounded drain of the run SSE stream.
 *
 * MCP tool calls are request/response, so we never hold a stream open: we read
 * for at most `maxWaitMs`, return what arrived plus a resume cursor, and let the
 * caller poll again. Hitting the time budget is normal, not an error.
 */

export interface RunEvent {
  /** Opaque server event id, or null for events sent without an `id:` line. */
  id: string | null;
  type: string;
  /** Parsed JSON when the payload is JSON, otherwise the raw string. */
  data: unknown;
  receivedAt: string;
}

export interface StreamRunEventsResult {
  events: RunEvent[];
  lastEventId: string | null;
  sawTerminal: boolean;
  statusFromStream: string | null;
  retentionSeconds: number | null;
  closedByServer: boolean;
}

/** Framing events: they carry no content, so they never land in `events`. */
export const FRAMING_EVENT_TYPES = ['status', 'heartbeat'] as const;

/** Excluded from `events` unless the caller asks for them by name. */
export const DEFAULT_EXCLUDED_EVENT_TYPES = ['status', 'heartbeat', 'interaction_update'] as const;

export const ALL_EVENT_TYPES = [
  'status',
  'assistant',
  'thinking',
  'tool_call',
  'interaction_update',
  'heartbeat',
  'result',
  'error',
  'done',
] as const;

export const STREAM_RETENTION_HEADER = 'x-cursor-stream-retention-seconds';

/** `result`/`error` mean the run is over; we wait briefly for a trailing `done`. */
const TERMINALISH_EVENT_TYPES = new Set(['result', 'error']);
const TERMINAL_GRACE_MS = 500;

export interface DrainRunEventStreamOptions {
  body: ReadableStream<Uint8Array>;
  maxWaitMs: number;
  maxEvents: number;
  /** Types to keep in `events`. Defaults to everything but status/heartbeat/interaction_update. */
  eventTypes?: string[];
  retentionSeconds?: number | null;
  now?: () => number;
  /** Called when we stop early so the caller can abort the underlying fetch. */
  onStop?: () => void;
  logger?: Logger;
}

function parseEventData(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function readStatus(data: unknown): string | null {
  if (typeof data === 'object' && data !== null && 'status' in data) {
    const { status } = data as { status: unknown };
    if (typeof status === 'string') return status;
  }
  return null;
}

export async function drainRunEventStream({
  body,
  maxWaitMs,
  maxEvents,
  eventTypes,
  retentionSeconds = null,
  now = Date.now,
  onStop,
  logger = silentLogger,
}: DrainRunEventStreamOptions): Promise<StreamRunEventsResult> {
  const included =
    eventTypes === undefined
      ? null
      : new Set(eventTypes.filter((type) => type !== 'heartbeat'));
  const excludedByDefault = new Set<string>(DEFAULT_EXCLUDED_EVENT_TYPES);
  const isIncluded = (type: string): boolean =>
    included === null ? !excludedByDefault.has(type) : included.has(type);

  const events: RunEvent[] = [];
  let lastEventId: string | null = null;
  let sawTerminal = false;
  let statusFromStream: string | null = null;
  let closedByServer = false;
  let stop = false;
  let deadline = now() + maxWaitMs;

  const onEvent = (message: EventSourceMessage): void => {
    // A single chunk can contain many events; once we have decided to stop,
    // ignore the rest so `maxEvents` holds and the cursor does not skip ahead.
    if (stop) return;
    const type = message.event ?? 'message';
    const id = message.id !== undefined && message.id !== '' ? message.id : null;
    // Heartbeats and the id-less `status` event still move the resume cursor.
    if (id !== null) lastEventId = id;

    const data = parseEventData(message.data);

    if (type === 'status') {
      statusFromStream = readStatus(data) ?? statusFromStream;
    } else if (type === 'result') {
      sawTerminal = true;
      statusFromStream = readStatus(data) ?? statusFromStream;
    } else if (type === 'done') {
      sawTerminal = true;
      stop = true;
    } else if (TERMINALISH_EVENT_TYPES.has(type)) {
      sawTerminal = true;
    }

    if (sawTerminal && !stop && TERMINALISH_EVENT_TYPES.has(type)) {
      // Keep reading briefly in case a `done` follows on the same tick.
      deadline = Math.min(deadline, now() + TERMINAL_GRACE_MS);
    }

    if (!isIncluded(type)) return;
    events.push({ id, type, data, receivedAt: new Date(now()).toISOString() });
    if (events.length >= maxEvents) stop = true;
  };

  const parser = createParser({
    onEvent,
    onError: (error) => logger.debug('sse parse error', error),
  });

  const decoder = new TextDecoder();
  const reader = body.getReader();

  try {
    while (!stop) {
      const remaining = deadline - now();
      if (remaining <= 0) break;

      const read = reader.read();
      read.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        read,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining);
        }),
      ]).catch((error: unknown) => {
        logger.debug('sse read ended', error);
        return 'aborted' as const;
      });
      if (timer !== undefined) clearTimeout(timer);

      if (chunk === 'timeout' || chunk === 'aborted') break;
      if (chunk.done) {
        closedByServer = true;
        break;
      }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    onStop?.();
    await reader.cancel().catch(() => undefined);
  }

  return { events, lastEventId, sawTerminal, statusFromStream, retentionSeconds, closedByServer };
}
