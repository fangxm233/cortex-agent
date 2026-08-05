// input:  a coder-review variant and the five facts its pipeline thread ended with
// output: a complete or typed-block proposal intent, decided and never applied
// pos:    The coder-review variant proposal decision
// >>> If I am updated, update my header and folder CORTEX.md <<<

import type { AgentSlotId } from '../../core/types/thread-types.js';
import type { CoderReviewVariant } from './arm-schema.js';

/** The pipeline thread's committed terminal state. */
export type ProposalTerminalState = 'completed' | 'failed' | 'cancelled' | 'timeout';

/** Why the step loop ended. The first four are the transition engine's own typed reasons; the
 *  last two are the orchestrator's, for a loop the engine never got to judge. */
export type ProposalStopReason =
  | 'converged'
  | 'max_iterations'
  | 'cost_limit'
  | 'no_matching_transition'
  | 'admission_limit'
  | 'unavailable';

/** The last step actually executed. Null when the thread executed none. */
export interface ProposalFinalStep {
  agentSlotId: AgentSlotId;
  stage: string | null;
  index: number;
}

/** Closed: five members and nothing else. The verdict text is the final step's last assistant
 *  message from the journal stream — never the artifact file, which accumulates every earlier
 *  step's text, and never the thread summary, which one backend never populates at all. */
export interface ProposalDecisionInput {
  variant: CoderReviewVariant;
  terminalState: ProposalTerminalState;
  finalStep: ProposalFinalStep | null;
  /** Null, not '', when the final step emitted no assistant message at all. */
  finalAssistantText: string | null;
  stopReason: ProposalStopReason;
}

export type ProposalBlockReason =
  | 'thread_not_completed'
  | 'wrong_terminal_slot'
  | 'verdict_text_unavailable'
  | 'verdict_marker_absent'
  | 'iterations_exhausted';

export type ProposalIntent =
  | { kind: 'complete' }
  | { kind: 'block'; reason: ProposalBlockReason };

/** Which slot speaks each variant's verdict, and in which literal. The markers differ so that one
 *  variant's approval can never satisfy the other's contract, nor be matched by the other's
 *  convergence rule. */
export const VERDICT_BY_VARIANT: Readonly<Record<
  CoderReviewVariant, Readonly<{ slot: AgentSlotId; marker: string }>
>> = Object.freeze({
  'audit-retry': Object.freeze({ slot: 'benchmark-reviewer', marker: '[IMPL-APPROVED]' }),
  'reviewer-fix': Object.freeze({ slot: 'benchmark-fixer', marker: '[FIX-VERIFIED]' }),
});

/** Named rather than written as `!== 'max_iterations'`: a stop reason added later must degrade to
 *  a block, and an exclusion test would silently admit it as an approval. */
const COMPLETABLE_STOP_REASONS: ReadonlySet<string> = new Set<ProposalStopReason>([
  'converged', 'cost_limit', 'no_matching_transition', 'admission_limit', 'unavailable',
]);

/**
 * What the pipeline concluded — and only that. Pure, total and synchronous: no clock, no store, no
 * filesystem, no broker call and no bus event. `block` is the default arm and `complete` the
 * guarded one, so an input this function does not recognise degrades to a block rather than to a
 * false approval.
 */
export function variantProposal(input: ProposalDecisionInput): ProposalIntent {
  const verdict = VERDICT_BY_VARIANT[input.variant];
  if (input.terminalState !== 'completed') return { kind: 'block', reason: 'thread_not_completed' };
  if (!verdict || input.finalStep?.agentSlotId !== verdict.slot) {
    return { kind: 'block', reason: 'wrong_terminal_slot' };
  }
  // A dropped assistant event and a verdict that withholds the marker both block, but they are
  // different facts about the run and only one of them is the model's decision.
  if (input.finalAssistantText === null) {
    return { kind: 'block', reason: 'verdict_text_unavailable' };
  }
  if (!input.finalAssistantText.includes(verdict.marker)) {
    return { kind: 'block', reason: 'verdict_marker_absent' };
  }
  if (!COMPLETABLE_STOP_REASONS.has(input.stopReason)) {
    return { kind: 'block', reason: 'iterations_exhausted' };
  }
  return { kind: 'complete' };
}
