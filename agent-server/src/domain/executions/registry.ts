import { executionRepo } from '@store/execution-repo.js';
import { runRegistry, type RunningExecution } from '@core/run-registry.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { TerminalRunStatus } from '../runs/run.js';

export type { ExecutionRecord } from '@store/execution-repo.js';

// --- Sync reads ---

export function getExecution(id: string) {
  return executionRepo.getExecution(id);
}

export function getAll() {
  return executionRepo.getAll();
}

export function getRunningExecutions() {
  return executionRepo.getRunningExecutions();
}

// --- Sync create/mutate + fire-and-forget persist ---

export function startLocalExecution(opts: Parameters<typeof executionRepo.startLocalExecution>[0]) {
  return executionRepo.startLocalExecution(opts);
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

/** What a rate-limited run's record says about why it failed. */
function rateLimitReason(result: AgentResult | null | undefined): string {
  const detail = result?.rateLimitMessage;
  return detail ? `Rate limited: ${detail}` : 'Rate limited';
}

/**
 * Close an execution across BOTH ledgers in one call: finalize the persistent record
 * (idempotent — terminal status is guarded in execution-repo) and tear down the in-memory
 * live registry while publishing the matching agent.* lifecycle event.
 *
 * This is the single teardown every execution path should funnel through so the persistent
 * status, the live registry, and the bus events never drift apart — and the one place a run's
 * terminal status becomes a record status. Every branch keeps the cost and turns the run reported:
 * a cancelled or failed run has still spent what it spent. A rate-limited run is filed as `failed`
 * (the record's status set is shared with released clients) with the rate limit as its error.
 *
 * Does NOT touch the busy-tracker — trackPendingTask(±1) is per-enqueue, so it stays managed by
 * the caller.
 */
export function teardownExecution({ executionId, status, result, error, durationS }: {
  executionId: string | null;
  status: TerminalRunStatus;
  result?: AgentResult | null;
  error?: { message?: string } | null;
  durationS: number;
}) {
  if (!executionId) return null;
  const metrics = {
    costUsd: result?.total_cost_usd, numTurns: result?.num_turns, durationS,
    finalOutput: result?.finalOutput || null,
  };
  let rec;
  if (status === 'completed') {
    rec = completeExecution(executionId, metrics);
    runRegistry.complete(executionId, result?.total_cost_usd ?? 0);
  } else if (status === 'cancelled') {
    rec = cancelExecution(executionId, metrics);
    // The kill already happened on the cancel path; supersede() publishes agent.superseded
    // and removes the entry (a second kill() is harmless).
    runRegistry.supersede(executionId, 'cancelled');
  } else {
    const reason = status === 'rate-limited'
      ? error?.message || rateLimitReason(result)
      : error?.message || null;
    rec = failExecution(executionId, { ...metrics, error: reason });
    runRegistry.fail(executionId, reason ?? 'error');
  }
  return rec;
}

/**
 * Stop one live execution at a user's request. A registered run cancels itself, so its own
 * terminal handler closes the record — with the duration and whatever it had already spent. Only
 * an entry with no run is torn down here.
 */
export function stopLiveExecution(entry: RunningExecution): void {
  if (entry.run?.cancel) {
    entry.run.cancel('user');
    return;
  }
  if (entry.executionId) teardownExecution({ executionId: entry.executionId, status: 'cancelled', durationS: 0 });
  else runRegistry.killById(entry.registryKey);
}

// --- Async operations ---

export async function markMissingRunningExecutionsStale(keepRunning?: Parameters<typeof executionRepo.markMissingRunningExecutionsStale>[0]) {
  const staled = await executionRepo.markMissingRunningExecutionsStale(keepRunning);
  return staled;
}
