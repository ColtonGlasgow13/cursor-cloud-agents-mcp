#!/usr/bin/env node
/**
 * LIVE end-to-end suite for cursor-cloud-agents-mcp.
 *
 * Drives the real MCP stdio surface (`node dist/cli.js`) with the real MCP SDK
 * client, against the real Cursor Cloud Agents API v1. It launches exactly ONE
 * no-repo agent with a trivial prompt and always deletes it in `finally`.
 *
 * Requires CURSOR_API_KEY in the environment. Never prints or persists it.
 *
 *   node scripts/live-suite.mjs
 *
 * Env:
 *   LIVE_SUITE_OUT_DIR   where the stderr log + JSON transcript go (default: os.tmpdir())
 *   LIVE_SUITE_TRACE     "0" disables the child-process fetch tracer
 *
 * Outputs:
 *   <out>/live-suite.stderr.log        child stderr (redacted on the way in)
 *   <out>/live-suite-transcript.json   every call + result (redacted)
 *
 * Exit code is non-zero if any "must pass" step failed.
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

const OUT_DIR = process.env.LIVE_SUITE_OUT_DIR ?? os.tmpdir();
const STDERR_LOG = path.join(OUT_DIR, 'live-suite.stderr.log');
const TRANSCRIPT = path.join(OUT_DIR, 'live-suite-transcript.json');

// --------------------------------------------------------------- redaction

const KEY_RE = /crsr_[A-Za-z0-9_-]+/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._-]+/gi;

function redact(text) {
  return String(text).replace(KEY_RE, 'crsr_[REDACTED]').replace(BEARER_RE, '$1[REDACTED]');
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

// ------------------------------------------------- child-process fetch trace
// The server does not log individual HTTP requests, so to count them we preload
// a tracer into the child that wraps globalThis.fetch and writes one stderr line
// per request. It logs method + URL + status only (never headers, never bodies).

const TRACE_ENABLED = process.env.LIVE_SUITE_TRACE !== '0';
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
  tracerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-suite-')), 'trace.mjs');
  fs.writeFileSync(tracerPath, TRACE_SRC, 'utf8');
  const existing = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  return { ...env, NODE_OPTIONS: `${existing}--import=${pathToFileURL(tracerPath).href}` };
}

// ------------------------------------------------------------------- state

const transcript = [];
const steps = [];
let stderrBuffer = '';
let keyLeakOccurrences = 0;
let mustFailCount = 0;

function record(entry) {
  steps.push(entry);
  transcript.push(entry);
}

function line(text) {
  process.stdout.write(`${redact(text)}\n`);
}

function httpLineCount(pattern) {
  const lines = stderrBuffer.split('\n').filter((l) => l.startsWith('[http-trace]'));
  return pattern === undefined ? lines.length : lines.filter((l) => l.includes(pattern)).length;
}

// --------------------------------------------------------------- the runner

let client;

/**
 * Calls one tool and records the outcome.
 * opts: { id, must, expectError, timeout, summary }
 */
