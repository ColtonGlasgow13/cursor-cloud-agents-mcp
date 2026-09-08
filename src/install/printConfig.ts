/** Ready-to-paste MCP registration snippets, one per harness. */

export const HARNESSES = ['claude-code', 'cursor', 'codex', 'windsurf', 'vscode', 'json'] as const;

export type Harness = (typeof HARNESSES)[number];

export const DEFAULT_SERVER_NAME = 'cursor-cloud-agents';
export const DEFAULT_SOURCE = 'github:ColtonGlasgow13/cursor-cloud-agents-mcp';
export const KEY_PLACEHOLDER = '<YOUR_CURSOR_API_KEY>';

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

export interface PrintConfigOptions {
  harness: Harness;
  name?: string;
  source?: string;
  apiKey?: string;
}

interface ServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function serverConfig(source: string, apiKey: string): ServerConfig {
  return { command: 'npx', args: ['-y', source], env: { CURSOR_API_KEY: apiKey } };
}

function genericJson(name: string, config: ServerConfig): string {
  return JSON.stringify({ mcpServers: { [name]: config } }, null, 2);
}

function cursorDeeplink(name: string, config: ServerConfig): string {
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(encoded)}`;
}

/** Returns the snippet text for a harness. Never needs CURSOR_API_KEY to be set. */
export function printConfig({
  harness,
  name = DEFAULT_SERVER_NAME,
  source = DEFAULT_SOURCE,
  apiKey = KEY_PLACEHOLDER,
}: PrintConfigOptions): string {
  const config = serverConfig(source, apiKey);

  switch (harness) {
    case 'claude-code':
      return [
        '# Claude Code — run this once (add --scope user to enable it in every project):',
        `claude mcp add ${name} --env CURSOR_API_KEY=${apiKey} -- npx -y ${source}`,
        '# For slow launches, set this server\'s .mcp.json timeout to 180000 ms',
        '# or start Claude Code with MCP_TOOL_TIMEOUT=180000.',
        '',
        '# Verify:',
        'claude mcp list',
      ].join('\n');

    case 'cursor':
      return [
        '# Cursor — add to ~/.cursor/mcp.json (global) or .cursor/mcp.json (this project):',
        genericJson(name, config),
        '',
        '# Or open this install deeplink:',
        cursorDeeplink(name, config),
      ].join('\n');

    case 'codex':
      return [
        '# Codex CLI — run this once:',
        `codex mcp add ${name} --env CURSOR_API_KEY=${apiKey} -- npx -y ${source}`,
        '# Then add tool_timeout_sec = 180 to this server in ~/.codex/config.toml.',
        '',
        '# Equivalent ~/.codex/config.toml entry (note: mcp_servers, snake_case):',
        `[mcp_servers.${name}]`,
        'command = "npx"',
        `args = ["-y", "${source}"]`,
        'tool_timeout_sec = 180',
        '',
        `[mcp_servers.${name}.env]`,
        `CURSOR_API_KEY = "${apiKey}"`,
      ].join('\n');

    case 'windsurf':
      return [
        '# Windsurf — add to your Windsurf mcp_config.json (path varies by version;',
        '# it is under ~/.codeium/ — check your install rather than trusting a doc mirror).',
        genericJson(name, config),
      ].join('\n');

    case 'vscode':
      return [
        '# VS Code — add this to your MCP configuration.',
        '# The exact file location and wrapper key differ between VS Code versions and',
        '# extensions, so paste the server entry into whatever MCP config your setup uses.',
        genericJson(name, config),
      ].join('\n');

    case 'json':
      return genericJson(name, config);
  }
}
