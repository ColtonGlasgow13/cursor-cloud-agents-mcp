import { describe, expect, it } from 'vitest';
import { HARNESSES, isHarness, printConfig } from '../../src/install/printConfig.js';

describe('print-config', () => {
  it('emits a claude mcp add command with the -- separator', () => {
    const out = printConfig({ harness: 'claude-code' });
    expect(out).toContain(
      "claude mcp add cursor-cloud-agents --env 'CURSOR_API_KEY=<YOUR_CURSOR_API_KEY>' -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp",
    );
    expect(out).toContain('Cursor user API key or service account API key');
    expect(out).toContain('MCP_TOOL_TIMEOUT=180000');
  });

  it('quotes custom shell arguments when they contain shell syntax', () => {
    const out = printConfig({
      harness: 'claude-code',
      name: 'my server',
      source: 'github:example/custom agent',
    });
    expect(out).toContain(
      "claude mcp add 'my server' --env 'CURSOR_API_KEY=<YOUR_CURSOR_API_KEY>' -- npx -y 'github:example/custom agent'",
    );
  });

  it('emits valid Cursor JSON plus a decodable deeplink with the same stdio config', () => {
    const out = printConfig({
      harness: 'cursor',
      name: 'custom-agent',
      source: 'github:example/custom-agent',
      apiKey: 'crsr_example',
    });
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        'custom-agent': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'github:example/custom-agent'],
          env: { CURSOR_API_KEY: 'crsr_example' },
        },
      },
    });

    const deeplink = out.split('\n').find((line) => line.startsWith('cursor://'));
    expect(deeplink).toBeDefined();
    const url = new URL(deeplink ?? '');
    expect(url.searchParams.get('name')).toBe('custom-agent');
    const config = url.searchParams.get('config') ?? '';
    expect(JSON.parse(Buffer.from(config, 'base64').toString('utf8'))).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'github:example/custom-agent'],
      env: { CURSOR_API_KEY: 'crsr_example' },
    });
  });

  it('emits VS Code JSON with its documented wrapper and configuration locations', () => {
    const out = printConfig({
      harness: 'vscode',
      name: 'custom-agent',
      source: 'github:example/custom-agent',
      apiKey: 'crsr_example',
    });
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({
      servers: {
        'custom-agent': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'github:example/custom-agent'],
          env: { CURSOR_API_KEY: 'crsr_example' },
        },
      },
    });
    expect(out).toContain('.vscode/mcp.json');
    expect(out).toContain('MCP: Open User Configuration');
    expect(out).not.toContain('mcpServers');
  });

  it('emits snake_case TOML for Codex', () => {
    const out = printConfig({ harness: 'codex', name: 'cursor-agents' });
    expect(out).toContain('codex mcp add cursor-agents');
    expect(out).toContain("--env 'CURSOR_API_KEY=<YOUR_CURSOR_API_KEY>'");
    expect(out).toContain('[mcp_servers.cursor-agents]');
    expect(out).toContain('tool_timeout_sec = 180');
    expect(out).toContain('Alternative to the CLI');
    expect(out).not.toContain('mcpServers.cursor-agents');
  });

  it('uses the documented Windsurf configuration path', () => {
    const out = printConfig({ harness: 'windsurf' });
    expect(out).toContain('~/.codeium/windsurf/mcp_config.json');
  });

  it('keeps generic JSON compatible with mcpServers', () => {
    expect(JSON.parse(printConfig({ harness: 'json', apiKey: 'crsr_example' }))).toEqual({
      mcpServers: {
        'cursor-cloud-agents': {
          command: 'npx',
          args: ['-y', 'github:ColtonGlasgow13/cursor-cloud-agents-mcp'],
          env: { CURSOR_API_KEY: 'crsr_example' },
        },
      },
    });
  });

  it('honours custom name and source for every harness', () => {
    for (const harness of HARNESSES) {
      const out = printConfig({ harness, name: 'my-server', source: 'git+ssh://git@github.com/o/r.git' });
      expect(out, harness).toContain('git+ssh://git@github.com/o/r.git');
      expect(out, harness).toContain('my-server');
    }
  });

  it('validates harness names', () => {
    expect(isHarness('cursor')).toBe(true);
    expect(isHarness('emacs')).toBe(false);
  });
});
