import { STREAM_RETENTION_HEADER } from '../../src/client/sse.js';
import type { FetchLike } from '../../src/client/index.js';

export interface SseResponseOptions {
  /** Raw event-stream text. Written as one or more chunks. */
  text?: string;
  /** Keep the stream open after the text instead of closing it. */
  stall?: boolean;
  retentionSeconds?: number;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export function sseBody({ text = '', stall = false }: { text?: string; stall?: boolean }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        if (text !== '') controller.enqueue(encoder.encode(text));
        if (!stall) controller.close();
        return undefined;
      }
      if (stall) {
        // Never resolves: emulates a live run that has gone quiet.
        return new Promise<void>(() => undefined);
      }
      controller.close();
      return undefined;
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
  return new Response(sseBody({ text: options.text, stall: options.stall }), {
    status,
    headers: {
      'content-type': 'text/event-stream',
      [STREAM_RETENTION_HEADER]: String(options.retentionSeconds ?? 3600),
      ...options.headers,
    },
  });
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
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
    calls.push({ url: String(input), headers });
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
    calls.push({ url, headers });
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
