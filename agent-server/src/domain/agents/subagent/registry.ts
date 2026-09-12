// input:  a started `agent` invocation, its abort controller and its completion promise
// output: the daemon-wide table of live and recently finished subagent runs
// pos:    Lifecycle of one `agent` call, foreground or background
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { randomBytes } from 'node:crypto';
import { createLogger } from '@core/log.js';
import type { SubagentToolResult } from './orchestrate.js';
import type { Invocation, SubagentMode } from './types.js';

const log = createLogger('subagent-registry');

/**
 * How long a finished run stays readable after it ends.
 *
 * A foreground caller collects the moment the run settles, so this window exists for the
 * backgrounded case: the parent turn may have to be restarted to receive the result, and it must
 * still be there when it comes back.
 */
export const FINISHED_RUN_TTL_MS = 30 * 60 * 1000;

/** The longest a single `wait` blocks before answering "still running". Bounded so the caller's
 *  loopback request never outlives the MCP infrastructure deadline. */
export const WAIT_SLICE_MS = 25 * 1000;

/**
 * How long a foreground run may go unwaited before it is abandoned and stopped.
 *
 * A foreground caller is an MCP sidecar polling in {@link WAIT_SLICE_MS} hops. If its turn is
 * killed the sidecar dies with it and simply stops asking — nothing else would ever tell the
 * daemon, and the children would keep spending tokens for an answer no one can receive. Three
 * missed hops is the signal. Background runs are exempt: nobody is waiting on them by design.
 */
