import {
  AgentArchivedError,
  AgentBusyError,
  AgentIdConflictError,
  AuthError,
  BadRequestError,
  ConflictError,
  CursorApiError,
  FeatureUnavailableError,
  ForbiddenError,
  InvalidEventCursorError,
  NotFoundError,
  RateLimitedError,
  RunNotCancellableError,
  ServerError,
  StreamExpiredError,
} from './errors.js';
import { errorBodySchema } from './schemas.js';

export interface ErrorContext {
  /** Human description of what was being addressed, e.g. "run run-1 on agent bc-1". */
  resource?: string;
  agentId?: string;
  runId?: string;
}

export interface ParsedErrorBody {
  code: string | undefined;
  message: string | undefined;
  helpUrl: string | undefined;
  provider: string | undefined;
  raw: unknown;
}

/** Tolerates non-JSON and unexpected shapes — beta APIs return both. */
export function parseErrorBody(bodyText: string): ParsedErrorBody {
  let raw: unknown = bodyText === '' ? undefined : bodyText;
  try {
    raw = JSON.parse(bodyText) as unknown;
  } catch {
    return { code: undefined, message: undefined, helpUrl: undefined, provider: undefined, raw };
  }
  const parsed = errorBodySchema.safeParse(raw);
  if (!parsed.success) {
    return { code: undefined, message: undefined, helpUrl: undefined, provider: undefined, raw };
  }
  const { code, message, helpUrl, provider } = parsed.data.error;
  return { code, message, helpUrl, provider, raw };
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date.
 *
 * The value is returned verbatim (never capped): it is what the caller is told
 * to wait. Capping belongs at the sleep site, where a single automatic backoff
 * is limited to 30s — clamping here would tell a model "wait 30s" when the API
 * asked for ten minutes.
 */
export function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

export function readRequestId(headers: Headers): string | undefined {
  for (const name of ['x-request-id', 'request-id', 'x-cursor-request-id', 'cf-ray']) {
    const value = headers.get(name);
    if (value !== null && value !== '') return value;
  }
  return undefined;
}

function describe(context: ErrorContext): string {
  if (context.resource !== undefined) return context.resource;
  if (context.runId !== undefined && context.agentId !== undefined) {
    return `run ${context.runId} on agent ${context.agentId}`;
  }
  if (context.agentId !== undefined) return `agent ${context.agentId}`;
  return 'the requested resource';
}

export interface MapHttpErrorOptions {
  status: number;
  headers: Headers;
  bodyText: string;
  method: string;
  path: string;
  nowMs: number;
  context?: ErrorContext;
}

/** Maps an HTTP error response to a typed error carrying next-step guidance. */
export function mapHttpError({
  status,
  headers,
  bodyText,
  method,
  path,
  nowMs,
  context = {},
}: MapHttpErrorOptions): CursorApiError {
  const body = parseErrorBody(bodyText);
  const code = body.code;
  const apiMessage = body.message;
  const base = {
    status,
    code,
    requestId: readRequestId(headers),
    details: body.raw,
    helpUrl: body.helpUrl,
  };
  const fallback = `Cursor API returned HTTP ${status} for ${method} ${path}.`;
  const message = apiMessage ?? fallback;

  if (status === 401 || (status === 403 && (code === 'unauthorized' || code === 'api_key_not_found'))) {
    return new AuthError({
      ...base,
      message,
      guidance:
        'Create or rotate a key at https://cursor.com/dashboard/api, set CURSOR_API_KEY in the MCP server config, and restart the client. `cursor-cloud-agents-mcp doctor` verifies a key without touching agents.',
    });
  }

  if (status === 403 && code === 'feature_unavailable') {
    return new FeatureUnavailableError({
      ...base,
      message,
      guidance:
        'This endpoint is early-access and is not enabled for the account (usage reporting is the usual case). Do not retry — continue without it.',
    });
  }

  if (status === 403) {
    return new ForbiddenError({
      ...base,
      message,
      guidance:
        'The key authenticated but is not allowed to do this (plan or role restriction). Use a key with the right scope, or ask a team admin. Retrying will not help.',
    });
  }

  if (status === 404) {
    return new NotFoundError({
      ...base,
      message,
      guidance: `Confirm the id for ${describe(context)} with list_agents or list_runs. Agent ids look like \`bc-<uuid>\` and run ids like \`run-<uuid>\`.`,
    });
  }

  // Cursor documentation has described agent_id_conflict as both 400 and 409.
  if (status === 409 || code === 'agent_id_conflict') {
    if (code === 'agent_busy') {
      const agentId = context.agentId;
      const activeRunId = readActiveRunId(body.raw);
      return new AgentBusyError({
        ...base,
        message,
        agentId,
        activeRunId,
        guidance: `Agent ${agentId ?? '(unknown)'} already has an active run${
          activeRunId === undefined ? '' : ` (${activeRunId})`
        }. Call get_run / wait_for_run to wait for it, or cancel_run to stop it, then retry send_followup.`,
      });
    }
    if (code === 'agent_archived') {
      return new AgentArchivedError({
        ...base,
        message,
        agentId: context.agentId,
        guidance: `Call unarchive_agent with agentId=${context.agentId ?? '<agentId>'} first, then retry this call.`,
      });
    }
    if (code === 'agent_id_conflict') {
      return new AgentIdConflictError({
        ...base,
        message,
        agentId: context.agentId,
        guidance: 'An agent with that agentId already exists. Use get_agent to read it.',
      });
    }
    if (code === 'run_not_cancellable') {
      return new RunNotCancellableError({
        ...base,
        message,
        guidance:
          'The run is already terminal (FINISHED/ERROR/CANCELLED/EXPIRED) or was never active. Call get_run to read its final status; do not retry the cancel.',
      });
    }
    return new ConflictError({
      ...base,
      message,
      guidance: `The request conflicts with the current state of ${describe(context)}. Call get_agent / get_run to read the current state before retrying.`,
    });
  }

  if (status === 410) {
    return new StreamExpiredError({
      ...base,
      message,
      guidance:
        'The server-side stream retention window has passed. Do not retry the stream — call get_run for the final status, result text and PR URLs.',
    });
  }

  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'), nowMs);
    const seconds = retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000);
    return new RateLimitedError({
      ...base,
      message,
      retryAfterMs,
      details: {
        body: body.raw,
        limit: headers.get('x-ratelimit-limit') ?? undefined,
        remaining: headers.get('x-ratelimit-remaining') ?? undefined,
        reset: headers.get('x-ratelimit-reset') ?? undefined,
      },
      guidance:
        method === 'GET'
          ? `Rate limited by Cursor. Retry after ${seconds ?? 30}s. GET retries occur only when the required delay fits within the 30-second retry window.`
          : `Rate limited by Cursor. This was a write request, so it was NOT retried automatically (a blind retry could launch a duplicate agent or run). Wait ${seconds ?? 30}s and decide explicitly whether to resend.`,
    });
  }

  if (status >= 500) {
    return new ServerError({
      ...base,
      message,
      guidance:
        method === 'GET'
          ? 'Cursor returned a server error. GET requests are retried up to 3 attempts when the retry fits the request deadline.'
          : 'Cursor returned a server error. Write requests are never retried automatically — the agent or run MAY still have been created. Call list_agents / list_runs to check before resending.',
    });
  }

  if (status === 400 && code === 'invalid_last_event_id') {
    return new InvalidEventCursorError({
      ...base,
      message,
      guidance:
        'The afterEventId cursor does not belong to this run. Call get_run_events again without afterEventId (replays the retained window), or call get_run for the current state.',
    });
  }

  if (status === 400 || status === 422) {
    return new BadRequestError({
      ...base,
      message,
      guidance:
        'The message above is verbatim from the Cursor API — fix the tool input accordingly and call again. Common causes: unknown model id (see list_models), a repo URL you do not have access to (see list_repositories), or combining `agentId` with `envVars`.',
    });
  }

  return new CursorApiError({
    ...base,
    message,
    guidance: 'Unexpected status from the Cursor API (public beta). Inspect `details` for the raw body.',
  });
}

function readActiveRunId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !('error' in raw)) return undefined;
  const { error } = raw as { error: unknown };
  if (typeof error !== 'object' || error === null) return undefined;
  for (const key of ['activeRunId', 'runId']) {
    if (key in error) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}
