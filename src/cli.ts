#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CursorClient } from './client/index.js';
import { formatErrorForTool } from './client/errors.js';
import { ConfigError, loadConfig } from './config.js';
import { HARNESSES, isHarness, printConfig } from './install/printConfig.js';
import { createLogger } from './log.js';
import { createServer } from './server.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

const HELP = `${PACKAGE_NAME} ${PACKAGE_VERSION}
MCP server (stdio) for the Cursor Cloud Agents API v1.

Usage:
  ${PACKAGE_NAME}                      Start the MCP server on stdio (default).
  ${PACKAGE_NAME} serve                Same as above.
  ${PACKAGE_NAME} print-config <harness> [--name <n>] [--source <spec>] [--key <k>]
                                       Print an install snippet.
                                       harness: ${HARNESSES.join(' | ')}
  ${PACKAGE_NAME} doctor               Check CURSOR_API_KEY against GET /v1/me.
  ${PACKAGE_NAME} --version | --help

Environment:
  CURSOR_API_KEY                 Required for serve/doctor. From https://cursor.com/dashboard/api
  CURSOR_API_BASE                Default https://api.cursor.com
  CURSOR_MCP_LOG_LEVEL           silent|error|warn|info|debug (default warn; stderr only)
`;

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function buildClient(): CursorClient {
  const config = loadConfig(process.env);
  return new CursorClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    logger: createLogger({ level: config.logLevel }),
  });
}

async function serve(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.logLevel });
  const client = new CursorClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    logger,
  });
  const server = createServer({ client, logger });
  const transport = new StdioServerTransport();

  // A stray rejection must never take the transport down mid-conversation.
  // Tool handlers are wrapped, but the SDK, the transport and Node's fetch can
  // all reject asynchronously; log to stderr (never stdout) and keep serving.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled promise rejection (ignored)', reason);
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception (ignored)', error);
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info(`received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);
  logger.info(`${PACKAGE_NAME} ${PACKAGE_VERSION} ready on stdio`, { baseUrl: config.baseUrl });
}

/** Waits for the bytes to reach the pipe before we allow the process to exit. */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => void process.stdout.write(text, () => resolve()));
}

async function doctor(): Promise<void> {
  const client = buildClient();
  const me = await client.me();
  // `doctor` is a CLI command, not the MCP server, so stdout is safe here.
  await writeStdout(`${JSON.stringify({ ok: true, ...me }, null, 2)}\n`);
  // Node's fetch keeps the connection pooled, which would keep the event loop
  // alive forever. The work is done, so leave deliberately.
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  if (command === 'print-config') {
    const harness = argv[1];
    if (harness === undefined || !isHarness(harness)) {
      fail(
        `Unknown harness ${harness === undefined ? '(missing)' : JSON.stringify(harness)}. Expected one of: ${HARNESSES.join(', ')}.`,
      );
    }
    process.stdout.write(
      `${printConfig({
        harness,
        name: readFlag(argv, '--name'),
        source: readFlag(argv, '--source'),
        apiKey: readFlag(argv, '--key'),
      })}\n`,
    );
    return;
  }

  if (command === 'doctor') {
    await doctor();
    return;
  }

  if (command === undefined || command === 'serve') {
    await serve();
    return;
  }

  fail(`Unknown command ${JSON.stringify(command)}.\n\n${HELP}`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) fail(error.message);
  fail(formatErrorForTool(error));
});
