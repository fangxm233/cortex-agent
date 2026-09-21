//
// Hot-rebuild progress: the supervisor's view of its own pipeline, written where the app can read it.
//
// The daemon runs build → install → restart in its own process, and the last step kills the app
// that would otherwise hold this state in memory. So the record lives in a file: the daemon is the
// only writer, `system.daemonStatus` is the only reader, and a freshly restarted app can still say
// what the rebuild it was born from did. The same phases go down the fork IPC channel
// (`entry/daemon-notice.ts`) because the turn gate needs them without waiting for a poll.
//
// Steps are planned up front and flipped in place, so the reader always knows the total and never
// has to guess whether a missing step is pending or skipped.
//

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from './paths.js';
import { atomicWriteSync } from './atomic-write.js';

/** Where the supervisor publishes its pipeline state. */
export const REBUILD_PROGRESS_FILE = path.join(STORE_DIR, 'daemon-rebuild.json');

/** The pipeline's fixed step vocabulary. `install` covers both install paths (fast sync vs
 *  pack + `npm install -g`); which one ran is in the step's `detail`. */
export type RebuildStepName = 'server' | 'ui-contract' | 'web' | 'install' | 'restart';

export type RebuildStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RebuildStepState {
  name: RebuildStepName;
  status: RebuildStepStatus;
  /** Free-text qualifier for a finished step ('fast', 'pack + install -g', 'exit 1'). */
  detail: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export type RebuildStatus = 'running' | 'succeeded' | 'aborted';

export interface RebuildProgress {
  status: RebuildStatus;
  /** What triggered the pipeline, verbatim from the watcher ('src change: core/foo.ts'). */
  reason: string;
  /** The step in flight, or null once terminal. */
  current: RebuildStepName | null;
  steps: RebuildStepState[];
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Why it aborted, in the same words the operator notice uses. Null unless aborted. */
  detail: string | null;
  /** The supervisor that owns this record. Lets a reader discard a record left `running` by a
   *  daemon that is no longer alive. */
  daemonPid: number;
}

/** A step list in pipeline order. `names` comes from the caller because which packages exist is
 *  a property of the checkout, not of this module. */
export function planRebuildProgress(p: {
  reason: string;
  names: RebuildStepName[];
  daemonPid: number;
  now?: () => Date;
}): RebuildProgress {
  const ts = (p.now ?? (() => new Date()))().toISOString();
  return {
    status: 'running',
    reason: p.reason,
    current: null,
    steps: p.names.map((name) => ({ name, status: 'pending', detail: null, startedAt: null, endedAt: null })),
    startedAt: ts,
    updatedAt: ts,
    endedAt: null,
    detail: null,
    daemonPid: p.daemonPid,
  };
}

function patchStep(
  progress: RebuildProgress,
  name: RebuildStepName,
  patch: Partial<RebuildStepState>,
  ts: string,
): RebuildProgress {
  return {
    ...progress,
    updatedAt: ts,
    steps: progress.steps.map((step) => (step.name === name ? { ...step, ...patch } : step)),
  };
}

/** Mark a step as in flight. A step that is not in the plan is ignored rather than invented —
 *  the plan is what the reader renders a total from. */
export function startRebuildStep(
  progress: RebuildProgress,
  name: RebuildStepName,
  now: () => Date = () => new Date(),
): RebuildProgress {
  const ts = now().toISOString();
  return { ...patchStep(progress, name, { status: 'running', startedAt: ts, endedAt: null }, ts), current: name };
}

/** Close a step. `status` is the step's own outcome; the pipeline's outcome is set separately,
 *  because a failed step and an aborted pipeline are recorded by different callers. */
export function finishRebuildStep(
  progress: RebuildProgress,
  name: RebuildStepName,
  status: Extract<RebuildStepStatus, 'done' | 'failed' | 'skipped'>,
  detail: string | null = null,
  now: () => Date = () => new Date(),
): RebuildProgress {
  const ts = now().toISOString();
  const next = patchStep(progress, name, { status, detail, endedAt: ts }, ts);
  return { ...next, current: next.current === name ? null : next.current };
}

/** Terminal state. Any step still `pending` becomes `skipped`, so a reader never shows a step as
 *  "waiting" for a pipeline that has stopped. */
export function settleRebuildProgress(
  progress: RebuildProgress,
  status: Extract<RebuildStatus, 'succeeded' | 'aborted'>,
  detail: string | null = null,
  now: () => Date = () => new Date(),
): RebuildProgress {
  const ts = now().toISOString();
  return {
    ...progress,
    status,
    current: null,
    detail,
    updatedAt: ts,
    endedAt: ts,
    steps: progress.steps.map((step) => (step.status === 'pending' ? { ...step, status: 'skipped' } : step)),
  };
}

/** Shallow structural check. The file is machine-written, so this only has to reject a truncated
 *  or hand-edited record rather than validate every field. */
function isRebuildProgress(value: unknown): value is RebuildProgress {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === 'string'
    && typeof v.reason === 'string'
    && typeof v.startedAt === 'string'
    && Array.isArray(v.steps);
}

/** Read the published record, or null when there is none / it is unreadable. Never throws: a
 *  missing or corrupt progress file must not take the daemon-status query down with it. */
export function readRebuildProgress(file = REBUILD_PROGRESS_FILE): RebuildProgress | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isRebuildProgress(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Publish the record. Best-effort by design: losing a progress write must never abort a rebuild
 *  that is otherwise fine, so the caller gets a boolean instead of an exception. */
export function writeRebuildProgress(progress: RebuildProgress, file = REBUILD_PROGRESS_FILE): boolean {
  try {
    atomicWriteSync(file, JSON.stringify(progress, null, 2));
    return true;
  } catch {
    return false;
  }
}
