// input:  per-message PI usage records and per-child totals
// output: zeroed, turn-accumulated and cross-child aggregated SubagentUsage
// pos:    Subagent accounting arithmetic
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SubagentResult, SubagentUsage } from './types.js';

export function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Turns within one child: context is the latest reading, not a sum. */
export function addTurnUsage(target: SubagentUsage, source: SubagentUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.contextTokens = source.contextTokens || target.contextTokens;
  target.turns += source.turns;
}

/** Across children: every context window is its own, so these do add up. */
export function addChildUsage(target: SubagentUsage, source: SubagentUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.contextTokens += source.contextTokens;
  target.turns += source.turns;
}

export function aggregateUsage(results: SubagentResult[]): SubagentUsage {
  const total = emptyUsage();
  for (const result of results) addChildUsage(total, result.usage);
  return total;
}
