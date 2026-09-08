import { describe, expect, it } from 'vitest';
import { HARNESSES, isHarness, printConfig } from '../../src/install/printConfig.js';

describe('print-config', () => {
  it('emits a claude mcp add command with the -- separator', () => {
    const out = printConfig({ harness: 'claude-code' });
    expect(out).toContain(
      'claude mcp add cursor-cloud-agents --env CURSOR_API_KEY=<YOUR_CURSOR_API_KEY> -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp',
    );
    expect(out).toContain('MCP_TOOL_TIMEOUT=180000');
  });

  it('emits valid JSON plus a decodable Cursor deeplink', () => {
    const out = printConfig({ harness: 'cursor', apiKey: 'crsr_example' });
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        'cursor-cloud-agents': {
          command: 'npx',
          args: ['-y', 'github:ColtonGlasgow13/cursor-cloud-agents-mcp'],
          env: { CURSOR_API_KEY: 'crsr_example' },
        },
      },
    });

    const deeplink = out.split('\n').find((line) => line.startsWith('cursor://'));
    expect(deeplink).toBeDefined();
    const config = new URL(deeplink ?? '').searchParams.get('config') ?? '';
    expect(JSON.parse(Buffer.from(config, 'base64').toString('utf8'))).toMatchObject({
      command: 'npx',
    });
  });

  it('emits snake_case TOML for Codex', () => {
    const out = printConfig({ harness: 'codex', name: 'cursor-agents' });
    expect(out).toContain('codex mcp add cursor-agents');
    expect(out).toContain('[mcp_servers.cursor-agents]');
    expect(out).toContain('tool_timeout_sec = 180');
    expect(out).not.toContain('mcpServers.cursor-agents');
  });

  it('does not assert a Windsurf config path it cannot verify', () => {
    const out = printConfig({ harness: 'windsurf' });
    expect(out).toContain('path varies by version');
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
