import type { ExecutionRecord } from './execution-repo.js';

/**
 * Whole-session cumulative stats, as opposed to the LAST run's (`SessionInfo.numTurns/costUsd`).
 *
 * Deliberately asymmetric, because the three numbers do not compose the same way:
 *
 * - `turns` and `activeMs` count the session's OWN runs only. An Agent-tool child runs *inside* a
 *   parent turn, so adding its duration would double-count wall time, and adding its turns would
 *   inflate a number the user reads as "rounds in this conversation".
 * - `costUsd` DOES include those children: money is additive and never double-counted (parent and
 *   child bill to separate ledger entries). Leaving them out understated a real session by ~19%.
 *   `subagentCostUsd` exposes that share so the split is visible rather than folded in silently.
 */
export interface SessionTotals {
  /** Finished runs (completed, failed or cancelled). An in-flight turn is not counted — the status
   *  line's first segment already reports it live, and totals stay monotonic this way. */
  runs: number;
  /** Sum of those runs' `metrics.numTurns`. Agent-tool children excluded. */
  turns: number;
  /** Sum of those runs' `metrics.durationS`, in ms. Agent-tool children excluded (see above). */
  activeMs: number;
  /** Own runs + their Agent-tool children. Null only when no contributing run reported a cost. */
  costUsd: number | null;
  /** The part of `costUsd` spent by Agent-tool children. Null when none reported one. */
  subagentCostUsd: number | null;
}

/** Mutable accumulator. `*Samples` counts contributing records so "no data" stays distinct from
 *  "$0.00" — a session whose only run crashed before billing must show —, not a confident zero. */
export interface SessionTotalsAcc {
  runs: number;
  turns: number;
  activeMs: number;
  cost: number;
  costSamples: number;
  subCost: number;
  subSamples: number;
}

export function emptyTotalsAcc(): SessionTotalsAcc {
  return { runs: 0, turns: 0, activeMs: 0, cost: 0, costSamples: 0, subCost: 0, subSamples: 0 };
}

export function addTotalsAcc(into: SessionTotalsAcc, other: SessionTotalsAcc): SessionTotalsAcc {
  into.runs += other.runs;
  into.turns += other.turns;
  into.activeMs += other.activeMs;
  into.cost += other.cost;
  into.costSamples += other.costSamples;
  into.subCost += other.subCost;
  into.subSamples += other.subSamples;
  return into;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The record shape this module actually reads — kept structural so archived JSONL rows and test
 *  fixtures fold through the same rule as live registry records. */
export type ExecutionLike = Pick<ExecutionRecord, 'session' | 'thread' | 'runtime' | 'metrics'>;

/**
 * Which session, if any, a record's numbers belong to, and in which role.
 *
 * - `own`: the run IS that session's turn (`session.sessionId`).
 * - `subagent`: the run was spawned BY that session (`session.ownerSessionId`) and only its cost
 *   rolls up.
 *
 * Thread runs are excluded outright: a thread runs beside its parent and is accounted for in the
 * thread views, exactly as the last-run resolver already assumes. Unfinished runs are excluded so
 * a record can only ever be folded once, with final numbers.
 */
export function classifyForTotals(
  record: ExecutionLike,
): { sessionId: string; role: 'own' | 'subagent' } | null {
  if (record?.thread?.threadId) return null;
  if (!record?.runtime?.endedAt) return null;
  const own = record?.session?.sessionId;
  if (typeof own === 'string' && own) return { sessionId: own, role: 'own' };
  const owner = record?.session?.ownerSessionId;
  if (typeof owner === 'string' && owner) return { sessionId: owner, role: 'subagent' };
  return null;
}

/**
 * Fold one execution into a session-keyed accumulator map. Ignores records that belong to no
 * session (see {@link classifyForTotals}).
 *
 * `carriedThrough` is the archive watermark: a record that ended before it is already inside the
 * persisted carry, so folding it again from the live registry would double-count it. Only the live
 * pass passes this — the archive fold is what SETS the watermark.
 */
export function foldExecution(
  into: Map<string, SessionTotalsAcc>,
  record: ExecutionLike,
  carriedThrough?: string | null,
): void {
  const hit = classifyForTotals(record);
  if (!hit) return;
  if (carriedThrough && (record.runtime?.endedAt ?? '') < carriedThrough) return;
  let acc = into.get(hit.sessionId);
  if (!acc) into.set(hit.sessionId, acc = emptyTotalsAcc());
  const cost = finiteNumber(record.metrics?.costUsd);
  if (hit.role === 'subagent') {
    if (cost !== null) { acc.subCost += cost; acc.subSamples++; }
    return;
  }
  acc.runs++;
  const turns = finiteNumber(record.metrics?.numTurns);
  if (turns !== null) acc.turns += turns;
  const durationS = finiteNumber(record.metrics?.durationS);
  if (durationS !== null) acc.activeMs += Math.round(durationS * 1000);
  if (cost !== null) { acc.cost += cost; acc.costSamples++; }
}

/** Accumulator → DTO. Returns null for a session that contributed nothing at all, so the UI can
 *  tell "never ran" from "ran and cost nothing". */
export function toSessionTotals(acc: SessionTotalsAcc | undefined): SessionTotals | null {
  if (!acc) return null;
  if (acc.runs === 0 && acc.subSamples === 0) return null;
  const hasCost = acc.costSamples > 0 || acc.subSamples > 0;
  return {
    runs: acc.runs,
    turns: acc.turns,
    activeMs: acc.activeMs,
    costUsd: hasCost ? acc.cost + acc.subCost : null,
    subagentCostUsd: acc.subSamples > 0 ? acc.subCost : null,
  };
}
