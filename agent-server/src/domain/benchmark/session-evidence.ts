//
// Which sessions are production benchmark sessions, and the trial facts each one runs under. The
// benchmark launcher starts a session through its webhook and binds the context here; every turn
// of that session then opens its runs with the context, so each attempt is frozen and journaled.
// In memory only: a trial's server lives exactly as long as its one session.

import type { ProductionBenchmarkEvidenceContext } from './benchmark-types.js';

const bound = new Map<string, ProductionBenchmarkEvidenceContext>();
const outputCaps = new Map<string, number>();

/** Bind `context` to `sessionId`. A trial run (trial id + root run id) owns exactly one session. */
export function bindSessionEvidenceContext(
  sessionId: string, context: ProductionBenchmarkEvidenceContext, benchmarkMaxOutputTokens?: number,
): void {
  const owner = sessionForRun(context.trial_id, context.root_run_id);
  if (owner && owner !== sessionId) {
    throw new Error(`trial run ${context.trial_id}/${context.root_run_id} already has a session`);
  }
  bound.set(sessionId, context);
  if (benchmarkMaxOutputTokens !== undefined) outputCaps.set(sessionId, benchmarkMaxOutputTokens);
}

export function sessionEvidenceContext(sessionId: string): ProductionBenchmarkEvidenceContext | null {
  return bound.get(sessionId) ?? null;
}

export function sessionBenchmarkMaxOutputTokens(sessionId: string): number | undefined {
  return outputCaps.get(sessionId);
}

export function sessionForRun(trialId: string, rootRunId: string): string | null {
  for (const [sessionId, context] of bound) {
    if (context.trial_id === trialId && context.root_run_id === rootRunId) return sessionId;
  }
  return null;
}

export function _resetSessionEvidence(): void {
  bound.clear();
  outputCaps.clear();
}
