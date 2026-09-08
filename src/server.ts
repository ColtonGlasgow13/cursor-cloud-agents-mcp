import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CursorClient } from './client/index.js';
import type { Logger } from './log.js';
import { registerAllTools } from './tools/index.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client: CursorClient;
  name?: string;
  version?: string;
  /** Stderr logger available to tool registrations. */
  logger?: Logger;
}

/**
 * Builds the MCP server with every Cursor tool registered.
 * Exported so tests can drive it over an in-memory transport.
 */
export function createServer({
  client,
  name = PACKAGE_NAME,
  version = PACKAGE_VERSION,
  logger,
}: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name, version },
    {
      instructions:
        'Tools for the Cursor Cloud Agents REST API v1. Basic endpoint tools return Cursor response objects unchanged. GET requests may retry transient failures up to 3 attempts; writes are never retried. launch_agent awaits agent creation and may require an MCP tool timeout of at least 180 seconds. get_run_events returns one bounded batch with nextEventId for resuming; wait_for_run is an optional 5-second polling helper.',
    },
  );
  registerAllTools({ server, client, logger });
  return server;
}

export { TOOL_NAMES } from './tools/index.js';
export type { ToolName } from './tools/index.js';
