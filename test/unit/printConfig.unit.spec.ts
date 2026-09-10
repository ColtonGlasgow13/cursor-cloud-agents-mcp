import { describe, expect, it } from 'vitest';
import {
  ENV_FILE_PLACEHOLDER,
  HARNESSES,
  isHarness,
  printConfig,
} from '../../src/install/printConfig.js';

function jsonFromOutput(out: string): unknown {
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

describe('print-config', () => {
  it('defaults Claude Code to an env file without embedding a key', () => {
    const out = printConfig({ harness: 'claude-code' });
    expect(out).toContain(
      `claude mcp add cursor-cloud-agents -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp --env-file-path '${ENV_FILE_PLACEHOLDER}'`,
    );
    expect(out).toContain('absolute path to your .env file');
    expect(out).not.toContain('--env CURSOR_API_KEY');
    expect(out).toContain('MCP_TOOL_TIMEOUT=180000');
  });

  it('preserves direct API key registration as an explicit alternative', () => {
    const out = printConfig({ harness: 'claude-code', apiKey: 'crsr_example' });
    expect(out).toContain(
      'claude mcp add cursor-cloud-agents --env CURSOR_API_KEY=crsr_example -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp',
    );
    expect(out).not.toContain('--env-file-path');
  });

  it('quotes custom shell arguments when they contain shell syntax', () => {
    const out = printConfig({
      harness: 'claude-code',
      name: 'my server',
      source: 'github:example/custom agent',
      envFile: "/tmp/team's config.env",
    });
    expect(out).toContain(
      "claude mcp add 'my server' -- npx -y 'github:example/custom agent' --env-file-path '/tmp/team'\"'\"'s config.env'",
    );
  });

  it('emits Cursor JSON plus a deeplink with the same env-file stdio config', () => {
    const out = printConfig({
      harness: 'cursor',
      name: 'custom-agent',
      source: 'github:example/custom-agent',
      envFile: '/tmp/cursor.env',
    });
    const expectedConfig = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'github:example/custom-agent', '--env-file-path', '/tmp/cursor.env'],
    };
    expect(jsonFromOutput(out)).toEqual({ mcpServers: { 'custom-agent': expectedConfig } });

    const deeplink = out.split('\n').find((line) => line.startsWith('cursor://'));
    expect(deeplink).toBeDefined();
    const url = new URL(deeplink ?? '');
    expect(url.searchParams.get('name')).toBe('custom-agent');
    const config = url.searchParams.get('config') ?? '';
    expect(JSON.parse(Buffer.from(config, 'base64').toString('utf8'))).toEqual(expectedConfig);
  });

  it('emits direct API keys in Cursor config only when requested', () => {
    const out = printConfig({ harness: 'cursor', apiKey: 'crsr_example' });
    const config = jsonFromOutput(out) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers['cursor-cloud-agents']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'github:ColtonGlasgow13/cursor-cloud-agents-mcp'],
      env: { CURSOR_API_KEY: 'crsr_example' },
    });
  });

  it('emits VS Code JSON with its documented wrapper and configuration locations', () => {
    const out = printConfig({
      harness: 'vscode',
      name: 'custom-agent',
      source: 'github:example/custom-agent',
      envFile: '/tmp/cursor.env',
    });
    expect(jsonFromOutput(out)).toEqual({
      servers: {
        'custom-agent': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'github:example/custom-agent', '--env-file-path', '/tmp/cursor.env'],
        },
      },
    });
    expect(out).toContain('.vscode/mcp.json');
    expect(out).toContain('MCP: Open User Configuration');
    expect(out).not.toContain('mcpServers');
  });

  it('emits quoted snake_case TOML as an alternative to the Codex CLI', () => {
    const out = printConfig({
      harness: 'codex',
      name: 'cursor.agents "team"',
      source: 'github:example/"custom agent"',
      envFile: '/tmp/team "config".env',
    });
    expect(out).toContain('[mcp_servers."cursor.agents \\"team\\""]');
    expect(out).toContain(
      'args = ["-y", "github:example/\\"custom agent\\"", "--env-file-path", "/tmp/team \\"config\\".env"]',
    );
    expect(out).toContain('tool_timeout_sec = 180');
    expect(out).toContain('Alternative to the CLI');
    expect(out).not.toContain('.env]');
  });

  it('emits a Codex env table for the direct key alternative', () => {
    const out = printConfig({ harness: 'codex', name: 'cursor-agents', apiKey: 'crsr_example' });
    expect(out).toContain('codex mcp add cursor-agents --env CURSOR_API_KEY=crsr_example');
    expect(out).toContain('[mcp_servers.cursor-agents.env]');
    expect(out).toContain('CURSOR_API_KEY = "crsr_example"');
  });

  it('uses the documented Windsurf configuration path', () => {
    const out = printConfig({ harness: 'windsurf' });
    expect(out).toContain('~/.codeium/windsurf/mcp_config.json');
  });

  it('keeps generic JSON compatible with mcpServers', () => {
    expect(JSON.parse(printConfig({ harness: 'json', envFile: '/tmp/cursor.env' }))).toEqual({
      mcpServers: {
        'cursor-cloud-agents': {
          command: 'npx',
          args: [
            '-y',
            'github:ColtonGlasgow13/cursor-cloud-agents-mcp',
            '--env-file-path',
            '/tmp/cursor.env',
          ],
        },
      },
    });
  });

  it('honours custom name, source, and env file for every harness', () => {
    for (const harness of HARNESSES) {
      const out = printConfig({
        harness,
        name: 'my-server',
        source: 'git+ssh://git@github.com/o/r.git',
        envFile: '/tmp/my config.env',
      });
      expect(out, harness).toContain('git+ssh://git@github.com/o/r.git');
      expect(out, harness).toContain('my-server');
      expect(out, harness).toContain('/tmp/my config.env');
    }
  });

  it('rejects direct keys combined with env files', () => {
    expect(() =>
      printConfig({ harness: 'json', apiKey: 'crsr_example', envFile: '/tmp/cursor.env' }),
    ).toThrow('apiKey and envFile cannot be used together');
  });

  it('validates harness names', () => {
    expect(isHarness('cursor')).toBe(true);
    expect(isHarness('emacs')).toBe(false);
  });
});
