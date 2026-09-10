#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CursorClient } from './client/index.js';
import { formatErrorForTool } from './client/errors.js';
import { ConfigError, loadConfig, type EnvLike } from './config.js';
import { loadConfigEnv } from './env.js';
import { HARNESSES, isHarness, printConfig } from './install/printConfig.js';
import { createLogger } from './log.js';
import { createServer } from './server.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

const HELP = `${PACKAGE_NAME} ${PACKAGE_VERSION}
MCP server (stdio) for the Cursor Cloud Agents API v1.

Usage:
  ${PACKAGE_NAME} [--env-file-path <path>]
                                       Start the MCP server on stdio (default).
  ${PACKAGE_NAME} serve [--env-file-path <path>]
                                       Same as above.
  ${PACKAGE_NAME} print-config <harness> [--name <n>] [--source <spec>]
                                       [--env-file-path <path> | --key <k>]
                                       Print an install snippet.
                                       harness: ${HARNESSES.join(' | ')}
  ${PACKAGE_NAME} doctor [--env-file-path <path>]
                                       Check CURSOR_API_KEY against GET /v1/me.
  ${PACKAGE_NAME} --version | --help

Environment:
  .env                           Loaded from the current directory for serve/doctor by default.
  --env-file-path <path>         Use this file instead of .env (relative to the current directory).
  Process environment values     Take precedence over file values, including empty values.
  CURSOR_API_KEY                 Required for serve/doctor. From https://cursor.com/dashboard/api
  CURSOR_API_BASE                Default https://api.cursor.com
  CURSOR_MCP_LOG_LEVEL           silent|error|warn|info|debug (default warn; stderr only)
`;

interface CliArgs {
  positionals: string[];
  options: Set<string>;
  envFile?: string;
  name?: string;
  source?: string;
  key?: string;
  help: boolean;
  version: boolean;
}

function parseRawArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      'env-file-path': { type: 'string' },
      name: { type: 'string' },
      source: { type: 'string' },
      key: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

function parseCliArgs(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof parseRawArgs>;
  try {
    parsed = parseRawArgs(argv);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'invalid arguments';
    throw new ConfigError(`Invalid arguments: ${detail}`);
  }

  const options = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (options.has(token.name)) {
      throw new ConfigError(`Option --${token.name} may only be specified once.`);
    }
    options.add(token.name);
  }

  const nonEmptyOptions = ['env-file-path', 'name', 'source', 'key'] as const;
  for (const option of nonEmptyOptions) {
    if (options.has(option) && parsed.values[option] === '') {
      throw new ConfigError(`Option --${option} requires a non-empty value.`);
    }
  }

  return {
    positionals: parsed.positionals,
    options,
    envFile: parsed.values['env-file-path'],
    name: parsed.values['name'],
    source: parsed.values['source'],
    key: parsed.values['key'],
    help: parsed.values['help'] ?? false,
    version: parsed.values['version'] ?? false,
  };
}

function rejectOptions(args: CliArgs, names: string[], command: string): void {
  for (const name of names) {
    if (args.options.has(name)) {
      throw new ConfigError(`Option --${name} is not valid with ${command}.`);
    }
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function buildClient(env: EnvLike): CursorClient {
  const config = loadConfig(env);
  return new CursorClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    logger: createLogger({ level: config.logLevel }),
  });
}

async function serve(env: EnvLike): Promise<void> {
  const config = loadConfig(env);
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

async function doctor(env: EnvLike): Promise<void> {
  const client = buildClient(env);
  const me = await client.me();
  // `doctor` is a CLI command, not the MCP server, so stdout is safe here.
  await writeStdout(`${JSON.stringify({ ok: true, ...me }, null, 2)}\n`);
  // Node's fetch keeps the connection pooled, which would keep the event loop
  // alive forever. The work is done, so leave deliberately.
  process.exit(0);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args.positionals[0];

  if (args.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  if (command === 'print-config') {
    if (args.positionals.length > 2) {
      throw new ConfigError('print-config accepts exactly one harness name.');
    }
    if (args.key !== undefined && args.envFile !== undefined) {
      throw new ConfigError('Options --key and --env-file-path cannot be used together.');
    }
    const harness = args.positionals[1];
    if (harness === undefined || !isHarness(harness)) {
      throw new ConfigError(
        `Unknown harness ${harness === undefined ? '(missing)' : JSON.stringify(harness)}. Expected one of: ${HARNESSES.join(', ')}.`,
      );
    }
    process.stdout.write(
      `${printConfig({
        harness,
        name: args.name,
        source: args.source,
        apiKey: args.key,
        envFile: args.envFile,
      })}\n`,
    );
    return;
  }

  if (command !== undefined && command !== 'serve' && command !== 'doctor') {
    throw new ConfigError(`Unknown command ${JSON.stringify(command)}.\n\n${HELP}`);
  }

  const expectedPositionals = command === undefined ? 0 : 1;
  if (args.positionals.length !== expectedPositionals) {
    throw new ConfigError(`${command ?? 'serve'} does not accept positional arguments.`);
  }
  rejectOptions(args, ['name', 'source', 'key'], command ?? 'serve');

  const env = loadConfigEnv({
    cwd: process.cwd(),
    processEnv: process.env,
    envFile: args.envFile,
  });

  if (command === 'doctor') {
    await doctor(env);
    return;
  }

  await serve(env);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) fail(error.message);
  fail(formatErrorForTool(error));
});
