#!/usr/bin/env node
/**
 * LIVE repo-agent driver for cursor-cloud-agents-mcp.
 *
 * Two subcommands, deliberately split so a launch and its (long) monitoring
 * can happen in separate processes / separate sessions:
 *
 *   node scripts/live-repo-run.mjs launch
 *     Reads REPO_URL, START_REF (optional), PROMPT, MODE (default "plan"),
 *     AGENT_NAME (optional) from the environment and makes EXACTLY ONE
 *     launch_agent call. Prints one JSON line and writes it to
 *     <out>/andytown-launch.json, plus the full redacted tool result to
 *     <out>/andytown-launch-full.json.
 *
 *   node scripts/live-repo-run.mjs monitor <agentId> <runId>
 *     Polls get_run_events with cursor threading, falls back to wait_for_run,
 *     then collects get_run / list_runs / get_usage / list_artifacts
 *     (+ download_artifact for the first artifact) and finally ARCHIVES the
 *     agent (never deletes). Writes a JSON transcript and a markdown report.
 *
 * OPT-IN LIVE TEST. Nothing here is part of CI or `pnpm test`. It requires
 * CURSOR_API_KEY in the environment, LAUNCHES A REAL (billed) cloud agent on
 * REPO_URL, and ARCHIVES that agent when monitoring finishes. Never prints or
 * persists the key.
 *
 * Env:
 *   LIVE_RUN_OUT_DIR   where outputs go (default: os.tmpdir())
 *   LIVE_RUN_TRACE     "0" disables the child-process fetch tracer
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');

const OUT_DIR = process.env.LIVE_RUN_OUT_DIR ?? os.tmpdir();
const STDERR_LOG = path.join(OUT_DIR, 'andytown-server.stderr.log');
const LAUNCH_JSON = path.join(OUT_DIR, 'andytown-launch.json');
const LAUNCH_FULL_JSON = path.join(OUT_DIR, 'andytown-launch-full.json');
const MONITOR_JSON = path.join(OUT_DIR, 'andytown-monitor-transcript.json');
const MONITOR_MD = path.join(OUT_DIR, 'andytown-monitor-report.md');

// --------------------------------------------------------------- redaction

const KEY_RE = /crsr_[A-Za-z0-9_-]+/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._-]+/gi;

function redact(text) {
  return String(text).replace(KEY_RE, 'crsr_[REDACTED]').replace(BEARER_RE, '$1[REDACTED]');
}

function truncateText(text, max) {
  return text.length > max ? `${text.slice(0, max)}...[truncated ${text.length - max} chars]` : text;
}

function redactDeep(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(redact(JSON.stringify(value)));
  } catch {
    return redact(String(value));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function line(text) {
  process.stdout.write(`${redact(text)}\n`);
}

// ------------------------------------------------- child-process fetch trace
// The server does not log individual HTTP requests, so preload a tracer into
// the child that wraps globalThis.fetch and writes one stderr line per request.
// Method + URL + status only — never headers, never bodies.

const TRACE_ENABLED = process.env.LIVE_RUN_TRACE !== '0';
const TRACE_SRC = `
const orig = globalThis.fetch;
globalThis.fetch = async function tracedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const method = (init && init.method) || 'GET';
  const t0 = Date.now();
  try {
    const res = await orig.call(globalThis, input, init);
    process.stderr.write('[http-trace] ' + method + ' ' + url + ' -> ' + res.status + ' (' + (Date.now() - t0) + 'ms)\\n');
    return res;
  } catch (error) {
    process.stderr.write('[http-trace] ' + method + ' ' + url + ' -> NETERR ' + (error && error.message) + ' (' + (Date.now() - t0) + 'ms)\\n');
    throw error;
  }
};
`;

let tracerPath;
function installTracer(env) {
  if (!TRACE_ENABLED) return env;
  tracerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-repo-run-')), 'trace.mjs');
  fs.writeFileSync(tracerPath, TRACE_SRC, 'utf8');
  const existing = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  return { ...env, NODE_OPTIONS: `${existing}--import=${pathToFileURL(tracerPath).href}` };
}

// ------------------------------------------------------------------- state

const transcript = [];
let stderrBuffer = '';
let keyLeakOccurrences = 0;
let client;
let transport;
let stderrStream;

function httpLineCount(pattern) {
  const lines = stderrBuffer.split('\n').filter((l) => l.startsWith('[http-trace]'));
  return pattern === undefined ? lines.length : lines.filter((l) => l.includes(pattern)).length;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

/** Calls one tool and records the redacted outcome. Never throws on isError. */
async function call(id, name, args, opts = {}) {
  const { timeout = 120000 } = opts;
  const httpBefore = httpLineCount();
  const startedAt = Date.now();
  let result;
  let thrown;
  try {
    result = await client.callTool({ name, arguments: args }, undefined, {
      timeout,
      resetTimeoutOnProgress: false,
    });
  } catch (error) {
    thrown = error;
  }
  const ms = Date.now() - startedAt;
  await sleep(120); // let the child's stderr chunks land before counting
  const httpRequests = httpLineCount() - httpBefore;

  const threw = thrown !== undefined;
  const isError = threw || result?.isError === true;
  const text = threw
    ? `TRANSPORT THROW ${thrown?.name ?? 'Error'}: ${thrown?.message ?? String(thrown)}`
    : (result?.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  const structured = threw ? undefined : result?.structuredContent;

  const entry = {
    step: id,
    tool: name,
    args: redactDeep(args),
    isError,
    threw,
    ms,
    httpRequests,
    text: redact(text),
    structured: redactDeep(structured),
  };
  transcript.push(entry);
  return { ...entry, raw: result, thrown };
}

// -------------------------------------------------------------- connection

async function connect(clientName) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  stderrStream = fs.createWriteStream(STDERR_LOG, { flags: 'a' });

  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
  );
  if (!baseEnv.CURSOR_API_KEY) {
    line('CURSOR_API_KEY is not set in the environment. Aborting.');
    process.exit(2);
  }

  const env = installTracer({ ...baseEnv, CURSOR_MCP_LOG_LEVEL: 'debug' });

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: REPO_ROOT,
    env,
    stderr: 'pipe',
  });

  transport.stderr?.on('data', (chunk) => {
    const raw = chunk.toString('utf8');
    // Count leaks BEFORE redacting, but only ever persist the redacted text.
    keyLeakOccurrences += (raw.match(KEY_RE) ?? []).length;
    const safe = redact(raw);
    stderrBuffer += safe;
    stderrStream.write(safe);
  });

  client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
}

