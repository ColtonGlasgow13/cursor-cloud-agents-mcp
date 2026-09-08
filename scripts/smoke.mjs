#!/usr/bin/env node
/**
 * Human smoke check: boot the BUILT server over stdio and list its tools.
 * Uses a fake key and an unreachable base URL — no network calls are made.
 */
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli],
  env: {
    PATH: process.env.PATH ?? '',
    CURSOR_API_KEY: 'crsr_smoke_test_key',
    CURSOR_API_BASE: 'http://127.0.0.1:9',
    CURSOR_MCP_LOG_LEVEL: 'error',
  },
  stderr: 'inherit',
});

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const version = client.getServerVersion();
console.log(`connected to ${version?.name ?? 'unknown'}@${version?.version ?? '?'}`);
console.log(`${tools.length} tools:`);
for (const tool of tools) console.log(`  - ${tool.name}`);

await client.close();

if (tools.length !== 18) {
  console.error(`expected 18 tools, got ${tools.length}`);
  process.exit(1);
}
console.log('smoke OK');
