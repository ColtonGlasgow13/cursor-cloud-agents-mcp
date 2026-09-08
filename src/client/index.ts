import type { z } from 'zod';
import { createLogger, silentLogger, type Logger } from '../log.js';
import { USER_AGENT } from '../version.js';
import { TtlCache } from './cache.js';
import { NetworkError, ResponseValidationError } from './errors.js';
import { mapHttpError, readRequestId, type ErrorContext } from './httpErrors.js';
import {
  artifactDownloadResponseSchema,
  agentSchema,
  createAgentResponseSchema,
  createRunResponseSchema,
  idResponseSchema,
  listAgentsResponseSchema,
  listArtifactsResponseSchema,
  listModelsResponseSchema,
  listRepositoriesResponseSchema,
  listRunsResponseSchema,
  meResponseSchema,
  runSchema,
  usageResponseSchema,
} from './schemas.js';
import { drainRunEventStream, STREAM_RETENTION_HEADER, type StreamRunEventsResult } from './sse.js';
import type {
  Agent,
  ArtifactDownloadResponse,
  CreateAgentResponse,
  CreateRunResponse,
  IdResponse,
  ListAgentsResponse,
  ListArtifactsResponse,
  ListModelsResponse,
  ListRepositoriesResponse,
  ListRunsResponse,
  MeResponse,
  Run,
  UsageResponse,
} from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | undefined;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
export const REPOSITORIES_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export interface CursorClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: FetchLike;
  cache?: TtlCache<unknown>;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected for deterministic backoff jitter in tests. */
  random?: () => number;
}

interface RequestArgs<T> {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  schema: z.ZodType<T>;
  context?: ErrorContext;
  signal?: AbortSignal;
  deadlineMs?: number;
}

/**
 * The one and only place HTTP happens.
 *
 * Retries are GET-only by construction: `POST /v1/agents` and
 * `POST /v1/agents/{id}/runs` create real work, the API has no idempotency key,
 * and a blind retry would launch a duplicate agent or run.
 */
