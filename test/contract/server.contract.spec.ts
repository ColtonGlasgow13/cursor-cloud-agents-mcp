import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/tools/index.js';
import { CONTRACT_AGENT_ID, CONTRACT_RUN_ID, startFakeApi, type FakeApi } from '../helpers/fakeApi.js';

const CLI_PATH = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

/**
 * Spawns the real CLI over stdio, exactly as an MCP client would, and talks to
 * it with the official SDK client. CURSOR_MCP_LOG_LEVEL=debug is deliberate:
 * if any logging leaked to stdout the JSON-RPC framing would break here.
 */
describe('stdio MCP server contract', () => {
  let api: FakeApi;
  let client: Client;
  let transport: StdioClientTransport;
  const stderrChunks: string[] = [];

  beforeAll(async () => {
    api = await startFakeApi();
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', CLI_PATH],
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        CURSOR_API_KEY: 'contract-test-key',
        CURSOR_API_BASE: api.baseUrl,
        CURSOR_MCP_LOG_LEVEL: 'debug',
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'contract-test', version: '0.0.0' });
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => void stderrChunks.push(chunk.toString('utf8')));
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await api.close();
  });

  it('advertises exactly the expected tool set', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(18);
  });

  it('gives every tool a title, a description and annotations', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(80);
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });

  it('calls whoami and returns the fixture as text and structured content', async () => {
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      apiKeyName: 'Production API Key',
      userEmail: 'developer@example.com',
      keyScope: 'user',
    });
    const [content] = result.content as { type: string; text: string }[];
    expect(content?.type).toBe('text');
    expect(JSON.parse(content?.text ?? '{}')).toMatchObject({ userId: 42 });
  });

  it('returns a run snapshot with derived fields', async () => {
    const result = await client.callTool({
      name: 'get_run',
      arguments: { agentId: CONTRACT_AGENT_ID, runId: CONTRACT_RUN_ID },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      isTerminal: true,
      prUrls: ['https://github.com/your-org/your-repo/pull/123'],
      suggestedPollDelayMs: 0,
    });
  });

  it('turns an unknown run id into an isError result naming NotFoundError', async () => {
    const result = await client.callTool({
      name: 'get_run',
      arguments: { agentId: CONTRACT_AGENT_ID, runId: 'run-does-not-exist' },
    });
    expect(result.isError).toBe(true);
    const [content] = result.content as { type: string; text: string }[];
    expect(content?.text).toContain('NotFoundError');
    expect(content?.text).toContain('run-does-not-exist');
    expect(content?.text).toContain('list_runs');
  });

  it('rejects delete_agent without confirm at the protocol level', async () => {
    const result = await client.callTool({
      name: 'delete_agent',
      arguments: { agentId: CONTRACT_AGENT_ID },
    });
    expect(result.isError).toBe(true);
  });

  it('logged to stderr at debug level without corrupting the stdout transport', async () => {
    await client.listTools();
    expect(stderrChunks.join('')).not.toContain('contract-test-key');
  });
});