export const FOREGROUND_ABANDON_MS = 3 * WAIT_SLICE_MS;

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** Everything about a run that is safe to hand back across the webhook. */
export interface SubagentRunView {
  id: string;
  status: SubagentRunStatus;
  background: boolean;
  mode: SubagentMode;
  /** One-line summary of what was delegated, for `agent_stop` and status surfaces. */
  descriptions: string[];
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

interface SubagentRunRecord extends SubagentRunView {
  abort: AbortController;
  /** Resolves when the run reaches a terminal state. Never rejects. */
  settled: Promise<void>;
  result: SubagentToolResult | null;
  /** Set the instant a stop is requested, so an abort that surfaces as an ordinary error is still
   *  reported as `stopped` rather than `failed`. */
  stopRequested: boolean;
  /** Last time a foreground caller asked about this run. See {@link FOREGROUND_ABANDON_MS}. */
  lastWaitAt: number;
}

export interface StartSubagentRunOptions {
  invocation: Invocation;
  /** Owning Cortex session; null for a run with no session to deliver back to. */
  sessionId: string | null;
  background: boolean;
  /** Runs the invocation. Receives the registry's abort signal and the run id, which doubles as
   *  the attribution block key for the children it starts. */
  execute: (signal: AbortSignal, runId: string) => Promise<SubagentToolResult>;
  /** Called exactly once when the run settles, with the terminal view. Background delivery hooks
   *  in here; a foreground caller ignores it and reads the result from its own wait. */
  onSettled?: (view: SubagentRunView, result: SubagentToolResult | null) => void;
}

const runs = new Map<string, SubagentRunRecord>();

function mintRunId(): string {
  return `sa_${randomBytes(6).toString('hex')}`;
}

function viewOf(record: SubagentRunRecord): SubagentRunView {
  return {
    id: record.id,
    status: record.status,
    background: record.background,
    mode: record.mode,
    descriptions: record.descriptions,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    error: record.error,
  };
}

/** Drop finished runs nobody collected. Called on every mutation, so the table cannot grow
 *  without bound in a daemon that runs for weeks. */
function pruneFinished(now: number): void {
  for (const [id, record] of runs) {
    if (record.status !== 'running' && record.endedAt !== null && now - record.endedAt > FINISHED_RUN_TTL_MS) {
      runs.delete(id);
    }
  }
}

function settle(
  record: SubagentRunRecord,
  status: SubagentRunStatus,
  result: SubagentToolResult | null,
  error: string | null,
  onSettled?: StartSubagentRunOptions['onSettled'],
): void {
  record.status = status;
  record.result = result;
  record.error = error;
  record.endedAt = Date.now();
  pruneFinished(record.endedAt);
  if (!onSettled) return;
  try {
    onSettled(viewOf(record), result);
  } catch (settleError) {
    log.error(`Subagent run ${record.id} settle hook failed: ${(settleError as Error).message}`);
  }
}

/**
 * Register a run and start it. Returns as soon as the run is registered — never waits for it, so
 * the foreground and background paths differ only in what the caller does next.
 */
export function startSubagentRun(options: StartSubagentRunOptions): SubagentRunView {
  const now = Date.now();
  pruneFinished(now);
  const record: SubagentRunRecord = {
    id: mintRunId(),
    status: 'running',
    background: options.background,
    mode: options.invocation.mode,
    descriptions: options.invocation.tasks.map(task => task.description),
    sessionId: options.sessionId,
    startedAt: now,
    endedAt: null,
    error: null,
    abort: new AbortController(),
    settled: Promise.resolve(),
    result: null,
    stopRequested: false,
    lastWaitAt: now,
  };
  runs.set(record.id, record);
  if (!options.background) armAbandonSweep();
  // Started inside the same tick so a `wait` issued immediately after cannot miss the settle.
  record.settled = options.execute(record.abort.signal, record.id).then(
    result => settle(record, 'completed', result, null, options.onSettled),
    error => settle(
      record,
      record.stopRequested ? 'stopped' : 'failed',
      null,
      error instanceof Error ? error.message : String(error),
      options.onSettled,
    ),
  );
  return viewOf(record);
}

export function getSubagentRun(id: string): SubagentRunView | null {
  const record = runs.get(id);
  return record ? viewOf(record) : null;
}

/** Live and recently finished runs, newest first. Scoped to one session when asked. */
export function listSubagentRuns(sessionId?: string | null): SubagentRunView[] {
  const all = [...runs.values()]
    .filter(record => sessionId === undefined || record.sessionId === sessionId)
    .map(viewOf);
  return all.sort((left, right) => right.startedAt - left.startedAt);
}

export interface SubagentRunOutcome {
  view: SubagentRunView;
  /** Present only once the run has completed successfully. */
  result: SubagentToolResult | null;
}

/**
 * Wait up to `sliceMs` for a run to settle, then answer with whatever state it is in.
 *
 * The slice is the point: a caller polls in bounded hops instead of holding one request open for
 * the length of the run, so neither side depends on a socket surviving minutes of silence.
 */
export async function waitForSubagentRun(
  id: string,
  sliceMs: number = WAIT_SLICE_MS,
): Promise<SubagentRunOutcome | null> {
  const record = runs.get(id);
  if (!record) return null;
  record.lastWaitAt = Date.now();
  if (record.status === 'running') {
    let timer: NodeJS.Timeout | undefined;
    const slice = new Promise<void>((resolve) => { timer = setTimeout(resolve, sliceMs); });
    try {
      await Promise.race([record.settled, slice]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { view: viewOf(record), result: record.result };
}

/** Request a stop. Idempotent, and a no-op on a run that has already finished. */
export function stopSubagentRun(id: string): SubagentRunView | null {
  const record = runs.get(id);
  if (!record) return null;
  if (record.status === 'running' && !record.stopRequested) {
    record.stopRequested = true;
    record.abort.abort();
  }
  return viewOf(record);
}

/** Stop every run a session owns. Used when its turn is killed or its session ends. */
export function stopSubagentRunsForSession(sessionId: string): number {
  let stopped = 0;
  for (const record of runs.values()) {
    if (record.sessionId === sessionId && record.status === 'running') {
      stopSubagentRun(record.id);
      stopped++;
    }
  }
  return stopped;
}

// --- Abandonment sweep ---

let sweepTimer: NodeJS.Timeout | null = null;

function sweepAbandoned(): void {
  const now = Date.now();
  let live = 0;
  for (const record of runs.values()) {
    if (record.status !== 'running' || record.background) continue;
    if (now - record.lastWaitAt > FOREGROUND_ABANDON_MS) {
      log.warn(`Stopping subagent run ${record.id}: no caller has waited on it for ${FOREGROUND_ABANDON_MS}ms`);
      stopSubagentRun(record.id);
      continue;
    }
    live++;
  }
  if (live === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Started on the first foreground run and stopped once none are left, so an idle daemon holds no
 *  timer. Unref'd: this must never be the reason a process stays alive. */
function armAbandonSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepAbandoned, WAIT_SLICE_MS);
  sweepTimer.unref?.();
}

/** Test seam: drop every record. */
export function _resetSubagentRuns(): void {
  runs.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
