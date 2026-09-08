import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CursorClient } from '../client/index.js';
import { CursorApiError, formatErrorForTool } from '../client/errors.js';
import { TERMINAL_RUN_STATUSES } from '../client/schemas.js';
import type { Logger } from '../log.js';

/** Every tool returns a JSON object; the SDK sends it as text + structuredContent. */
export type ToolData = Record<string, unknown>;

export interface RegisterToolArgs {
  server: McpServer;
  client: CursorClient;
  logger?: Logger;
}

export function toolSuccess(data: ToolData): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function toolFailure(error: unknown): CallToolResult {
  const structuredContent =
    error instanceof CursorApiError
      ? {
          error: {
            name: error.name,
            message: error.message,
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.code === undefined ? {} : { code: error.code }),
            ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
            ...('retryAfterMs' in error && typeof error.retryAfterMs === 'number'
              ? { retryAfterMs: error.retryAfterMs }
              : {}),
            ...(error.details === undefined ? {} : { details: error.details }),
            ...(error.helpUrl === undefined ? {} : { helpUrl: error.helpUrl }),
          },
        }
      : {
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        };
  return {
    isError: true,
    content: [{ type: 'text', text: formatErrorForTool(error) }],
    structuredContent,
  };
}

/**
 * Converts any thrown error into an `isError` tool result. A transport-level
 * throw would look like a broken server to the client; an error result is
 * something the model can read and act on.
 */
export async function withErrorHandling(run: () => Promise<ToolData>): Promise<CallToolResult> {
  try {
    return toolSuccess(await run());
  } catch (error) {
    return toolFailure(error);
  }
}

const TERMINAL = new Set<string>(TERMINAL_RUN_STATUSES);
/** FINISHED | ERROR | CANCELLED | EXPIRED. Unknown statuses are non-terminal. */
export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL.has(status);
}

/** Drops undefined keys so request bodies never carry `"repos": null`. */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
