import { isLogLevel, type LogLevel } from './log.js';

export const DEFAULT_BASE_URL = 'https://api.cursor.com';

export interface Config {
  apiKey: string;
  baseUrl: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type EnvLike = Record<string, string | undefined>;

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
      'CURSOR_API_KEY is not set. Set it directly, add it to .env, or pass --env-file-path PATH. Create a key at https://cursor.com/dashboard/api. Run `cursor-cloud-agents-mcp print-config <harness>` for a ready-to-paste snippet.',
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
  };
}