export class CursorClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly cache: TtlCache<unknown>;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: CursorClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((r) => void setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? silentLogger;
    this.cache = options.cache ?? new TtlCache<unknown>({ ttlMs: MODELS_CACHE_TTL_MS, now: this.now });
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * `/v1/agents?limit=5` — path and query only. Deliberately NEVER the headers
   * (Authorization) or the body (prompts, envVars): this line is written to
   * stderr on every request at debug level.
   */
  private logTarget(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...extra,
    };
  }

  private backoffMs(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) return retryAfterMs;
    const exponential = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    const jittered = Math.floor(this.random() * exponential);
    return Math.min(MAX_BACKOFF_MS, jittered);
  }

  /** Returns false when cancellation wins. The underlying injected sleep may finish later, but sends no request. */
  private async sleepBeforeRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) {
      await this.sleep(ms);
      return true;
    }
    if (signal.aborted) return false;
    let removeAbort = (): void => {};
    const aborted = new Promise<false>((resolve) => {
      const onAbort = (): void => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
    });
    try {
      return await Promise.race([this.sleep(ms).then(() => true as const), aborted]);
    } finally {
      removeAbort();
    }
  }

  private async request<T>({
    method,
    path,
    query,
    body,
    schema,
    context,
    signal,
    deadlineMs,
  }: RequestArgs<T>): Promise<T> {
    const url = this.buildUrl(path, query);
    const target = this.logTarget(url);
    const canRetry = method === 'GET';
    let attempt = 0;

    for (;;) {
      attempt += 1;
      if (isAborted(signal) || (deadlineMs !== undefined && this.now() >= deadlineMs)) {
        throw new NetworkError({ message: `Request was cancelled (${method} ${path}).` });
      }
      const startedAt = this.now();

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: this.headers(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (cause) {
        const willRetry = canRetry && attempt < MAX_ATTEMPTS && !isAborted(signal);
        this.logger.debug(
          `${method} ${target} -> network error (${this.now() - startedAt}ms)${willRetry ? ' retrying' : ''}`,
        );
        const networkError = new NetworkError({
          message: `Could not reach the Cursor API (${method} ${path}): ${cause instanceof Error ? cause.message : String(cause)}`,
          guidance: canRetry
            ? 'Network failure after retries. Check connectivity to https://api.cursor.com and try again.'
            : 'Network failure on a write request, which is never retried automatically — the agent or run MAY still have been created. Call list_agents / list_runs to check before resending.',
          cause,
        });
        if (willRetry) {
          this.logger.warn('retrying after network error', { attempt, method, path });
          const waitMs = this.backoffMs(attempt, undefined);
          if (deadlineMs !== undefined && waitMs >= deadlineMs - this.now()) throw networkError;
          if (!(await this.sleepBeforeRetry(waitMs, signal))) throw networkError;
          continue;
        }
        throw networkError;
      }

      const elapsedMs = this.now() - startedAt;
      const retryable = response.status === 429 || response.status >= 500;
      let willRetry = canRetry && retryable && attempt < MAX_ATTEMPTS;
      this.logger.debug(
        `${method} ${target} -> ${response.status} (${elapsedMs}ms)${
          response.status === 429 ? ' rate-limited' : ''
        }`,
      );

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const error = mapHttpError({
          status: response.status,
          headers: response.headers,
          bodyText,
          method,
          path,
          nowMs: this.now(),
          context,
        });
        const retryAfterMs =
          'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
            ? error.retryAfterMs
            : undefined;
        if (retryAfterMs !== undefined && retryAfterMs > MAX_BACKOFF_MS) willRetry = false;
        if (willRetry) {
          const waitMs = this.backoffMs(attempt, retryAfterMs);
          if (deadlineMs !== undefined && waitMs >= deadlineMs - this.now()) throw error;
          this.logger.warn('retrying after error response', {
            attempt,
            method,
            path,
            status: response.status,
            waitMs,
          });
          if (!(await this.sleepBeforeRetry(waitMs, signal))) throw error;
          continue;
        }
        throw error;
      }

      const text = await response.text();
      let raw: unknown;
      try {
        raw = text === '' ? {} : (JSON.parse(text) as unknown);
      } catch (cause) {
        throw new ResponseValidationError({
          message: `Cursor API returned a non-JSON body for ${method} ${path}.`,
          status: response.status,
          requestId: readRequestId(response.headers),
          issues: [],
          rawBody: text.slice(0, 2000),
          details: text.slice(0, 2000),
          guidance: 'This usually means a proxy or an outage page answered instead of the API.',
          cause,
        });
      }

      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          this.logger.warn('Cursor API response schema changed; returning native JSON object', {
            method,
            path,
            requestId: readRequestId(response.headers),
            issues: parsed.error.issues.map(
              (issue) => `${issue.path.join('.') === '' ? '(root)' : issue.path.join('.')}: ${issue.message}`,
            ),
          });
          return raw as T;
        }
        throw new ResponseValidationError({
          message: `Cursor API returned a JSON value instead of an object for ${method} ${path}.`,
          status: response.status,
          requestId: readRequestId(response.headers),
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join('.') === '' ? '(root)' : issue.path.join('.')}: ${issue.message}`,
          ),
          rawBody: raw,
          details: raw,
        });
      }
      return parsed.data;
    }
  }

  // ---------------------------------------------------------------- identity

  me(): Promise<MeResponse> {
    return this.request({ method: 'GET', path: '/v1/me', schema: meResponseSchema });
  }

  async listModels({ refresh = false }: { refresh?: boolean } = {}): Promise<ListModelsResponse> {
    const key = 'models';
    if (refresh) this.cache.delete(key);
    const cached = refresh ? undefined : this.cache.get(key);
    if (cached !== undefined) return cached as ListModelsResponse;
    const data = await this.request({
      method: 'GET',
      path: '/v1/models',
      schema: listModelsResponseSchema,
    });
    this.cache.set(key, data);
    return data;
  }

  async listRepositories({ refresh = false }: { refresh?: boolean } = {}): Promise<ListRepositoriesResponse> {
    const key = 'repositories';
    if (refresh) this.cache.delete(key);
    const cached = refresh ? undefined : this.cache.get(key);
    if (cached !== undefined) return cached as ListRepositoriesResponse;
    const data = await this.request({
      method: 'GET',
      path: '/v1/repositories',
      schema: listRepositoriesResponseSchema,
    });
    this.cache.set(key, data);
    return data;
  }

  // ------------------------------------------------------------------ agents

  /** NEVER retried: no idempotency key exists in v1. */
  launchAgent(body: Record<string, unknown>): Promise<CreateAgentResponse> {
    const agentId = typeof body['agentId'] === 'string' ? body['agentId'] : undefined;
    return this.request({
      method: 'POST',
      path: '/v1/agents',
      body,
      schema: createAgentResponseSchema,
      context: agentId === undefined ? undefined : { agentId },
    });
  }

  listAgents(args: {
    limit?: number;
    cursor?: string;
    prUrl?: string;
    includeArchived?: boolean;
  } = {}): Promise<ListAgentsResponse> {
    return this.request({
      method: 'GET',
      path: '/v1/agents',
      query: {
        limit: args.limit,
        cursor: args.cursor,
        prUrl: args.prUrl,
        includeArchived: args.includeArchived,
      },
      schema: listAgentsResponseSchema,
    });
  }

  getAgent({ agentId }: { agentId: string }): Promise<Agent> {
    return this.request({
      method: 'GET',
      path: `/v1/agents/${encodeURIComponent(agentId)}`,
      schema: agentSchema,
      context: { agentId },
    });
  }

  archiveAgent({ agentId }: { agentId: string }): Promise<IdResponse> {
    return this.request({
      method: 'POST',
      path: `/v1/agents/${encodeURIComponent(agentId)}/archive`,
      schema: idResponseSchema,
      context: { agentId },
    });
  }

  unarchiveAgent({ agentId }: { agentId: string }): Promise<IdResponse> {
    return this.request({
      method: 'POST',
      path: `/v1/agents/${encodeURIComponent(agentId)}/unarchive`,
      schema: idResponseSchema,
      context: { agentId },
    });
  }

  deleteAgent({ agentId }: { agentId: string }): Promise<IdResponse> {
    return this.request({
      method: 'DELETE',
      path: `/v1/agents/${encodeURIComponent(agentId)}`,
      schema: idResponseSchema,
      context: { agentId },
    });
  }

  // -------------------------------------------------------------------- runs

  /** NEVER retried: a duplicate POST would queue a second run. */
  createRun({ agentId, body }: { agentId: string; body: Record<string, unknown> }): Promise<CreateRunResponse> {
    return this.request({
      method: 'POST',
      path: `/v1/agents/${encodeURIComponent(agentId)}/runs`,
      body,
      schema: createRunResponseSchema,
      context: { agentId },
    });
  }

  listRuns({
    agentId,
    limit,
    cursor,
  }: {
    agentId: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListRunsResponse> {
    return this.request({
      method: 'GET',
      path: `/v1/agents/${encodeURIComponent(agentId)}/runs`,
      query: { limit, cursor },
      schema: listRunsResponseSchema,
      context: { agentId },
    });
  }

  getRun({
    agentId,
    runId,
    signal,
    deadlineMs,
  }: {
    agentId: string;
    runId: string;
    signal?: AbortSignal;
    deadlineMs?: number;
  }): Promise<Run> {
    return this.request({
      method: 'GET',
      path: `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      schema: runSchema,
      context: { agentId, runId },
      signal,
      deadlineMs,
    });
  }

  cancelRun({ agentId, runId }: { agentId: string; runId: string }): Promise<IdResponse> {
    return this.request({
      method: 'POST',
      path: `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      schema: idResponseSchema,
      context: { agentId, runId },
    });
  }

  // -------------------------------------------------------- usage, artifacts

  getUsage({ agentId, runId }: { agentId: string; runId?: string }): Promise<UsageResponse> {
    return this.request({
      method: 'GET',
      path: `/v1/agents/${encodeURIComponent(agentId)}/usage`,
      query: { runId },
      schema: usageResponseSchema,
      context: { agentId, runId },
    });
  }

  listArtifacts({ agentId }: { agentId: string }): Promise<ListArtifactsResponse> {
    return this.request({
      method: 'GET',
      path: `/v1/agents/${encodeURIComponent(agentId)}/artifacts`,
      schema: listArtifactsResponseSchema,
      context: { agentId },
    });
  }

  /**
   * Slow on purpose: Cursor mints the presigned URL on demand and this was
   * measured at 37.7s live. No fetch timeout is set here (or anywhere in
   * `request`) — do not add one below 60s.
   */
  getArtifactDownloadUrl({
    agentId,
    path,
  }: {
    agentId: string;
    path: string;
  }): Promise<ArtifactDownloadResponse> {
    return this.request({
      method: 'GET',
      path: `/v1/agents/${encodeURIComponent(agentId)}/artifacts/download`,
      query: { path },
      schema: artifactDownloadResponseSchema,
      context: { agentId, resource: `artifact ${path} on agent ${agentId}` },
    });
  }

  // ------------------------------------------------------------------ stream

  /**
   * Opens the run SSE stream, drains it for at most `maxWaitMs`, then closes it.
   * The deadline covers connection, pre-body retries and body drain.
   */
  async streamRunEvents({
    agentId,
    runId,
    lastEventId,
    maxWaitMs,
    maxEvents = 200,
    eventTypes,
    signal,
  }: {
    agentId: string;
    runId: string;
    lastEventId?: string;
    maxWaitMs: number;
    maxEvents?: number;
    eventTypes?: string[];
    signal?: AbortSignal;
  }): Promise<StreamRunEventsResult> {
    if (signal?.aborted === true) {
      throw new NetworkError({ message: 'Run event stream request was cancelled before it started.' });
    }
    const path = `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
    const url = this.buildUrl(path);
    const target = this.logTarget(url);
    const controller = new AbortController();
    let deadlineReached = false;
    const timeout = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
    }, maxWaitMs);
    const deadline = this.now() + maxWaitMs;
    const abortOuter = (): void => controller.abort();
    signal?.addEventListener('abort', abortOuter, { once: true });

    let attempt = 0;
    try {
      for (;;) {
        if (controller.signal.aborted) {
          if (deadlineReached) {
            return {
              events: [],
              lastEventId: lastEventId ?? null,
              statusFromStream: null,
              retentionSeconds: null,
              closedByServer: false,
            };
          }
          throw new NetworkError({ message: `Run event stream request was cancelled (${path}).` });
        }
        attempt += 1;

        const startedAt = this.now();
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            headers: this.headers({
              Accept: 'text/event-stream',
              // `Last-Event-ID` is a request HEADER for this endpoint, not a query param.
              ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }),
            }),
            signal: controller.signal,
          });
        } catch (cause) {
          this.logger.debug(`GET ${target} -> network error (${this.now() - startedAt}ms)`);
          if (deadlineReached) {
            return {
              events: [],
              lastEventId: lastEventId ?? null,
              statusFromStream: null,
              retentionSeconds: null,
              closedByServer: false,
            };
          }
          if (attempt < MAX_ATTEMPTS && !controller.signal.aborted) {
            const waitMs = Math.min(this.backoffMs(attempt, undefined), Math.max(0, deadline - this.now()));
            if (waitMs <= 0) continue;
            if (!(await this.sleepBeforeRetry(waitMs, controller.signal))) {
              if (deadlineReached) {
                return {
                  events: [],
                  lastEventId: lastEventId ?? null,
                  statusFromStream: null,
                  retentionSeconds: null,
                  closedByServer: false,
                };
              }
              throw new NetworkError({ message: `Run event stream request was cancelled (${path}).` });
            }
            continue;
          }
          throw new NetworkError({
            message: `Could not open the run event stream (${path}): ${cause instanceof Error ? cause.message : String(cause)}`,
            guidance: 'Call get_run instead to read the run status without streaming.',
            cause,
          });
        }

        const retryableStatus = response.status === 429 || response.status >= 500;
        this.logger.debug(
          `GET ${target} -> ${response.status} (${this.now() - startedAt}ms)${
            response.status === 429 ? ' rate-limited' : ''
          }`,
        );

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          const error = mapHttpError({
            status: response.status,
            headers: response.headers,
            bodyText,
            method: 'GET',
            path,
            nowMs: this.now(),
            context: { agentId, runId },
          });
          const retryAfterMs =
              'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
                ? error.retryAfterMs
                : undefined;
          const waitMs = this.backoffMs(attempt, retryAfterMs);
          if (
            retryableStatus &&
            attempt < MAX_ATTEMPTS &&
            waitMs <= MAX_BACKOFF_MS &&
            waitMs < deadline - this.now()
          ) {
            this.logger.warn('retrying run event stream after error response', {
              attempt,
              path,
              status: response.status,
              waitMs,
            });
            if (!(await this.sleepBeforeRetry(waitMs, controller.signal))) throw error;
            continue;
          }
          throw error;
        }

        const retentionHeader = response.headers.get(STREAM_RETENTION_HEADER);
        const retentionSeconds =
          retentionHeader === null || Number.isNaN(Number(retentionHeader))
            ? null
            : Number(retentionHeader);

        if (response.body === null) {
          return {
            events: [],
            lastEventId: lastEventId ?? null,
            statusFromStream: null,
            retentionSeconds,
            closedByServer: true,
          };
        }

        // Bytes are flowing: from here on we never retry, we just drain.
        const drained = await drainRunEventStream({
          body: response.body,
          maxWaitMs: Math.max(0, deadline - this.now()),
          maxEvents,
          eventTypes,
          retentionSeconds,
          now: this.now,
          logger: this.logger,
          onStop: () => controller.abort(),
        });
        return { ...drained, lastEventId: drained.lastEventId ?? lastEventId ?? null };
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortOuter);
      // Belt and braces: the drain aborts through `onStop`, but every other way
      // out of this method (an error response, a bodyless 200, a throw) must
      // also release the socket instead of leaving the request in flight.
      controller.abort();
    }
  }
}

export { createLogger, TtlCache };
export type { StreamRunEventsResult };
