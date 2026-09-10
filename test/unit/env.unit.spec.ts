import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type EnvLike } from '../../src/config.js';
import { loadConfigEnv } from '../../src/env.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-mcp-env-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadConfigEnv', () => {
  it('loads only supported values from the default cwd .env without mutating the input', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, '.env'),
      [
        'CURSOR_API_KEY=file-key',
        'CURSOR_API_BASE=https://file.example',
        'CURSOR_MCP_LOG_LEVEL=debug',
        'UNRELATED_SECRET=do-not-load',
      ].join('\n'),
    );
    const processEnv: EnvLike = { CURSOR_API_BASE: '', UNRELATED_PROCESS_VALUE: 'ignore-me' };
    const original = { ...processEnv };

    expect(loadConfigEnv({ cwd, processEnv })).toEqual({
      CURSOR_API_KEY: 'file-key',
      CURSOR_API_BASE: '',
      CURSOR_MCP_LOG_LEVEL: 'debug',
    });
    expect(processEnv).toEqual(original);
  });

  it('treats an empty process value as an explicit override', () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.env'), 'CURSOR_API_KEY=file-key\n');

    const env = loadConfigEnv({ cwd, processEnv: { CURSOR_API_KEY: '' } });
    expect(env).toEqual({ CURSOR_API_KEY: '' });
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('uses an explicit relative file instead of the default .env', () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.env'), 'CURSOR_API_KEY=default-key\n');
    writeFileSync(join(cwd, 'selected.env'), 'CURSOR_API_KEY=selected-key\n');

    expect(loadConfigEnv({ cwd, processEnv: {}, envFile: 'selected.env' })).toEqual({
      CURSOR_API_KEY: 'selected-key',
    });
  });

  it('does not fall back to the default .env when the explicit file lacks a key', () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.env'), 'CURSOR_API_KEY=default-key\n');
    writeFileSync(join(cwd, 'selected.env'), 'CURSOR_MCP_LOG_LEVEL=debug\n');

    const env = loadConfigEnv({ cwd, processEnv: {}, envFile: 'selected.env' });
    expect(env).toEqual({ CURSOR_MCP_LOG_LEVEL: 'debug' });
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('uses Node env syntax without shell expansion', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, '.env'),
      ['CURSOR_API_KEY="quoted # value"', 'CURSOR_API_BASE=$UNEXPANDED/path'].join('\n'),
    );

    expect(loadConfigEnv({ cwd, processEnv: {} })).toEqual({
      CURSOR_API_KEY: 'quoted # value',
      CURSOR_API_BASE: '$UNEXPANDED/path',
    });
  });

  it('allows the optional default .env to be absent', () => {
    const cwd = makeTempDir();
    expect(loadConfigEnv({ cwd, processEnv: { CURSOR_API_KEY: 'direct-key' } })).toEqual({
      CURSOR_API_KEY: 'direct-key',
    });
  });

  it('fails clearly when an explicit file is missing without exposing values', () => {
    const cwd = makeTempDir();
    const missing = join(cwd, 'missing.env');

    expect(() =>
      loadConfigEnv({
        cwd,
        processEnv: { CURSOR_API_KEY: 'crsr_do-not-print' },
        envFile: 'missing.env',
      }),
    ).toThrow(new ConfigError(`Env file ${JSON.stringify(missing)} does not exist.`));
  });

  it('fails clearly when an explicit file is unreadable', () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, 'directory.env'));

    expect(() => loadConfigEnv({ cwd, processEnv: {}, envFile: 'directory.env' })).toThrow(
      /Could not read env file .* \(EISDIR\)\./,
    );
  });
});
