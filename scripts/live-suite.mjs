#!/usr/bin/env node
/** Opt-in development suite. Uses the real Cursor API, creates work, and deletes its agent. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const terminal = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
if (!process.env.CURSOR_API_KEY) throw new Error('CURSOR_API_KEY is required.');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'cli.js')],
  cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')),
  stderr: 'inherit',
});
const client = new Client({ name: 'live-suite', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}, timeout = 180_000) {
  const startedAt = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  process.stdout.write(`${name}: ${result.isError ? 'ERROR' : 'ok'} (${Date.now() - startedAt}ms)\n`);
  if (result.isError) throw new Error(`${name}: ${text}`);
  return result.structuredContent ?? {};
}

let agentId;
try {
  const tools = await client.listTools();
  process.stdout.write(`${tools.tools.length} tools\n`);
  await call('whoami');
  await call('list_models');
  await call('list_models');
  await call('list_repositories');

  const created = await call(
    'launch_agent',
    { prompt: 'Reply with exactly PONG and stop.', name: 'mcp-live-suite' },
    900_000,
  );
  agentId = created.agent?.id;
  const runId = created.run?.id;
  if (!agentId || !runId) throw new Error('launch_agent response did not contain agent.id and run.id.');

  await call('get_agent', { agentId });
  await call('list_agents', { limit: 5 });
  await call('list_runs', { agentId });
  await call('get_run_events', { agentId, runId, maxWaitMs: 5000 });

  let waited;
  do {
    waited = await call('wait_for_run', { agentId, runId, maxWaitMs: 110_000 });
  } while (!terminal.has(waited.run?.status));
  await call('get_run', { agentId, runId });

  try {
    await call('get_usage', { agentId });
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
  }
  const artifacts = await call('list_artifacts', { agentId });
  if (artifacts.items?.[0]?.path) {
    await call('download_artifact', { agentId, path: artifacts.items[0].path });
  }

  const followup = await call('send_followup', { agentId, prompt: 'Reply with exactly PING and stop.' });
  const followupRunId = followup.run?.id;
  if (followupRunId) {
    await call('cancel_run', { agentId, runId: followupRunId });
    await call('wait_for_run', { agentId, runId: followupRunId, maxWaitMs: 30_000 });
  }
  await call('archive_agent', { agentId });
  await call('unarchive_agent', { agentId });
} finally {
  if (agentId) {
    try {
      await call('delete_agent', { agentId });
    } catch (error) {
      process.stderr.write(`cleanup failed: ${String(error)}\n`);
    }
  }
  await client.close();
}
