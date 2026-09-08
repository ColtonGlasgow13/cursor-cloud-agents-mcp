import { STREAM_RETENTION_HEADER } from '../../src/client/sse.js';
import type { FetchLike } from '../../src/client/index.js';

export interface SseResponseOptions {
  /** Raw event-stream text, written as a single chunk. */
  text?: string;
  /**
   * Raw event-stream text split into explicit chunks, so a test can cut an SSE
   * line in half the way a real socket does.
   */
  chunks?: string[];
  /** Keep the stream open after the text instead of closing it. */
  stall?: boolean;
  retentionSeconds?: number;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Called when the consumer cancels the body (i.e. releases the socket). */
  onCancel?: () => void;
}

export function sseBody({
  text = '',
  chunks,
  stall = false,
  onCancel,
}: {
  text?: string;
  chunks?: string[];
  stall?: boolean;
  onCancel?: () => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = chunks ?? (text === '' ? [] : [text]);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue[index];
      if (next !== undefined) {
        index += 1;
        controller.enqueue(encoder.encode(next));
        return undefined;
      }
      if (stall) {
        // Never resolves: emulates a live run that has gone quiet.
        return new Promise<void>(() => undefined);
      }
      controller.close();
      return undefined;
    },
    cancel() {
      onCancel?.();
    },
  });
}

export function sseResponse(options: SseResponseOptions = {}): Response {
  const status = options.status ?? 200;
  if (status !== 200) {
    return new Response(options.body ?? '', {
      status,
      headers: { 'content-type': 'application/json', ...options.headers },
    });
  }
  return new Response(
    sseBody({
      text: options.text,
      chunks: options.chunks,
      stall: options.stall,
      onCancel: options.onCancel,
    }),
    {
      status,
      headers: {
        'content-type': 'text/event-stream',
        [STREAM_RETENTION_HEADER]: String(options.retentionSeconds ?? 3600),
        ...options.headers,
      },
    },
  );
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  /** The AbortSignal the client passed, so tests can assert it was aborted. */
  signal: AbortSignal | undefined;
}

/** A fetch stub that records calls and replays queued responses. */
export function recordingFetch(responses: (() => Response)[]): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  let index = 0;
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(input), headers, signal: init?.signal ?? undefined });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('recordingFetch: no response queued');
    return next();
  };
  return { fetch, calls };
}

export interface Route {
  match: (url: string) => boolean;
  responses: (() => Response)[];
}

/** A fetch stub that routes by URL; each route replays its own response list. */
export function routerFetch(routes: Route[]): {
  fetch: FetchLike;
  calls: RecordedRequest[];
  countFor: (predicate: (url: string) => boolean) => number;
} {
  const calls: RecordedRequest[] = [];
  const indexes = new Map<Route, number>();
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, headers, signal: init?.signal ?? undefined });
    const route = routes.find((candidate) => candidate.match(url));
    if (route === undefined) throw new Error(`routerFetch: no route for ${url}`);
    const index = indexes.get(route) ?? 0;
    indexes.set(route, index + 1);
    const factory = route.responses[Math.min(index, route.responses.length - 1)];
    if (factory === undefined) throw new Error(`routerFetch: no response for ${url}`);
    return factory();
  };
  return {
    fetch,
    calls,
    countFor: (predicate) => calls.filter((call) => predicate(call.url)).length,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
