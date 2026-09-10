/** Ready-to-paste MCP registration snippets, one per harness. */

export const HARNESSES = ['claude-code', 'cursor', 'codex', 'windsurf', 'vscode', 'json'] as const;

export type Harness = (typeof HARNESSES)[number];

export const DEFAULT_SERVER_NAME = 'cursor-cloud-agents';
export const DEFAULT_SOURCE = 'github:ColtonGlasgow13/cursor-cloud-agents-mcp';
export const KEY_PLACEHOLDER = '<YOUR_CURSOR_API_KEY>';
export const ENV_FILE_PLACEHOLDER = '<ABSOLUTE_PATH_TO_ENV_FILE>';

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

export interface PrintConfigOptions {
  harness: Harness;
  name?: string;
  source?: string;
  apiKey?: string;
  envFile?: string;
}

interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface StdioServerConfig extends ServerConfig {
  type: 'stdio';
}

interface Credentials {
  apiKey?: string;
  envFile?: string;
}

function resolveCredentials(apiKey: string | undefined, envFile: string | undefined): Credentials {
  if (apiKey !== undefined && envFile !== undefined) {
    throw new Error('apiKey and envFile cannot be used together.');
  }
  if (apiKey !== undefined) return { apiKey };
  return { envFile: envFile ?? ENV_FILE_PLACEHOLDER };
}

function serverConfig(source: string, credentials: Credentials): ServerConfig {
  const args = ['-y', source];
  if (credentials.envFile !== undefined) args.push('--env-file-path', credentials.envFile);
  if (credentials.apiKey !== undefined) {
    return { command: 'npx', args, env: { CURSOR_API_KEY: credentials.apiKey } };
  }
  return { command: 'npx', args };
}

function stdioServerConfig(source: string, credentials: Credentials): StdioServerConfig {
  return { type: 'stdio', ...serverConfig(source, credentials) };
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function credentialGuidance(credentials: Credentials): string[] {
  if (credentials.apiKey === KEY_PLACEHOLDER) {
    return [
      `# Replace ${KEY_PLACEHOLDER} before registering or enabling this server.`,
      '# Use a Cursor user API key or service account API key, passed raw as CURSOR_API_KEY.',
    ];
  }
  if (credentials.envFile === ENV_FILE_PLACEHOLDER) {
    return [
      `# Replace ${ENV_FILE_PLACEHOLDER} with the absolute path to your .env file`,
      '# before registering or enabling this server. The file must define CURSOR_API_KEY.',
    ];
  }
  return [];
}

function registrationCommand(
  client: 'claude' | 'codex',
  name: string,
  source: string,
  credentials: Credentials,
): string {
  const parts = [client, 'mcp', 'add', shellArg(name)];
  if (credentials.apiKey !== undefined) {
    parts.push('--env', shellArg(`CURSOR_API_KEY=${credentials.apiKey}`));
  }
  parts.push('--', 'npx', '-y', shellArg(source));
  if (credentials.envFile !== undefined) {
    parts.push('--env-file-path', shellArg(credentials.envFile));
  }
  return parts.join(' ');
}

/** Returns the snippet text for a harness. Never needs CURSOR_API_KEY to be set. */
export function printConfig({
  harness,
  name = DEFAULT_SERVER_NAME,
  source = DEFAULT_SOURCE,
  apiKey,
  envFile,
}: PrintConfigOptions): string {
  const credentials = resolveCredentials(apiKey, envFile);
  const config = serverConfig(source, credentials);
  const stdioConfig = stdioServerConfig(source, credentials);
  const guidance = credentialGuidance(credentials);
  const codexTable = `[mcp_servers.${tomlKey(name)}]`;

  switch (harness) {
    case 'claude-code':
      return [
        '# Claude Code — run this once (add --scope user to enable it in every project):',
        ...guidance,
        registrationCommand('claude', name, source, credentials),
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
        registrationCommand('codex', name, source, credentials),
        `# Then add tool_timeout_sec = 180 to the existing ${codexTable} table`,
        '# in ~/.codex/config.toml.',
        '',
        '# Alternative to the CLI: add this complete ~/.codex/config.toml entry',
        '# (note: mcp_servers, snake_case):',
        codexTable,
        'command = "npx"',
        `args = [${config.args.map(tomlString).join(', ')}]`,
        'tool_timeout_sec = 180',
        ...(credentials.apiKey === undefined
          ? []
          : [
              '',
              `[mcp_servers.${tomlKey(name)}.env]`,
              `CURSOR_API_KEY = ${tomlString(credentials.apiKey)}`,
            ]),
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
