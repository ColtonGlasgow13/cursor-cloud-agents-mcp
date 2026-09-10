import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx');
const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-mcp-cli-'));
  tempDirs.push(directory);
  return directory;
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', TSX_IMPORT, CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CLI env file handling', () => {
  it('does not read env files for help or print-config', () => {
    const cwd = makeTempDir();
    const help = runCli(['--env-file-path', 'missing.env', '--help'], cwd);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage:');
    expect(help.stderr).toBe('');

    const printed = runCli(['--env-file-path=missing.env', 'print-config', 'json'], cwd);
    expect(printed.status).toBe(0);
    expect(printed.stderr).toBe('');
    expect(JSON.parse(printed.stdout)).toEqual({
      mcpServers: {
        'cursor-cloud-agents': {
          command: 'npx',
          args: [
            '-y',
            'github:ColtonGlasgow13/cursor-cloud-agents-mcp',
            '--env-file-path',
            'missing.env',
          ],
        },
      },
    });
  });

  it('accepts the explicit flag after the command and resolves it from cwd', () => {
    const cwd = makeTempDir();
    const result = runCli(['doctor', '--env-file-path', 'missing.env'], cwd);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(JSON.stringify(join(cwd, 'missing.env')));
    expect(result.stderr).toContain('does not exist');
  });

  it('loads the default cwd .env without printing its secret', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, '.env'),
      'CURSOR_API_KEY=crsr_default-file-secret\nCURSOR_MCP_LOG_LEVEL=loud\n',
    );

    const result = runCli(['doctor'], cwd);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CURSOR_MCP_LOG_LEVEL');
    expect(result.stderr).not.toContain('crsr_default-file-secret');
  });

  it('continues to support direct process environment configuration', () => {
    const cwd = makeTempDir();
    const result = runCli(['doctor'], cwd, {
      CURSOR_API_KEY: 'crsr_direct-secret',
      CURSOR_MCP_LOG_LEVEL: 'loud',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CURSOR_MCP_LOG_LEVEL');
    expect(result.stderr).not.toContain('crsr_direct-secret');
  });

  it('lets an empty process value override a key from .env', () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, '.env'), 'CURSOR_API_KEY=crsr_file-secret\n');

    const result = runCli(['doctor'], cwd, { CURSOR_API_KEY: '' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CURSOR_API_KEY is not set');
    expect(result.stderr).not.toContain('crsr_file-secret');
  });

  it('rejects malformed, duplicate, and conflicting flags without echoing keys', () => {
    const cwd = makeTempDir();

    const missing = runCli(['doctor', '--env-file-path'], cwd);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('Invalid arguments');

    const duplicate = runCli(
      ['--env-file-path=first.env', 'doctor', '--env-file-path', 'second.env'],
      cwd,
    );
    expect(duplicate.status).toBe(1);
    expect(duplicate.stdout).toBe('');
    expect(duplicate.stderr).toContain('may only be specified once');

    const duplicateSecret = 'crsr_duplicate-secret';
    const duplicateKey = runCli(
      ['print-config', 'json', `--key=${duplicateSecret}`, '--key', 'second-secret'],
      cwd,
    );
    expect(duplicateKey.status).toBe(1);
    expect(duplicateKey.stdout).toBe('');
    expect(duplicateKey.stderr).toContain('may only be specified once');
    expect(duplicateKey.stderr).not.toContain(duplicateSecret);

    const secret = 'crsr_conflicting-secret';
    const conflicting = runCli(
      ['print-config', 'json', `--key=${secret}`, '--env-file-path', 'config.env'],
      cwd,
    );
    expect(conflicting.status).toBe(1);
    expect(conflicting.stdout).toBe('');
    expect(conflicting.stderr).toContain('cannot be used together');
    expect(conflicting.stderr).not.toContain(secret);
  });
});
