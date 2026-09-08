/**
 * Error classes for the Cursor Cloud Agents API.
 *
 * Every error carries a `guidance` string written for an LLM caller: it says
 * what to do next, not just what went wrong. The tool layer appends it to the
 * text it returns.
 */

export interface CursorApiErrorInit {
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  details?: unknown;
  guidance?: string;
  helpUrl?: string;
  cause?: unknown;
}

export class CursorApiError extends Error {
  readonly status: number | undefined;
  /** Machine-readable `error.code` from the API body, when present. */
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  /** Raw parsed body (or text) — kept so beta drift stays debuggable. */
  readonly details: unknown;
  readonly guidance: string;
  readonly helpUrl: string | undefined;

  constructor(init: CursorApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
    this.guidance = init.guidance ?? '';
    this.helpUrl = init.helpUrl;
  }
}

/** 401, or 403 with `unauthorized` / `api_key_not_found`. Never echoes the key. */
export class AuthError extends CursorApiError {}

/** 403 `plan_required` / `role_forbidden` / anything else forbidden. */
export class ForbiddenError extends CursorApiError {}

/** 403 `feature_unavailable` — e.g. the early-access usage endpoint. */
export class FeatureUnavailableError extends CursorApiError {}

/** 404 — the message names what was looked up. */
export class NotFoundError extends CursorApiError {}

/** 400 / 422 validation failures. Carries the API's message verbatim. */
export class BadRequestError extends CursorApiError {}

/** 400 `invalid_last_event_id` — the resume cursor does not belong to this run. */
export class InvalidEventCursorError extends BadRequestError {}

/** 409 that is not one of the specific conflict codes below. */
export class ConflictError extends CursorApiError {}

/** 409 `agent_busy` — another run is CREATING/RUNNING on this agent. */
export class AgentBusyError extends ConflictError {
  readonly agentId: string | undefined;
  readonly activeRunId: string | undefined;

  constructor(init: CursorApiErrorInit & { agentId?: string; activeRunId?: string }) {
    super(init);
    this.agentId = init.agentId;
    this.activeRunId = init.activeRunId;
  }
}

/** 409 `agent_archived`. */
export class AgentArchivedError extends ConflictError {
  readonly agentId: string | undefined;

  constructor(init: CursorApiErrorInit & { agentId?: string }) {
    super(init);
    this.agentId = init.agentId;
  }
}

/** 409 `agent_id_conflict` — a client-supplied agentId was already used. */
export class AgentIdConflictError extends ConflictError {
  readonly agentId: string | undefined;

  constructor(init: CursorApiErrorInit & { agentId?: string }) {
    super(init);
    this.agentId = init.agentId;
  }
}

/** 409 `run_not_cancellable` — the run is already terminal or never started. */
export class RunNotCancellableError extends ConflictError {}

/** 410 `stream_expired` — the SSE retention window has passed. */
export class StreamExpiredError extends CursorApiError {}

/** 429 from the Cursor API. */
export class RateLimitedError extends CursorApiError {
  readonly retryAfterMs: number | undefined;

  constructor(init: CursorApiErrorInit & { retryAfterMs?: number }) {
    super(init);
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** 5xx. GETs are retried before this surfaces. */
export class ServerError extends CursorApiError {}

/** fetch() rejected (DNS, ECONNRESET, TLS, ...) — no HTTP response was produced. */
export class NetworkError extends CursorApiError {}

/** The response was not valid JSON. Schema drift in JSON objects is non-fatal. */
export class ResponseValidationError extends CursorApiError {
  /** Flattened zod issues: `path: message`. */
  readonly issues: string[];
  /** The raw body exactly as received, so drift can be diagnosed. */
  readonly rawBody: unknown;

  constructor(init: CursorApiErrorInit & { issues: string[]; rawBody: unknown }) {
    super(init);
    this.issues = init.issues;
    this.rawBody = init.rawBody;
  }
}

/** Cap on how many zod issues reach the model; the rest are counted, not listed. */
export const MAX_REPORTED_ISSUES = 20;
/** Cap on the raw body echoed into a tool error, in characters. */
export const MAX_RAW_BODY_CHARS = 4000;

/** `path: message` lines, capped so a wholesale shape change cannot flood the model. */
function formatIssues(issues: string[]): string {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES);
  const hidden = issues.length - shown.length;
  const suffix = hidden > 0 ? `\n- ...and ${hidden} more issue(s)` : '';
  return `Schema issues:\n- ${shown.join('\n- ')}${suffix}`;
}

/**
 * The raw body, JSON-stringified and truncated. This is the whole point of
 * ResponseValidationError — its guidance tells the model the body is here.
 */
function formatRawBody(rawBody: unknown): string | undefined {
  if (rawBody === undefined) return undefined;
  let text: string;
  if (typeof rawBody === 'string') {
    text = rawBody;
  } else {
    try {
      text = JSON.stringify(rawBody) ?? String(rawBody);
    } catch {
      text = String(rawBody);
    }
  }
  if (text === '') return undefined;
  const truncated =
    text.length > MAX_RAW_BODY_CHARS
      ? `${text.slice(0, MAX_RAW_BODY_CHARS)}...[truncated ${text.length - MAX_RAW_BODY_CHARS} chars]`
      : text;
  return `Raw body:\n${truncated}`;
}

/** Formats an error for a tool response: class name, message, help URL, guidance. */
export function formatErrorForTool(error: unknown): string {
  if (error instanceof CursorApiError) {
    const parts = [`${error.name}: ${error.message}`];
    if (error.requestId !== undefined) parts.push(`requestId: ${error.requestId}`);
    if (error.helpUrl !== undefined) parts.push(`See: ${error.helpUrl}`);
    if (error instanceof ResponseValidationError) {
      if (error.issues.length > 0) parts.push(formatIssues(error.issues));
      const rawBody = formatRawBody(error.rawBody);
      if (rawBody !== undefined) parts.push(rawBody);
    }
    if (error.guidance !== '') parts.push(error.guidance);
    return parts.join('\n\n');
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Error: ${String(error)}`;
}