async function call(id, name, args, opts = {}) {
  const { must = false, expectError = false, timeout = 120000, summary } = opts;
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
  // Let the child's stderr chunks land before we count requests for this step.
  await sleep(120);
  const httpRequests = httpLineCount() - httpBefore;

  const threw = thrown !== undefined;
  const isError = threw || result?.isError === true;
  const text = threw
    ? `TRANSPORT THROW ${thrown?.name ?? 'Error'}: ${thrown?.message ?? String(thrown)}`
    : (result?.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join('\n');
  const structured = threw ? undefined : result?.structuredContent;

  let outcome;
  if (!isError) outcome = expectError ? 'unexpected-pass' : 'pass';
  else outcome = expectError ? 'expected-error' : must ? 'FAIL' : 'error';
  if (outcome === 'FAIL') mustFailCount += 1;

  const entry = {
    step: id,
    tool: name,
    args: redactDeep(args),
    outcome,
    isError,
    threw,
    ms,
    httpRequests,
    text: redact(text),
    structured: redactDeep(structured),
  };
  record(entry);

  line(`[step ${id}] ${name} → ${isError ? 'isError' : 'ok'} (${ms}ms, ${httpRequests} http) [${outcome}]`);
  if (isError) {
    line(`    ERROR TEXT >>>\n${text.split('\n').map((l) => `    | ${l}`).join('\n')}\n    <<<`);
  } else if (summary) {
    for (const s of [].concat(summary(structured, text))) line(`    ${s}`);
  } else if (structured !== undefined) {
    line(`    ${JSON.stringify(structured).slice(0, 400)}`);
  }
  return { ...entry, raw: result, thrown };
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------- the suite

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stderrStream = fs.createWriteStream(STDERR_LOG, { flags: 'w' });

  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
  );
  if (!baseEnv.CURSOR_API_KEY) {
    line('CURSOR_API_KEY is not set in the environment. Aborting.');
    process.exitCode = 2;
    return;
  }

  const env = installTracer({ ...baseEnv, CURSOR_MCP_LOG_LEVEL: 'debug' });

  const transport = new StdioClientTransport({
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

  client = new Client({ name: 'live-suite', version: '1.0.0' }, { capabilities: {} });

  const findings = {
    startedAt: new Date().toISOString(),
    agentId: undefined,
    firstRunId: undefined,
    followupRunId: undefined,
    polling: {},
    notes: [],
  };

  let agentId;
  let firstRunId;
  let followupRunId;

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    line(`[step 0] connect + tools/list → ok (${tools.tools.length} tools)`);
    findings.toolCount = tools.tools.length;
    findings.toolNames = tools.tools.map((t) => t.name);
    record({ step: '0', tool: 'tools/list', outcome: 'pass', toolNames: findings.toolNames });

    // ---------------------------------------------------------------- step 1
    const s1 = await call('1', 'whoami', {}, {
      must: true,
      summary: (d) => [
        `keyScope=${d?.keyScope} apiKeyName=${JSON.stringify(d?.apiKeyName)} createdAt=${d?.createdAt}`,
        `shape keys: ${Object.keys(d ?? {}).join(', ')}`,
      ],
    });
    findings.whoami = { keyScope: s1.structured?.keyScope, keys: Object.keys(s1.structured ?? {}) };
    await sleep(1000);

    // ---------------------------------------------------------------- step 2
    const modelsBefore = httpLineCount('/v1/models');
    const s2a = await call('2a', 'list_models', {}, {
      must: true,
      summary: (d) => `${d?.items?.length ?? 0} models: ${(d?.items ?? []).map((m) => m.id).slice(0, 12).join(', ')}`,
    });
    const modelsAfterFirst = httpLineCount('/v1/models');
    const s2b = await call('2b', 'list_models', {}, {
      must: true,
      summary: (d) => `${d?.items?.length ?? 0} models (second call)`,
    });
    const modelsAfterSecond = httpLineCount('/v1/models');
    findings.modelsCache = {
      httpRequestsFirstCall: modelsAfterFirst - modelsBefore,
      httpRequestsSecondCall: modelsAfterSecond - modelsAfterFirst,
      firstCallMs: s2a.ms,
      secondCallMs: s2b.ms,
      servedFromCache: modelsAfterSecond - modelsAfterFirst === 0,
      traceEnabled: TRACE_ENABLED,
    };
    line(`    [cache] /v1/models HTTP requests: first=${findings.modelsCache.httpRequestsFirstCall} second=${findings.modelsCache.httpRequestsSecondCall} → secondFromCache=${findings.modelsCache.servedFromCache}`);
    await sleep(1000);

    // ---------------------------------------------------------------- step 3
    await call('3a', 'list_repositories', {}, {
      must: true,
      timeout: 180000,
      summary: (d) => `count=${d?.count} first=${JSON.stringify(d?.items?.[0])}`,
    });
    const s3b = await call('3b', 'list_repositories', { refresh: true }, { expectError: true });
    findings.repositoriesStrictLimit = s3b.text;

    // ---------------------------------------------------------------- step 4
    const s4 = await call(
      '4',
      'launch_agent',
      {
        prompt: 'Reply with exactly the single word PONG and then stop. Do not create or modify any files.',
        name: 'mcp-live-suite',
      },
      {
        must: true,
        summary: (d) => [
          `agentId=${d?.agentId} runId=${d?.runId}`,
          `agentStatus=${d?.agentStatus} runStatus=${d?.runStatus} alreadyExisted=${d?.alreadyExisted}`,
          `top-level keys: ${Object.keys(d ?? {}).join(', ')}`,
          `agent keys: ${Object.keys(d?.agent ?? {}).join(', ')}`,
          `run keys: ${Object.keys(d?.run ?? {}).join(', ')}`,
        ],
      },
    );
    agentId = s4.structured?.agentId;
    firstRunId = s4.structured?.runId;
    findings.agentId = agentId;
    findings.firstRunId = firstRunId;
    findings.launchShape = {
      topLevel: Object.keys(s4.structured ?? {}),
      agent: s4.structured?.agent,
      run: s4.structured?.run,
    };
    if (agentId === undefined || firstRunId === undefined) {
      findings.notes.push('launch_agent did not return agentId/runId; skipping the rest of the suite.');
      return;
    }

    // ---------------------------------------------------------------- step 5
    const pollStart = Date.now();
    const HARD_CAP_MS = 6 * 60 * 1000;
    const seenEvents = new Map();
    const duplicates = [];
    const iterations = [];
    const allTypes = new Set();
    let afterEventId;
    let terminalReached = false;
    let sawStreamExpired = false;
    let sawCursorInvalid = false;
    let hitHardCap = false;
    let localRateLimits = 0;
    let finalResultText;

    for (let i = 1; i <= 40; i += 1) {
      const r = await call(
        `5.${i}`,
        'get_run_events',
        compact({ agentId, runId: firstRunId, afterEventId, maxWaitMs: 8000 }),
        {
          must: true,
          summary: (d) =>
            `n=${d?.eventCount} types=[${[...new Set((d?.events ?? []).map((e) => e.type))].join(',')}] next=${JSON.stringify(d?.nextEventId)} status=${d?.runStatus} terminal=${d?.isTerminal} retention=${d?.retentionSeconds} delay=${d?.suggestedPollDelayMs}`,
        },
      );

      if (r.isError) {
        if (r.text.includes('LocalRateLimitError')) {
          localRateLimits += 1;
          // Our own budget, not the API's: back off and keep polling.
          steps[steps.length - 1].outcome = 'local-rate-limited';
          mustFailCount -= 1;
          await sleep(10000);
          continue;
        }
        findings.notes.push(`Polling iteration ${i} failed: ${r.text}`);
        break;
      }

      const d = r.structured ?? {};
      const events = d.events ?? [];
      const types = [...new Set(events.map((e) => e.type))];
      types.forEach((t) => allTypes.add(t));
      for (const e of events) {
        const key = `${e.id}|${e.type}|${JSON.stringify(e.data)}`;
        if (seenEvents.has(key)) duplicates.push({ iteration: i, firstSeenIn: seenEvents.get(key), key: key.slice(0, 300) });
        else seenEvents.set(key, i);
      }
      iterations.push({
        iteration: i,
        eventCount: d.eventCount,
        eventTypes: types,
        nextEventId: d.nextEventId ?? null,
        runStatus: d.runStatus,
        isTerminal: d.isTerminal,
        streamExpired: d.streamExpired,
        cursorInvalid: d.cursorInvalid,
        retentionSeconds: d.retentionSeconds,
        suggestedPollDelayMs: d.suggestedPollDelayMs,
        elapsedMsSincePollStart: Date.now() - pollStart,
        callMs: r.ms,
        httpRequests: r.httpRequests,
      });
      if (d.streamExpired === true) sawStreamExpired = true;
      if (d.cursorInvalid === true) sawCursorInvalid = true;
      for (const e of events) {
        if (e.type === 'result' && e.data && typeof e.data === 'object' && typeof e.data.text === 'string') {
          finalResultText = e.data.text;
        }
      }

      if (typeof d.nextEventId === 'string' && d.nextEventId !== '') afterEventId = d.nextEventId;

      if (d.isTerminal === true) {
        terminalReached = true;
        break;
      }
      if (Date.now() - pollStart > HARD_CAP_MS) {
        hitHardCap = true;
        break;
      }
      await sleep(Math.min(8000, Math.max(1000, d.suggestedPollDelayMs ?? 5000)));
    }

    findings.polling = {
      iterations,
      iterationCount: iterations.length,
      totalWallMsToTerminal: Date.now() - pollStart,
      terminalReached,
      hitHardCap,
      sawStreamExpired,
      sawCursorInvalid,
      localRateLimits,
      eventTypesSeen: [...allTypes],
      uniqueEvents: seenEvents.size,
      duplicates,
      finalResultTextFromStream: finalResultText,
    };
    line(
      `    [poll] iterations=${iterations.length} wall=${findings.polling.totalWallMsToTerminal}ms terminal=${terminalReached} types=[${[...allTypes].join(',')}] uniqueEvents=${seenEvents.size} duplicates=${duplicates.length} streamExpired=${sawStreamExpired} cursorInvalid=${sawCursorInvalid}`,
    );
    if (finalResultText !== undefined) line(`    [poll] result text: ${JSON.stringify(finalResultText).slice(0, 300)}`);

    if (!terminalReached) {
      findings.notes.push('First run did not reach a terminal status inside the polling budget; cancelling it.');
      await call('5c', 'cancel_run', { agentId, runId: firstRunId }, {});
    }
    await sleep(1500);

    // ---------------------------------------------------------------- step 6
    const s6 = await call('6', 'get_run', { agentId, runId: firstRunId }, {
      must: true,
      summary: (d) => [
        `status=${d?.run?.status} durationMs=${d?.run?.durationMs} isTerminal=${d?.isTerminal} prUrls=${JSON.stringify(d?.prUrls)}`,
        `result=${JSON.stringify(d?.run?.result ?? null).slice(0, 300)}`,
        `run keys: ${Object.keys(d?.run ?? {}).join(', ')}`,
      ],
    });
    findings.firstRunFinal = s6.structured?.run;
    await sleep(1500);

    // ---------------------------------------------------------------- step 7
    await call('7a', 'list_runs', { agentId }, {
      must: true,
      summary: (d) => `${d?.items?.length ?? 0} runs: ${(d?.items ?? []).map((r) => `${r.id}:${r.status}`).join(', ')}`,
    });
    await sleep(1200);
    await call('7b', 'get_agent', { agentId }, {
      must: true,
      summary: (d) => [
        `status=${d?.agent?.status} latestRunId=${d?.agent?.latestRunId} env=${JSON.stringify(d?.agent?.env)} repos=${JSON.stringify(d?.agent?.repos)}`,
        `agent keys: ${Object.keys(d?.agent ?? {}).join(', ')}`,
      ],
    });
    await sleep(1200);
    const s7c = await call('7c', 'list_agents', { limit: 5 }, {
      must: true,
      summary: (d) => `${d?.items?.length ?? 0} agents; ours included=${(d?.items ?? []).some((a) => a.id === agentId)}`,
    });
    findings.listAgentsIncludesOurs = (s7c.structured?.items ?? []).some((a) => a.id === agentId);
    if (!findings.listAgentsIncludesOurs) {
      findings.notes.push(`list_agents({limit:5}) did NOT include our agentId ${agentId}.`);
    }
    await sleep(1500);

    // ---------------------------------------------------------------- step 8
    const s8 = await call('8', 'get_usage', { agentId }, {
      summary: (d) => `totalUsage=${JSON.stringify(d?.totalUsage)} runs=${(d?.runs ?? []).length}`,
    });
    findings.usage = { outcome: s8.outcome, text: s8.text, structured: s8.structured };
    await sleep(1500);

    // ---------------------------------------------------------------- step 9
    const s9 = await call('9a', 'list_artifacts', { agentId }, {
      must: true,
      summary: (d) => `count=${d?.count} paths=${JSON.stringify((d?.items ?? []).map((a) => a.path))}`,
    });
    const artifacts = s9.structured?.items ?? [];
    findings.artifacts = artifacts;
    if (artifacts.length > 0) {
      await sleep(1200);
      const s9b = await call('9b', 'download_artifact', { agentId, path: artifacts[0].path }, {
        must: true,
        summary: (d) => {
          let host = 'unparseable';
          try {
            host = new URL(d?.url).host;
          } catch {}
          return `urlHost=${host} expiresAt=${d?.expiresAt}`;
        },
      });
      let host;
      try {
        host = new URL(s9b.structured?.url).host;
      } catch {}
      findings.artifactDownload = { host, expiresAt: s9b.structured?.expiresAt };
    }
    await sleep(1500);

    // --------------------------------------------------------------- step 10
    const s10a = await call(
      '10a',
      'send_followup',
      { agentId, prompt: 'Now reply with exactly the single word PING and stop.' },
      {
        must: true,
        summary: (d) => `runId=${d?.runId} runStatus=${d?.runStatus}`,
      },
    );
    followupRunId = s10a.structured?.runId;
    findings.followupRunId = followupRunId;
    // Deliberately NO sleep: we want the first follow-up run to still be active.
    const s10b = await call(
      '10b',
      'send_followup',
      { agentId, prompt: 'And now reply with the single word PONG.' },
      { expectError: true },
    );
    findings.agentBusy = { outcome: s10b.outcome, text: s10b.text, runId: s10b.structured?.runId };
    if (!s10b.isError) {
      findings.notes.push(
        `Second send_followup unexpectedly SUCCEEDED (race: first follow-up run had already finished). New runId=${s10b.structured?.runId}`,
      );
    }
    await sleep(1500);

    // --------------------------------------------------------------- step 11
    if (followupRunId !== undefined) {
      const s11a = await call('11a', 'cancel_run', { agentId, runId: followupRunId }, {
        summary: (d) => `cancelled id=${d?.id}`,
      });
      findings.cancel = { outcome: s11a.outcome, text: s11a.isError ? s11a.text : undefined, structured: s11a.structured };
      await sleep(1200);
      const s11b = await call('11b', 'wait_for_run', { agentId, runId: followupRunId, maxWaitMs: 30000 }, {
        must: true,
        summary: (d) => `status=${d?.runStatus} isTerminal=${d?.isTerminal} elapsedMs=${d?.elapsedMs} events=${d?.eventCount} result=${JSON.stringify(d?.result ?? null).slice(0, 200)}`,
      });
      findings.waitForRun = {
        runStatus: s11b.structured?.runStatus,
        isTerminal: s11b.structured?.isTerminal,
        elapsedMs: s11b.structured?.elapsedMs,
        eventCount: s11b.structured?.eventCount,
        streamExpired: s11b.structured?.streamExpired,
        cursorInvalid: s11b.structured?.cursorInvalid,
      };
    }
    await sleep(1500);

    // --------------------------------------------------------------- step 12
    const s12 = await call(
      '12',
      'get_run_events',
      { agentId, runId: firstRunId, afterEventId: 'not-a-real-id', maxWaitMs: 5000 },
      {
        summary: (d) => `cursorInvalid=${d?.cursorInvalid} streamExpired=${d?.streamExpired} eventCount=${d?.eventCount} status=${d?.runStatus} isTerminal=${d?.isTerminal}`,
      },
    );
    findings.badCursor = {
      outcome: s12.outcome,
      isError: s12.isError,
      text: s12.isError ? s12.text : undefined,
      cursorInvalid: s12.structured?.cursorInvalid,
      streamExpired: s12.structured?.streamExpired,
      eventCount: s12.structured?.eventCount,
      runStatus: s12.structured?.runStatus,
      hint: s12.structured?.hint,
    };
    await sleep(1500);

    // --------------------------------------------------------------- step 13
    const s13 = await call('13', 'get_run_events', { agentId, runId: firstRunId, maxWaitMs: 5000 }, {
      must: true,
      summary: (d) => `replay eventCount=${d?.eventCount} types=[${[...new Set((d?.events ?? []).map((e) => e.type))].join(',')}] isTerminal=${d?.isTerminal} streamExpired=${d?.streamExpired} status=${d?.runStatus} retention=${d?.retentionSeconds}`,
    });
    findings.replay = {
      eventCount: s13.structured?.eventCount,
      eventTypes: [...new Set((s13.structured?.events ?? []).map((e) => e.type))],
      isTerminal: s13.structured?.isTerminal,
      streamExpired: s13.structured?.streamExpired,
      runStatus: s13.structured?.runStatus,
      retentionSeconds: s13.structured?.retentionSeconds,
    };
    await sleep(1500);

    // --------------------------------------------------------------- step 14
    const s14 = await call(
      '14',
      'get_run',
      { agentId, runId: 'run-00000000-0000-0000-0000-000000000000' },
      { expectError: true },
    );
    findings.runNotFound = { outcome: s14.outcome, text: s14.text };
    await sleep(1500);

    // --------------------------------------------------------------- step 15
    await call('15a', 'archive_agent', { agentId }, { must: true, summary: (d) => `id=${d?.id} archived=${d?.archived}` });
    await sleep(1200);
    const s15b = await call('15b', 'get_agent', { agentId }, {
      must: true,
      summary: (d) => `status=${d?.agent?.status}`,
    });
    findings.statusAfterArchive = s15b.structured?.agent?.status;
    await sleep(1200);
    const s15c = await call(
      '15c',
      'send_followup',
      { agentId, prompt: 'This should be refused because the agent is archived.' },
      { expectError: true },
    );
    findings.agentArchived = { outcome: s15c.outcome, text: s15c.text };
    if (!s15c.isError) {
      findings.notes.push('send_followup to an ARCHIVED agent unexpectedly succeeded.');
      followupRunId = s15c.structured?.runId ?? followupRunId;
    }
    await sleep(1200);
    await call('15d', 'unarchive_agent', { agentId }, { must: true, summary: (d) => `id=${d?.id} archived=${d?.archived}` });
    await sleep(1200);
    const s15e = await call('15e', 'get_agent', { agentId }, {
      must: true,
      summary: (d) => `status=${d?.agent?.status}`,
    });
    findings.statusAfterUnarchive = s15e.structured?.agent?.status;
  } catch (error) {
    line(`FATAL: ${redact(error?.stack ?? String(error))}`);
    findings.notes.push(`FATAL: ${redact(error?.message ?? String(error))}`);
    mustFailCount += 1;
  } finally {
    // --------------------------------------------------------------- step 16
    try {
      if (client !== undefined && agentId !== undefined) {
        await sleep(1500);
        await call('16a', 'delete_agent', { agentId, confirm: true }, {
          must: true,
          summary: (d) => `id=${d?.id} deleted=${d?.deleted}`,
        });
        await sleep(1500);
        const s16b = await call('16b', 'get_agent', { agentId }, { expectError: true });
        findings.deletedThenNotFound = { outcome: s16b.outcome, text: s16b.text };
      } else if (agentId !== undefined) {
        line(`CLEANUP WARNING: agent ${agentId} may still exist (no client).`);
      }
    } catch (error) {
      line(`CLEANUP FAILED: ${redact(error?.stack ?? String(error))}`);
      findings.notes.push(`CLEANUP FAILED: ${redact(error?.message ?? String(error))}`);
      mustFailCount += 1;
    }

    // ------------------------------------------------------------- reporting
    const traceLines = stderrBuffer.split('\n').filter((l) => l.startsWith('[http-trace]'));
    const byPath = {};
    for (const l of traceLines) {
      const m = /\[http-trace\] (\w+) (\S+) -> (\S+)/.exec(l);
      if (!m) continue;
      let p = m[2];
      try {
        p = `${m[1]} ${new URL(m[2]).pathname}`;
      } catch {}
      byPath[p] = (byPath[p] ?? 0) + 1;
    }
    findings.http = {
      traceEnabled: TRACE_ENABLED,
      totalRequests: traceLines.length,
      byPathAndMethod: byPath,
      statusCounts: traceLines.reduce((acc, l) => {
        const m = /-> (\S+) \(/.exec(l);
        if (m) acc[m[1]] = (acc[m[1]] ?? 0) + 1;
        return acc;
      }, {}),
      count429: traceLines.filter((l) => l.includes('-> 429')).length,
      serverRetryLines: stderrBuffer.split('\n').filter((l) => l.includes('retrying after')),
      serverLogsHttpRequestsAtDebug: false,
      keyLeakOccurrencesInChildStderr: keyLeakOccurrences,
    };
    findings.finishedAt = new Date().toISOString();
    findings.mustPassFailures = mustFailCount;
    findings.outcomeByStep = steps.map((s) => ({ step: s.step, tool: s.tool, outcome: s.outcome, ms: s.ms }));

    fs.writeFileSync(
      TRANSCRIPT,
      redact(JSON.stringify({ findings, transcript }, null, 2)),
      'utf8',
    );

    line('');
    line('================ SUMMARY ================');
    for (const s of steps) line(`  ${String(s.step).padEnd(6)} ${String(s.tool).padEnd(20)} ${s.outcome}`);
    line(`  total HTTP requests (fetch trace): ${findings.http.totalRequests}`);
    line(`  429s: ${findings.http.count429}   server retry lines: ${findings.http.serverRetryLines.length}`);
    line(`  crsr_ occurrences seen in child stderr (pre-redaction): ${keyLeakOccurrences}`);
    line(`  must-pass failures: ${mustFailCount}`);
    line(`  transcript: ${TRANSCRIPT}`);
    line(`  stderr log: ${STDERR_LOG}`);

    try {
      await client?.close();
    } catch {}
    try {
      stderrStream.end();
    } catch {}
    if (tracerPath !== undefined) {
      try {
        fs.rmSync(path.dirname(tracerPath), { recursive: true, force: true });
      } catch {}
    }
    process.exitCode = mustFailCount > 0 ? 1 : 0;
  }
}

await main();
