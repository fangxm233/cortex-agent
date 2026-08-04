// input:  the trial's absolute deadline, a PI abort signal and a progress callback
// output: explicit MCP RequestOptions bounding one benchmark tool call
// pos:    PI MCP duration contract (design §5.6 P2–P7)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';

/** The trial deadline as an absolute epoch. A duration cannot cross a process boundary and stay
 *  honest, so the child is handed the instant and derives its budget at the moment of use (P5). */
export const PI_BENCHMARK_DEADLINE_ENV = 'CORTEX_BENCHMARK_DEADLINE_EPOCH_MS';

/**
 * P3: `SUPERVISOR_GRACE_MS + QUIESCENCE_MARGIN_MS` — the same window the shipped quiescence budget
 * uses. An MCP call outlives the deadline by exactly the interval in which finalization may run, so
 * a tool that is still answering when the deadline lands is cut off with the trial, not before it.
 */
export const MCP_CLEANUP_GRACE_MS = 1_000 + 5_000;

/**
 * P7: the interval at which a running call is expected to report progress. Strictly below the SDK's
 * 60 000 ms reference window — four beats per window leaves three missed beats of tolerance before a
 * client on the default timeout would give up.
 */
export const MCP_PROGRESS_HEARTBEAT_MS = 15_000;

/**
 * P5: the remaining trial budget, recomputed on every read. Returns null when this process carries
 * no trial deadline, which is the daemon case — an absent deadline is not a budget of zero and not
 * an unbounded one, it is the absence of a bound this module may impose.
 */
export function remainingTrialMs(
  env: NodeJS.ProcessEnv,
  nowEpochMs: number = Date.now(),
): number | null {
  const raw = env[PI_BENCHMARK_DEADLINE_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const deadlineEpochMs = Number(raw);
  if (!Number.isFinite(deadlineEpochMs)) return null;
  return Math.max(0, deadlineEpochMs - nowEpochMs);
}

/**
 * P2/P4/P6: the options every benchmark `callTool` carries. `timeout` and `maxTotalTimeout` are the
 * same value, so `resetTimeoutOnProgress` can keep a live call from expiring mid-answer while
 * heartbeats still cannot push it past deadline + grace.
 */
export function benchmarkCallOptions(
  remainingMs: number,
  signal?: AbortSignal,
  onprogress?: RequestOptions['onprogress'],
): RequestOptions {
  const budgetMs = remainingMs + MCP_CLEANUP_GRACE_MS;
  return {
    timeout: budgetMs,
    maxTotalTimeout: budgetMs,
    resetTimeoutOnProgress: true,
    ...(signal ? { signal } : {}),
    ...(onprogress ? { onprogress } : {}),
  };
}
