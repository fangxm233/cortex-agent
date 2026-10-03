import { executionRepo } from '@store/execution-repo.js';
import { runRegistry } from '@core/run-registry.js';
import type { AgentResult } from '@core/types/agent-types.js';

export type { ExecutionRecord } from '@store/execution-repo.js';

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
  return r;
}

export function failExecution(id: string, metrics?: Parameters<typeof executionRepo.failExecution>[1]) {
  const r = executionRepo.failExecution(id, metrics);
  return r;
}

export function cancelExecution(id: string, metrics?: Parameters<typeof executionRepo.cancelExecution>[1]) {
  const r = executionRepo.cancelExecution(id, metrics);
  return r;
}

export function cancelExecutionByTaskId(taskId: string, metrics?: Parameters<typeof executionRepo.cancelExecution>[1]) {
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
export function teardownExecution({ executionId, status, result, error, durationS }: {
  executionId: string | null;
  status: 'completed' | 'failed' | 'cancelled';
  result?: AgentResult | null;
  error?: { message?: string } | null;
  durationS: number;
}) {
  if (!executionId) return null;
  let rec;
  if (status === 'completed') {
    rec = completeExecution(executionId, {
      costUsd: result?.total_cost_usd, numTurns: result?.num_turns, durationS, finalOutput: result?.finalOutput || null,
    });
    runRegistry.complete(executionId, result?.total_cost_usd ?? 0);
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
  return staled;
}

export async function reconcileStaleDispatches(opts: Parameters<typeof executionRepo.reconcileStaleDispatches>[0]) {
  const { count, staled } = await executionRepo.reconcileStaleDispatches(opts);
  return count;
}
