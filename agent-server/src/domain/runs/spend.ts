import type { RunEvent } from '../../agent-adapter/run-events.js';
import type { RunResult } from './request.js';

/** What a run, or one attempt of it, spent. Null where nothing was reported. */
export interface RunSpend {
  costUsd: number | null;
  numTurns: number | null;
}

export const NO_SPEND: Readonly<RunSpend> = Object.freeze({ costUsd: null, numTurns: null });

/** Null-aware sum: a part that reported nothing adds nothing, and two silent parts stay silent. */
function plus(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : a + b;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function addSpend(a: RunSpend, b: RunSpend): RunSpend {
  return { costUsd: plus(a.costUsd, b.costUsd), numTurns: plus(a.numTurns, b.numTurns) };
}

export function spendOfResult(result: RunResult): RunSpend {
  return { costUsd: finite(result.total_cost_usd), numTurns: finite(result.num_turns) };
}

/**
 * Fold one event of an attempt's stream into what that attempt has spent: every cost row (the
 * same rows the ledger records) and its latest turn count. This is how an attempt that ends with
 * no result of its own — failed or stopped — still accounts for its spend.
 */
export function countSpend(spend: RunSpend, event: RunEvent): void {
  if (event.type === 'cost_record') {
    spend.costUsd = plus(spend.costUsd, finite(event.cost_usd));
  } else if (event.type === 'turn_progress') {
    const turns = finite(event.numTurns);
    if (turns !== null) spend.numTurns = Math.max(spend.numTurns ?? 0, turns);
  }
}
