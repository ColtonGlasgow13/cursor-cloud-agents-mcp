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

interface StdioServerConfig extends ServerConfig {
  type: 'stdio';
}

function serverConfig(source: string, apiKey: string): ServerConfig {
  return { command: 'npx', args: ['-y', source], env: { CURSOR_API_KEY: apiKey } };
}

function stdioServerConfig(source: string, apiKey: string): StdioServerConfig {
  return { type: 'stdio', ...serverConfig(source, apiKey) };
}

function genericJson(name: string, config: ServerConfig): string {
  return JSON.stringify({ mcpServers: { [name]: config } }, null, 2);
}

function cursorJson(name: string, config: StdioServerConfig): string {
  return JSON.stringify({ mcpServers: { [name]: config } }, null, 2);
}

function vscodeJson(name: string, config: StdioServerConfig): string {
  return JSON.stringify({ servers: { [name]: config } }, null, 2);
}

function cursorDeeplink(name: string, config: StdioServerConfig): string {
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(encoded)}`;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function keyGuidance(apiKey: string): string[] {
  if (apiKey !== KEY_PLACEHOLDER) return [];
  return [
    `# Replace ${KEY_PLACEHOLDER} before registering or enabling this server.`,
    '# Use a Cursor user API key or service account API key, passed raw as CURSOR_API_KEY.',
  ];
}

/** Returns the snippet text for a harness. Never needs CURSOR_API_KEY to be set. */
export function printConfig({
  harness,
  name = DEFAULT_SERVER_NAME,
  source = DEFAULT_SOURCE,
  apiKey = KEY_PLACEHOLDER,
}: PrintConfigOptions): string {
  const config = serverConfig(source, apiKey);
  const stdioConfig = stdioServerConfig(source, apiKey);
  const guidance = keyGuidance(apiKey);

  switch (harness) {
    case 'claude-code':
      return [
        '# Claude Code — run this once (add --scope user to enable it in every project):',
        ...guidance,
        `claude mcp add ${shellArg(name)} --env ${shellArg(`CURSOR_API_KEY=${apiKey}`)} -- npx -y ${shellArg(source)}`,
        '# For slow launches, set this server\'s .mcp.json timeout to 180000 ms',
        '# or start Claude Code with MCP_TOOL_TIMEOUT=180000.',
        '',
        '# Verify:',
        'claude mcp list',
      ].join('\n');

    case 'cursor':
      return [
        '# Cursor JSON configuration:',
        '# Add to ~/.cursor/mcp.json (global) or .cursor/mcp.json (this project).',
        ...guidance,
        cursorJson(name, stdioConfig),
        '',
        '# Cursor install deeplink (alternative to the JSON configuration):',
        cursorDeeplink(name, stdioConfig),
      ].join('\n');

    case 'codex':
      return [
        '# Codex CLI — run this once:',
        ...guidance,
        `codex mcp add ${shellArg(name)} --env ${shellArg(`CURSOR_API_KEY=${apiKey}`)} -- npx -y ${shellArg(source)}`,
        `# Then add tool_timeout_sec = 180 to the existing [mcp_servers.${name}] table`,
        '# in ~/.codex/config.toml.',
        '',
        '# Alternative to the CLI: add this complete ~/.codex/config.toml entry',
        '# (note: mcp_servers, snake_case):',
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
        '# Windsurf — add this JSON to ~/.codeium/windsurf/mcp_config.json:',
        ...guidance,
        genericJson(name, config),
      ].join('\n');

    case 'vscode':
      return [
        '# VS Code — add this JSON to .vscode/mcp.json for this workspace.',
        '# For user-wide configuration, run "MCP: Open User Configuration"',
        '# from the Command Palette.',
        ...guidance,
        vscodeJson(name, stdioConfig),
      ].join('\n');

    case 'json':
      return genericJson(name, config);
  }
}
