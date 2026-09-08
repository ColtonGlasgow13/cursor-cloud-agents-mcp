import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CursorClient } from './client/index.js';
import type { Logger } from './log.js';
import { registerAllTools } from './tools/index.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client: CursorClient;
  name?: string;
  version?: string;
  /** Passed to the tools that keep work in flight after returning. */
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
        'Tools for Cursor Cloud Agents. Launch work with launch_agent (omit `repos` for a cheap no-repo agent), then follow it with wait_for_run, or poll get_run_events passing afterEventId=nextEventId each time. Finish with get_run to read `result` and PR URLs. Continue an existing agent with send_followup rather than launching a new one. The API budget is about 20 requests per minute, so sleep a few seconds between polls, and never call list_repositories in a loop (1 request/minute).',
    },
  );
  registerAllTools({ server, client, logger });
  return server;
}

export { TOOL_NAMES } from './tools/index.js';
export type { ToolName } from './tools/index.js';
