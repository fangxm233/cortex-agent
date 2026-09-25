// input:  ExecutionRepo singleton (store/execution-repo.ts)
// output: named function exports matching the pre-migration API surface, with lock-release side effect on terminal transitions
// pos:    thin re-export layer — delegates to ExecutionRepo. Maintains backward compat for all import sites.
//         Lock-release: every terminal transition (complete/fail/cancel/stale) auto-releases any task lock held by the executionId.
//         releaseExecutionLocks(id) exposes the same release for the thread SUSPEND path (thread_wait) WITHOUT ending the execution (DR-0014 lock hygiene).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { executionRepo, TERMINAL_STATUSES } from '@store/execution-repo.js';
import { PROJECTS_DIR } from '@core/utils.js';
import { releaseLock, releaseLockAsync } from '@domain/tasks/system/task-lock.js';
import { parseTasksFileWithLock } from '@core/task-parser.js';
import { createLogger } from '@core/log.js';
import { runRegistry } from '@core/run-registry.js';
import type { AgentResult } from '@core/types/agent-types.js';

export type { ExecutionRecord, DispatchInfo } from '@store/execution-repo.js';
export { TERMINAL_STATUSES };

const lockLog = createLogger('execution-lock-release');

/** Project directories that currently have a TASKS.yaml. One readdir, no per-project stat. */
function projectsWithTasksFile(): Array<{ project: string; tasksPath: string }> {
  let names: string[];
  try {
    names = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
  const out: Array<{ project: string; tasksPath: string }> = [];
  for (const project of names) {
    const tasksPath = path.join(PROJECTS_DIR, project, 'TASKS.yaml');
    if (fs.existsSync(tasksPath)) out.push({ project, tasksPath });
  }
  return out;
}

/** Release any task locks still owned by `executionId` after its agent finished.
 *  Idempotent — `releaseLock` returns success on absent or non-matching locks.
 *
 *  The lock lives inside TASKS.yaml, so a project whose file does not even mention the execution
 *  id cannot hold a matching lock. Reading + substring-scanning the ~22 task files costs ~0.4ms;
 *  YAML-parsing all of them costs ~20ms (measured), so the parse is deferred to the rare match.
 *  This function stays sync because terminal transitions (and their tests) are sync; event-loop-
 *  sensitive callers use `releaseLocksOwnedByAsync` instead. */
function releaseLocksOwnedBy(executionId: string | null | undefined): void {
  if (!executionId) return;
  for (const { project, tasksPath } of projectsWithTasksFile()) {
    let content: string;
    try { content = fs.readFileSync(tasksPath, 'utf8'); } catch { continue; }
    if (!content.includes(executionId)) continue;
    let lock;
    try { lock = parseTasksFileWithLock(content, project).lock; } catch { continue; }
    if (!lock || lock.owner !== executionId) continue;
    try {
      const r = releaseLock(project, executionId);
      if (r.released) {
        lockLog.warn(
          `auto-released stale lock on '${project}' held by execution ${executionId} ` +
          `(agent finished without calling cortex-task lock-release)`,
        );
      }
    } catch (err: any) {
      lockLog.warn(`release attempt failed for ${project} / ${executionId}: ${err?.message || err}`);
    }
  }
}

/** Async twin of `releaseLocksOwnedBy`: no sync fs and no sync mutation-lock wait, so an
 *  event-loop-sensitive caller (thread suspend, stale reconciliation) never parks the process on a
 *  contended cross-process lock. Same pre-filter, same owner-match semantics, same logging. */
async function releaseLocksOwnedByAsync(executionId: string | null | undefined): Promise<void> {
  if (!executionId) return;
  let projects: string[];
  try {
    projects = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return; }

  for (const project of projects) {
    let content: string;
    try { content = await fsp.readFile(path.join(PROJECTS_DIR, project, 'TASKS.yaml'), 'utf8'); }
    catch { continue; }
    if (!content.includes(executionId)) continue;
    let lock;
    try { lock = parseTasksFileWithLock(content, project).lock; } catch { continue; }
    if (!lock || lock.owner !== executionId) continue;
    try {
      const r = await releaseLockAsync(project, executionId);
      if (r.released) {
        lockLog.warn(
          `auto-released stale lock on '${project}' held by execution ${executionId} ` +
          `(agent finished without calling cortex-task lock-release)`,
        );
      }
    } catch (err: any) {
      lockLog.warn(`release attempt failed for ${project} / ${executionId}: ${err?.message || err}`);
    }
  }
}

/** Release any task locks owned by `executionId` WITHOUT ending the execution.
 *  Used by the thread suspend path (DR-0014): a manager that acquired a project lock
 *  (e.g. `cortex-task decompose --auto-lock`, which does not auto-release) and then calls
 *  thread_wait must release BEFORE yielding. Otherwise the lock is held for the entire
 *  child-wait window (starving sibling managers' decomposes), and the terminal auto-release
 *  cannot recover it because re-entry completes under a NEW executionId that no longer matches
 *  the original lock owner — leaking the lock until its 20-min TTL expires. Idempotent. */
export function releaseExecutionLocks(executionId: string | null | undefined): void {
  releaseLocksOwnedBy(executionId);
}

/** Async twin of `releaseExecutionLocks` for event-loop-sensitive callers (thread suspend path). */
export async function releaseExecutionLocksAsync(executionId: string | null | undefined): Promise<void> {
  await releaseLocksOwnedByAsync(executionId);
}

// --- Sync reads ---

export function getExecution(id: string) {
  return executionRepo.getExecution(id);
}

export function getExecutionByTaskId(taskId: string | null | undefined) {
  return executionRepo.getExecutionByTaskId(taskId);
}

export function getAll() {
  return executionRepo.getAll();
}

export function getRunningExecutions() {
  return executionRepo.getRunningExecutions();
}

export function findRunningDispatchMatch(opts: Parameters<typeof executionRepo.findRunningDispatchMatch>[0]) {
  return executionRepo.findRunningDispatchMatch(opts);
}

// --- Sync create/mutate + fire-and-forget persist ---

export function startLocalExecution(opts: Parameters<typeof executionRepo.startLocalExecution>[0]) {
  return executionRepo.startLocalExecution(opts);
}

export function registerDispatchExecution(opts: Parameters<typeof executionRepo.registerDispatchExecution>[0]) {
  return executionRepo.registerDispatchExecution(opts);
}

export function touchExecution(id: string, patch?: Parameters<typeof executionRepo.touchExecution>[1]) {
  return executionRepo.touchExecution(id, patch);
}

export function completeExecution(id: string, metrics?: Parameters<typeof executionRepo.completeExecution>[1]) {
  const r = executionRepo.completeExecution(id, metrics);
  if (r && TERMINAL_STATUSES.has(r.status)) releaseLocksOwnedBy(id);
  return r;
}

export function completeExecutionByTaskId(taskId: string, metrics?: Parameters<typeof executionRepo.completeExecutionByTaskId>[1]) {
  const record = executionRepo.getExecutionByTaskId(taskId);
  if (!record) return null;
  return completeExecution(record.id, metrics);
}

export function failExecution(id: string, metrics?: Parameters<typeof executionRepo.failExecution>[1]) {
  const r = executionRepo.failExecution(id, metrics);
  if (r && TERMINAL_STATUSES.has(r.status)) releaseLocksOwnedBy(id);
  return r;
}

export function failExecutionByTaskId(taskId: string, metrics?: Parameters<typeof executionRepo.failExecutionByTaskId>[1]) {
  const record = executionRepo.getExecutionByTaskId(taskId);
  if (!record) return null;
  return failExecution(record.id, metrics);
}

export function cancelExecution(id: string, metrics?: Parameters<typeof executionRepo.cancelExecution>[1]) {
  const r = executionRepo.cancelExecution(id, metrics);
  if (r && TERMINAL_STATUSES.has(r.status)) releaseLocksOwnedBy(id);
  return r;
}

export function cancelExecutionByTaskId(taskId: string, metrics?: Parameters<typeof executionRepo.cancelExecutionByTaskId>[1]) {
  const record = executionRepo.getExecutionByTaskId(taskId);
  if (!record) return null;
  return cancelExecution(record.id, metrics);
}

/**
 * Close an execution across BOTH ledgers in one call: finalize the persistent record
 * (idempotent — terminal status is guarded in execution-repo) and tear down the in-memory
 * live registry while publishing the matching agent.* lifecycle event.
 *
 * This is the single teardown every execution path should funnel through so the persistent
 * status, the live registry, and the bus events never drift apart. In particular it gives
 * thread steps their agent.completed/failed events, which the old event-less remove() skipped.
 *
 * Does NOT touch the busy-tracker — trackPendingTask(±1) is per-enqueue (a thread spans many
 * steps under one +1), so it stays managed by the caller.
 */
export function teardownExecution({ executionId, status, result, error, durationS, costUsd }: {
  executionId: string | null;
  status: 'completed' | 'failed' | 'cancelled';
  result?: AgentResult | null;
  error?: { message?: string } | null;
  durationS: number;
  costUsd?: number;
}) {
  if (!executionId) return null;
  let rec;
  if (status === 'completed') {
    rec = completeExecution(executionId, {
      costUsd: result?.total_cost_usd, numTurns: result?.num_turns, durationS, finalOutput: result?.finalOutput || null,
    });
    runRegistry.complete(executionId, costUsd ?? result?.total_cost_usd ?? 0);
  } else if (status === 'cancelled') {
    rec = cancelExecution(executionId, { durationS });
    // The kill already happened on the cancel path; supersede() publishes agent.superseded
    // and removes the entry (a second kill() is harmless).
    runRegistry.supersede(executionId, 'cancelled');
  } else {
    rec = failExecution(executionId, { durationS, error: error?.message || null });
    runRegistry.fail(executionId, error?.message ?? 'error');
  }
  return rec;
}

// --- Async operations ---

export async function markMissingRunningExecutionsStale(keepRunning?: Parameters<typeof executionRepo.markMissingRunningExecutionsStale>[0]) {
  const staled = await executionRepo.markMissingRunningExecutionsStale(keepRunning);
  for (const id of staled) await releaseLocksOwnedByAsync(id);
  return staled;
}

export async function reconcileStaleDispatches(opts: Parameters<typeof executionRepo.reconcileStaleDispatches>[0]) {
  const { count, staled } = await executionRepo.reconcileStaleDispatches(opts);
  for (const id of staled) await releaseLocksOwnedByAsync(id);
  return count;
}

// --- Deprecated ---

/** @deprecated ExecutionRepo uses in-memory Map; cache clearing is a no-op. */
export function clearExecutionCache(): void {
  // no-op: ExecutionRepo does not use module-level cache
}
