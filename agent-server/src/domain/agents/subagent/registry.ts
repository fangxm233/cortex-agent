import { randomBytes } from 'node:crypto';
import { createLogger } from '@core/log.js';
import type { SubagentToolResult } from '@core/agents/subagent/orchestrate.js';
import type { Invocation, SubagentMode } from '@core/agents/subagent/types.js';

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
 * How long a foreground run may go unwaited before it is abandoned.
 *
 * A foreground caller is an MCP sidecar polling in {@link WAIT_SLICE_MS} hops. If its turn is
 * killed the sidecar dies with it and simply stops asking — nothing else would ever tell the
 * daemon. Three missed hops is the signal. Background runs are exempt: nobody is waiting on them
 * by design.
 *
 * What happens next is {@link StartSubagentRunOptions.onAbandon}'s call. When the work can still
 * be delivered somewhere it is adopted into the background and keeps going; when it cannot, the
 * run is stopped, because children spending tokens for an answer no one can receive is waste.
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
  /** Kept for the sweep, which runs long after the start call returned. */
  onAbandon?: StartSubagentRunOptions['onAbandon'];
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
  /**
   * Last word before a run nobody waits on is killed. Returning true means the caller has taken
   * responsibility for the result — the run is flipped to background and left to finish; false (or
   * no hook at all) keeps today's behaviour and stops it.
   *
   * Only foreground runs can reach here, and only once per run: after the flip the sweep skips it.
   */
  onAbandon?: (view: SubagentRunView) => boolean;
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
    onAbandon: options.onAbandon,
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

/**
 * Offer a waiterless run to its `onAbandon` hook. True means it was taken: the run becomes a
 * background one and is exempt from the sweep from here on, so the offer is made at most once.
 */
function adoptRun(record: SubagentRunRecord): boolean {
  let adopted = false;
  try {
    adopted = record.onAbandon?.(viewOf(record)) === true;
  } catch (error) {
    // The hook owns delivery, not the run. A broken hook means nobody can collect the result,
    // which is exactly the case the caller falls back to stopping for.
    log.error(`Subagent run ${record.id} abandon hook failed: ${(error as Error).message}`);
    return false;
  }
  if (adopted) record.background = true;
  return adopted;
}

function sweepAbandoned(): void {
  const now = Date.now();
  let live = 0;
  for (const record of runs.values()) {
    if (record.status !== 'running' || record.background) continue;
    if (now - record.lastWaitAt > FOREGROUND_ABANDON_MS) {
      if (adoptRun(record)) {
        log.info(`Subagent run ${record.id} adopted into the background: no caller has waited on it for ${FOREGROUND_ABANDON_MS}ms`);
        continue;
      }
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

/**
 * Adopt a run into the background on request, without waiting for the sweep.
 *
 * The foreground tool calls this when it gives up on its own deadline — it knows it is about to
 * stop waiting, so there is no reason to make the run sit through three silent hops first.
 *
 * Null only when there is no such run. A run that has already finished, or is already in the
 * background, comes back as-is: both are the answer the caller wanted anyway. A run whose hook
 * declines adoption also comes back as-is, still in the foreground, and the sweep decides its fate
 * on the usual schedule.
 */
export function detachSubagentRun(id: string): SubagentRunView | null {
  const record = runs.get(id);
  if (!record) return null;
  if (record.status === 'running' && !record.background && adoptRun(record)) {
    log.info(`Subagent run ${record.id} adopted into the background at its caller's request`);
  }
  return viewOf(record);
}

/** Started on the first foreground run and stopped once none are left, so an idle daemon holds no
 *  timer. Unref'd: this must never be the reason a process stays alive. */
function armAbandonSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepAbandoned, WAIT_SLICE_MS);
  sweepTimer.unref?.();
}

/** Test seam: run the abandonment sweep now, instead of waiting out a real interval. */
export function _sweepAbandonedForTest(): void {
  sweepAbandoned();
}

/** Test seam: drop every record. */
export function _resetSubagentRuns(): void {
  runs.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
