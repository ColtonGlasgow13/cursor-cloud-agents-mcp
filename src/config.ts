import { isLogLevel, type LogLevel } from './log.js';

export const DEFAULT_BASE_URL = 'https://api.cursor.com';
export const DEFAULT_RATE_LIMIT_PER_MIN = 20;

export interface Config {
  apiKey: string;
  baseUrl: string;
  logLevel: LogLevel;
  rateLimitPerMin: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type EnvLike = Record<string, string | undefined>;

function parsePositiveInt(raw: string | undefined, fallback: number, varName: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${varName} must be a positive integer (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

/**
 * Reads configuration from the environment.
 *
 * Throws ConfigError when CURSOR_API_KEY is missing — callers that do not need
 * credentials (`print-config`, `--help`, `--version`) must not call this.
 */
export function loadConfig(env: EnvLike): Config {
  const apiKey = env['CURSOR_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new ConfigError(
      'CURSOR_API_KEY is not set. Create a key at https://cursor.com/dashboard/api and pass it to the MCP server (e.g. `claude mcp add cursor-cloud-agents --env CURSOR_API_KEY=... -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp`). Run `cursor-cloud-agents-mcp print-config <harness>` for a ready-to-paste snippet.',
    );
  }

  const rawLevel = env['CURSOR_MCP_LOG_LEVEL']?.trim().toLowerCase() ?? 'warn';
  if (!isLogLevel(rawLevel)) {
    throw new ConfigError(
      `CURSOR_MCP_LOG_LEVEL must be one of silent|error|warn|info|debug (got ${JSON.stringify(rawLevel)}).`,
    );
  }

  const rawBase = env['CURSOR_API_BASE']?.trim();
  const baseUrl = (rawBase === undefined || rawBase === '' ? DEFAULT_BASE_URL : rawBase).replace(
    /\/+$/,
    '',
  );

  return {
    apiKey,
    baseUrl,
    logLevel: rawLevel,
    rateLimitPerMin: parsePositiveInt(
      env['CURSOR_MCP_RATE_LIMIT_PER_MIN'],
      DEFAULT_RATE_LIMIT_PER_MIN,
      'CURSOR_MCP_RATE_LIMIT_PER_MIN',
    ),
  };
}