async function disconnect() {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  try {
    stderrStream?.end();
  } catch {
    /* ignore */
  }
  if (tracerPath !== undefined) {
    try {
      fs.rmSync(path.dirname(tracerPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------------ launch

const LAUNCH_TIMEOUT_MS = 900000; // POST /v1/agents blocks server-side for minutes.

async function launch() {
  const repoUrl = process.env.REPO_URL;
  const startRef = process.env.START_REF;
  const prompt = process.env.PROMPT;
  const mode = process.env.MODE ?? 'plan';
  const agentName = process.env.AGENT_NAME;

  if (!repoUrl) {
    line('REPO_URL is required.');
    process.exit(2);
  }
  if (!prompt) {
    line('PROMPT is required.');
    process.exit(2);
  }

  const args = compact({
    prompt,
    repos: [compact({ url: repoUrl, startingRef: startRef || undefined })],
    mode,
    name: agentName || undefined,
  });

  line(`[launch] repo=${repoUrl} startingRef=${startRef ?? '(none)'} mode=${mode} name=${agentName ?? '(auto)'}`);
  line(`[launch] calling launch_agent (timeout ${LAUNCH_TIMEOUT_MS}ms) at ${new Date().toISOString()} ...`);

  const startedAt = Date.now();
  const res = await call('launch', 'launch_agent', args, { timeout: LAUNCH_TIMEOUT_MS });
  const launchMs = Date.now() - startedAt;

  line(`[launch] returned after ${launchMs}ms (${(launchMs / 1000).toFixed(1)}s), ${res.httpRequests} http request(s)`);

  fs.writeFileSync(
    LAUNCH_FULL_JSON,
    redact(
      JSON.stringify(
        {
          startedAt: new Date(startedAt).toISOString(),
          launchMs,
          args: redactDeep(args),
          isError: res.isError,
          threw: res.threw,
          httpRequests: res.httpRequests,
          text: res.text,
          structured: res.structured,
          httpTrace: stderrBuffer.split('\n').filter((l) => l.startsWith('[http-trace]')),
          keyLeakOccurrences,
        },
        null,
        2,
      ),
    ),
    'utf8',
  );

  if (res.isError) {
    line('[launch] TOOL RETURNED isError. Full error text follows:');
    line('>>>');
    line(res.text);
    line('<<<');
    line(`[launch] full result written to ${LAUNCH_FULL_JSON}`);
    await disconnect();
    process.exit(1);
  }

  let s = res.structured ?? {};
  let agentId = s.agentId;
  let runId = s.runId;
  let pending = s.pending === true;

  // Forward compatibility: if the server ever returns a `pending: true` shape
  // (agent id minted, creation still in flight) resolve it by polling.
  if (pending || (agentId !== undefined && runId === undefined)) {
    line(`[launch] pending shape detected (agentId=${agentId ?? '?'}, runId=${runId ?? '?'}); polling get_agent every 10s ...`);
    for (let i = 0; i < 60 && agentId !== undefined; i += 1) {
      const got = await call(`launch-poll-${i}`, 'get_agent', { agentId }, { timeout: 60000 });
      if (!got.isError && got.structured?.agent?.id) {
        s = { ...s, agentStatus: got.structured.agent.status };
        const runs = await call(`launch-runs-${i}`, 'list_runs', { agentId, limit: 1 }, { timeout: 60000 });
        const first = runs.structured?.items?.[0];
        if (first?.id) {
          runId = first.id;
          s = { ...s, runStatus: first.status };
          break;
        }
      }
      line(`[launch] still pending (iteration ${i + 1}); sleeping 10s`);
      await sleep(10000);
    }
  }

  const out = compact({
    agentId,
    runId,
    agentStatus: s.agentStatus,
    runStatus: s.runStatus,
    url: agentId === undefined ? undefined : `https://cursor.com/agents/${agentId}`,
    launchMs,
    pending: pending ? true : undefined,
  });

  fs.writeFileSync(LAUNCH_JSON, `${redact(JSON.stringify(out))}\n`, 'utf8');
  line(redact(JSON.stringify(out)));
  line(`[launch] wrote ${LAUNCH_JSON} and ${LAUNCH_FULL_JSON}`);
  if (keyLeakOccurrences > 0) line(`[launch] WARNING: ${keyLeakOccurrences} crsr_ occurrence(s) seen in child stderr pre-redaction`);
  await disconnect();
}

// ----------------------------------------------------------------- monitor

const MAX_EVENT_POLLS = 12;
const MAX_WAIT_CALLS = 12;

function eventFingerprint(event) {
  return `${event?.id ?? 'null'}|${event?.type ?? '?'}|${JSON.stringify(event?.data ?? null)}`;
}

function toolCallSummary(event) {
  const d = event?.data ?? {};
  const name = d.name ?? d.toolName ?? d.tool ?? d.tool_name ?? d?.toolCall?.name;
  const status = d.status ?? d.state ?? d?.toolCall?.status;
  return { name: name ?? '(unknown)', status: status ?? '(none)' };
}

async function monitor(agentId, runId) {
  line(`[monitor] agentId=${agentId} runId=${runId}`);

  const seen = new Map(); // fingerprint -> first iteration seen
  const iterations = [];
  const toolCalls = [];
  const globalTypeHistogram = {};
  let cursor = undefined;
  let isTerminal = false;
  let runStatus;
  let duplicateCount = 0;
  const startedAt = Date.now();

  // ---- phase A: get_run_events with cursor threading
  for (let i = 0; i < MAX_EVENT_POLLS && !isTerminal; i += 1) {
    const args = compact({ agentId, runId, afterEventId: cursor, maxWaitMs: 15000 });
    const res = await call(`events-${i}`, 'get_run_events', args, { timeout: 120000 });

    if (res.isError) {
      line(`[monitor] events poll ${i} isError: ${res.text.slice(0, 500)}`);
      iterations.push({ phase: 'get_run_events', i, isError: true, text: res.text, ms: res.ms });
      break;
    }

    const s = res.structured ?? {};
    const events = Array.isArray(s.events) ? s.events : [];
    const typeHistogram = {};
    const dupes = [];
    for (const ev of events) {
      typeHistogram[ev?.type ?? '?'] = (typeHistogram[ev?.type ?? '?'] ?? 0) + 1;
      globalTypeHistogram[ev?.type ?? '?'] = (globalTypeHistogram[ev?.type ?? '?'] ?? 0) + 1;
      const fp = eventFingerprint(ev);
      if (seen.has(fp)) {
        duplicateCount += 1;
        dupes.push({ id: ev?.id ?? null, type: ev?.type, firstSeenIteration: seen.get(fp) });
      } else {
        seen.set(fp, i);
      }
      if (ev?.type === 'tool_call') {
        const tc = toolCallSummary(ev);
        toolCalls.push({ iteration: i, eventId: ev?.id ?? null, ...tc });
      }
    }

    cursor = s.nextEventId ?? cursor;
    runStatus = s.runStatus;
    isTerminal = s.isTerminal === true;

    const iteration = {
      phase: 'get_run_events',
      i,
      ms: res.ms,
      httpRequests: res.httpRequests,
      eventCount: s.eventCount ?? events.length,
      typeHistogram,
      nextEventId: s.nextEventId ?? null,
      runStatus,
      isTerminal,
      streamExpired: s.streamExpired === true,
      cursorInvalid: s.cursorInvalid === true,
      suggestedPollDelayMs: s.suggestedPollDelayMs,
      duplicates: dupes,
      hasDuplicates: dupes.length > 0,
      toolCalls: toolCalls.filter((t) => t.iteration === i),
      events: redactDeep(events),
    };
    iterations.push(iteration);

    line(
      `[monitor] events-${i}: ${iteration.eventCount} event(s) ${JSON.stringify(typeHistogram)} ` +
        `status=${runStatus} terminal=${isTerminal} next=${iteration.nextEventId ?? 'null'} ` +
        `dupes=${dupes.length} (${res.ms}ms)`,
    );
    for (const t of iteration.toolCalls) line(`           tool_call: ${t.name} [${t.status}]`);

    if (s.streamExpired === true || s.cursorInvalid === true) {
      line(`[monitor] stream unusable (streamExpired=${s.streamExpired} cursorInvalid=${s.cursorInvalid}); leaving event loop`);
      break;
    }
    if (isTerminal) break;
    const delay = Math.min(s.suggestedPollDelayMs ?? 5000, 10000);
    await sleep(delay);
  }

  // ---- phase B: wait_for_run until terminal
  let waitCalls = 0;
  while (!isTerminal && waitCalls < MAX_WAIT_CALLS) {
    const args = compact({ agentId, runId, maxWaitMs: 110000, afterEventId: cursor });
    const res = await call(`wait-${waitCalls}`, 'wait_for_run', args, { timeout: 180000 });
    if (res.isError) {
      line(`[monitor] wait_for_run ${waitCalls} isError: ${res.text.slice(0, 500)}`);
      iterations.push({ phase: 'wait_for_run', i: waitCalls, isError: true, text: res.text, ms: res.ms });
      break;
    }
    const s = res.structured ?? {};
    cursor = s.nextEventId ?? s.lastEventId ?? cursor;
    runStatus = s.runStatus ?? s.run?.status ?? runStatus;
    isTerminal = s.isTerminal === true;
    iterations.push({
      phase: 'wait_for_run',
      i: waitCalls,
      ms: res.ms,
      httpRequests: res.httpRequests,
      eventCount: s.eventCount,
      nextEventId: cursor ?? null,
      runStatus,
      isTerminal,
      timedOut: s.timedOut,
      structured: redactDeep(s),
    });
    line(
      `[monitor] wait-${waitCalls}: status=${runStatus} terminal=${isTerminal} ` +
        `events=${s.eventCount ?? '?'} next=${cursor ?? 'null'} (${res.ms}ms)`,
    );
    waitCalls += 1;
  }

  const monitorMs = Date.now() - startedAt;
  line(`[monitor] loop done after ${monitorMs}ms; terminal=${isTerminal} status=${runStatus}`);

  // ---- phase C: final state
  const finalRun = await call('get_run', 'get_run', { agentId, runId }, { timeout: 120000 });
  line(`[monitor] get_run: ${finalRun.isError ? 'isError' : `status=${finalRun.structured?.run?.status}`} (${finalRun.ms}ms)`);

  const runsRes = await call('list_runs', 'list_runs', { agentId, limit: 20 }, { timeout: 120000 });
  line(`[monitor] list_runs: ${runsRes.isError ? 'isError' : `${runsRes.structured?.items?.length ?? 0} run(s)`} (${runsRes.ms}ms)`);

  const usageRes = await call('get_usage', 'get_usage', { agentId }, { timeout: 120000 });
  line(`[monitor] get_usage: ${usageRes.isError ? 'isError' : JSON.stringify(usageRes.structured).slice(0, 200)} (${usageRes.ms}ms)`);

  const artifactsRes = await call('list_artifacts', 'list_artifacts', { agentId }, { timeout: 120000 });
  const artifacts = artifactsRes.structured?.items ?? [];
  line(`[monitor] list_artifacts: ${artifactsRes.isError ? 'isError' : `${artifacts.length} artifact(s)`} (${artifactsRes.ms}ms)`);

  let downloadSummary;
  if (!artifactsRes.isError && artifacts.length > 0 && artifacts[0]?.path) {
    const dl = await call('download_artifact', 'download_artifact', { agentId, path: artifacts[0].path }, { timeout: 120000 });
    if (dl.isError) {
      downloadSummary = { isError: true, text: dl.text };
    } else {
      let host;
      try {
        host = new URL(dl.structured?.url ?? '').host;
      } catch {
        host = '(unparseable)';
      }
      downloadSummary = { path: artifacts[0].path, urlHost: host, expiresAt: dl.structured?.expiresAt };
    }
    line(`[monitor] download_artifact: ${JSON.stringify(downloadSummary)}`);
  }

  // ---- phase D: archive (NEVER delete)
  const archiveRes = await call('archive_agent', 'archive_agent', { agentId }, { timeout: 120000 });
  line(`[monitor] archive_agent: ${archiveRes.isError ? `isError ${archiveRes.text.slice(0, 300)}` : 'ok'} (${archiveRes.ms}ms)`);

  // ---- outputs
  const summary = {
    agentId,
    runId,
    url: `https://cursor.com/agents/${agentId}`,
    monitorMs,
    reachedTerminal: isTerminal,
    finalRunStatus: finalRun.structured?.run?.status ?? runStatus,
    eventPolls: iterations.filter((it) => it.phase === 'get_run_events').length,
    waitCalls: iterations.filter((it) => it.phase === 'wait_for_run').length,
    totalEvents: Object.values(globalTypeHistogram).reduce((a, b) => a + b, 0),
    eventTypeHistogram: globalTypeHistogram,
    duplicateEvents: duplicateCount,
    toolCalls,
    artifacts: artifacts.length,
    downloadSummary,
    archived: !archiveRes.isError,
    keyLeakOccurrences,
    errors: transcript.filter((t) => t.isError).map((t) => ({ step: t.step, tool: t.tool, text: t.text })),
  };

  fs.writeFileSync(
    MONITOR_JSON,
    redact(
      JSON.stringify(
        {
          summary,
          iterations,
          finalRun: finalRun.structured,
          listRuns: runsRes.structured,
          usage: usageRes.structured,
          artifacts: artifactsRes.structured,
          download: downloadSummary,
          archive: archiveRes.structured,
          transcript,
          httpTrace: stderrBuffer.split('\n').filter((l) => l.startsWith('[http-trace]')),
        },
        null,
        2,
      ),
    ),
    'utf8',
  );

  // `run.result` is a plain STRING, not `{ text }`: reading `.text` used to fall
  // through to `finalRun.text`, which is the entire get_run JSON blob.
  const rawResult = finalRun.structured?.run?.result;
  const resultText = typeof rawResult === 'string' ? rawResult : '';
  const finalResultBlock =
    resultText === ''
      ? '_no result text (a terminal run does not always produce one; a plan-mode plan lives in artifacts/plans/)_'
      : ['```', redact(truncateText(resultText, 500)), '```'].join('\n');

  const md = [
    `# Cloud agent monitor report`,
    ``,
    `- agentId: \`${agentId}\``,
    `- runId: \`${runId}\``,
    `- url: ${summary.url}`,
    `- monitor wall time: ${monitorMs} ms (${(monitorMs / 1000).toFixed(1)}s)`,
    `- reached terminal: ${isTerminal}`,
    `- final run status: ${summary.finalRunStatus}`,
    `- get_run_events polls: ${summary.eventPolls} | wait_for_run calls: ${summary.waitCalls}`,
    `- total events: ${summary.totalEvents} | duplicates flagged: ${duplicateCount}`,
    `- artifacts: ${artifacts.length} | archived: ${summary.archived}`,
    `- crsr_ occurrences in child stderr pre-redaction: ${keyLeakOccurrences}`,
    ``,
    `## Event type histogram`,
    ``,
    ...Object.entries(globalTypeHistogram).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Tool calls observed`,
    ``,
    toolCalls.length === 0
      ? '_none_'
      : toolCalls.map((t) => `- iter ${t.iteration}: \`${t.name}\` [${t.status}]`).join('\n'),
    ``,
    `## Per-iteration`,
    ``,
    '| # | phase | ms | events | status | terminal | nextEventId | dupes |',
    '| - | ----- | -- | ------ | ------ | -------- | ----------- | ----- |',
    ...iterations.map(
      (it) =>
        `| ${it.i} | ${it.phase} | ${it.ms ?? ''} | ${it.eventCount ?? ''} | ${it.runStatus ?? ''} | ${
          it.isTerminal ?? ''
        } | ${it.nextEventId ?? ''} | ${it.duplicates?.length ?? 0} |`,
    ),
    ``,
    `## Final result text`,
    ``,
    finalResultBlock,
    ``,
    `## Errors`,
    ``,
    summary.errors.length === 0
      ? '_none_'
      : summary.errors.map((e) => `### ${e.step} (${e.tool})\n\n\`\`\`\n${e.text}\n\`\`\``).join('\n\n'),
    ``,
  ].join('\n');

  fs.writeFileSync(MONITOR_MD, redact(md), 'utf8');
  line(`[monitor] wrote ${MONITOR_JSON} and ${MONITOR_MD}`);
  await disconnect();
}

// -------------------------------------------------------------------- main

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === 'launch') {
    await connect('live-repo-run-launch');
    await launch();
    return;
  }
  if (subcommand === 'monitor') {
    const [agentId, runId] = rest;
    if (!agentId || !runId) {
      line('usage: node scripts/live-repo-run.mjs monitor <agentId> <runId>');
      process.exit(2);
    }
    await connect('live-repo-run-monitor');
    await monitor(agentId, runId);
    return;
  }
  line('usage: node scripts/live-repo-run.mjs launch | monitor <agentId> <runId>');
  process.exit(2);
}

main().catch(async (error) => {
  line(`FATAL: ${redact(error?.stack ?? String(error))}`);
  await disconnect();
  process.exit(1);
});
