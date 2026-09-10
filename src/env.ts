import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError, type EnvLike } from './config.js';

const CONFIG_ENV_KEYS = ['CURSOR_API_KEY', 'CURSOR_API_BASE', 'CURSOR_MCP_LOG_LEVEL'] as const;

export interface LoadConfigEnvOptions {
  cwd: string;
  processEnv: EnvLike;
  envFile?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** Loads the three supported config values without mutating process.env. */
export function loadConfigEnv({ cwd, processEnv, envFile }: LoadConfigEnvOptions): EnvLike {
  if (envFile === '') throw new ConfigError('--env-file-path requires a non-empty path.');

  const explicit = envFile !== undefined;
  const filePath = resolve(cwd, envFile ?? '.env');
  let contents: string | undefined;

  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    const code = errorCode(error);
    if (!explicit && code === 'ENOENT') {
      contents = undefined;
    } else if (code === 'ENOENT') {
      throw new ConfigError(`Env file ${JSON.stringify(filePath)} does not exist.`);
    } else {
      throw new ConfigError(
        `Could not read env file ${JSON.stringify(filePath)}${code === undefined ? '' : ` (${code})`}.`,
      );
    }
  }

  let fileEnv: NodeJS.Dict<string> = {};
  if (contents !== undefined) {
    try {
      fileEnv = parseEnv(contents);
    } catch {
      throw new ConfigError(`Could not parse env file ${JSON.stringify(filePath)}.`);
    }
  }

  const merged: EnvLike = {};
  for (const key of CONFIG_ENV_KEYS) {
    if (Object.hasOwn(processEnv, key)) {
      merged[key] = processEnv[key];
    } else if (Object.hasOwn(fileEnv, key)) {
      merged[key] = fileEnv[key];
    }
  }
  return merged;
}
