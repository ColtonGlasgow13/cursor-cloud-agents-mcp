#!/usr/bin/env node
/** Opt-in development driver. Uses the real Cursor API and can create billed work. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.LIVE_RUN_OUT_DIR ?? os.tmpdir();
const launchPath = path.join(outDir, 'cursor-mcp-launch.json');
const monitorPath = path.join(outDir, 'cursor-mcp-monitor.json');
const terminal = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

if (!process.env.CURSOR_API_KEY) throw new Error('CURSOR_API_KEY is required.');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'cli.js')],
  cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')),
  stderr: 'inherit',
});
const client = new Client({ name: 'live-repo-run', version: '1.0.0' });
await client.connect(transport);

async function call(name, args, timeout = 180_000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  if (result.isError) {
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    throw new Error(`${name}: ${text}`);
  }
  return result.structuredContent ?? {};
}

try {
  const command = process.argv[2];
  if (command === 'launch') {
    if (!process.env.REPO_URL || !process.env.PROMPT) throw new Error('REPO_URL and PROMPT are required.');
    const created = await call(
      'launch_agent',
      {
        prompt: process.env.PROMPT,
        repos: [{ url: process.env.REPO_URL, ...(process.env.START_REF ? { startingRef: process.env.START_REF } : {}) }],
        mode: process.env.MODE ?? 'plan',
        ...(process.env.AGENT_NAME ? { name: process.env.AGENT_NAME } : {}),
      },
      900_000,
    );
    const output = { agentId: created.agent?.id, runId: created.run?.id, response: created };
    fs.writeFileSync(launchPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ agentId: output.agentId, runId: output.runId })}\n`);
  } else if (command === 'monitor') {
    const agentId = process.argv[3];
    const runId = process.argv[4];
    if (!agentId || !runId) throw new Error('Usage: live-repo-run.mjs monitor <agentId> <runId>');
    const waits = [];
    let run;
    do {
      const waited = await call('wait_for_run', { agentId, runId, maxWaitMs: 110_000 });
      waits.push(waited);
      run = waited.run;
    } while (run && !terminal.has(run.status));

    const finalRun = await call('get_run', { agentId, runId });
    const artifacts = await call('list_artifacts', { agentId });
    const firstPath = artifacts.items?.[0]?.path;
    const download = firstPath ? await call('download_artifact', { agentId, path: firstPath }) : undefined;
    const archive = await call('archive_agent', { agentId });
    fs.writeFileSync(
      monitorPath,
      `${JSON.stringify({ waits, finalRun, artifacts, download, archive }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify({ status: finalRun.status, report: monitorPath })}\n`);
  } else {
    throw new Error('Usage: live-repo-run.mjs launch | monitor <agentId> <runId>');
  }
} finally {
  await client.close();
}
