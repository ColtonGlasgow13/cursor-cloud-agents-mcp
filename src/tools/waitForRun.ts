import { z } from 'zod';
import { NetworkError } from '../client/errors.js';
import type { CursorClient } from '../client/index.js';
import type { Run } from '../client/types.js';
import { isTerminalRunStatus, withErrorHandling, type RegisterToolArgs, type ToolData } from './shared.js';

export const DEFAULT_WAIT_MS = 55_000;
export const POLL_INTERVAL_MS = 5_000;

export const waitForRunInput = {
  agentId: z.string().min(1).describe('Agent id.'),
  runId: z.string().min(1).describe('Run id.'),
  maxWaitMs: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .describe('Total polling deadline, 1000-120000 ms. Default 55000.'),
};

interface WaitForRunArgs {
  agentId: string;
  runId: string;
  maxWaitMs?: number;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function sleepWhileActive(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal === undefined) {
    await sleep(ms);
    return true;
  }
  if (signal.aborted) return false;
  let removeAbort = (): void => {};
  const aborted = new Promise<false>((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([sleep(ms).then(() => true as const), aborted]);
  } finally {
    removeAbort();
  }
}

export async function runWaitForRun({
  client,
  input,
  now = Date.now,
  sleep = (ms) => new Promise<void>((resolve) => void setTimeout(resolve, ms)),
  signal,
}: {
  client: CursorClient;
  input: WaitForRunArgs;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<ToolData> {
  const startedAt = now();
  const deadline = startedAt + (input.maxWaitMs ?? DEFAULT_WAIT_MS);
  let run: Run | undefined;
  let pollCount = 0;

  while (now() < deadline && !isAborted(signal)) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, deadline - now()));
    try {
      run = await client.getRun({
        agentId: input.agentId,
        runId: input.runId,
        signal: controller.signal,
        deadlineMs: deadline,
      });
      pollCount += 1;
    } catch (error) {
      if (!(error instanceof NetworkError && controller.signal.aborted && !isAborted(signal) && run !== undefined)) {
        throw error;
      }
      break;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }

    if (isTerminalRunStatus(run.status)) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    if (!(await sleepWhileActive(Math.min(POLL_INTERVAL_MS, remaining), sleep, signal))) break;
  }

  if (run === undefined) {
    throw new NetworkError({ message: 'wait_for_run ended before a run snapshot was received.' });
  }

  return {
    run,
    isTerminal: isTerminalRunStatus(run.status),
    elapsedMs: now() - startedAt,
    pollCount,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

export function registerWaitForRun({ server, client }: RegisterToolArgs): void {
  server.registerTool(
    'wait_for_run',
    {
      title: 'Wait for a run',
      description:
        'Polls GET run every 5 seconds until Cursor reports FINISHED, ERROR, CANCELLED, or EXPIRED, or until maxWaitMs expires. Returns the latest complete run record and minimal wait metadata. Each request and sleep is part of the deadline; Cursor API errors are not suppressed.',
      inputSchema: waitForRunInput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withErrorHandling(() => runWaitForRun({ client, input, signal: extra.signal })),
  );
}
