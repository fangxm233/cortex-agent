// input:  the closed five-member proposal decision record, both variants
// output: the per-variant verdict table, the four-conjunct complete guard and five typed blocks
// pos:    Variant proposal decision tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  variantProposal, VERDICT_BY_VARIANT,
  type ProposalDecisionInput, type ProposalStopReason, type ProposalTerminalState,
} from '../../../src/domain/benchmark/variant-proposal.js';

const TERMINAL_STATES: ProposalTerminalState[] = ['completed', 'failed', 'cancelled', 'timeout'];
const STOP_REASONS: ProposalStopReason[] = [
  'converged', 'max_iterations', 'cost_limit', 'no_matching_transition',
  'admission_limit', 'unavailable',
];

/** The one shape that satisfies all four conjuncts, per variant. Every test below perturbs
 *  exactly one member of it, so each block reason is attributable to that member alone. */
function approving(variant: keyof typeof VERDICT_BY_VARIANT): ProposalDecisionInput {
  const row = VERDICT_BY_VARIANT[variant];
  return {
    variant,
    terminalState: 'completed',
    finalStep: { agentSlotId: row.slot, stage: 'terminal-stage', index: 3 },
    finalAssistantText: `the audit stands. ${row.marker}`,
    stopReason: 'converged',
  };
}

it('binds each variant to its own terminal slot and its own marker', () => {
  assert.deepEqual(Object.keys(VERDICT_BY_VARIANT).sort(), ['audit-retry', 'reviewer-fix']);
  assert.deepEqual(VERDICT_BY_VARIANT['audit-retry'], {
    slot: 'benchmark-reviewer', marker: '[IMPL-APPROVED]',
  });
  assert.deepEqual(VERDICT_BY_VARIANT['reviewer-fix'], {
    slot: 'benchmark-fixer', marker: '[FIX-VERIFIED]',
  });
  // Two variants, two markers and two slots: neither variant's verdict can satisfy the other's
  // contract, and neither marker can be matched by the other's convergence rule.
  assert.notEqual(VERDICT_BY_VARIANT['audit-retry'].marker, VERDICT_BY_VARIANT['reviewer-fix'].marker);
  assert.notEqual(VERDICT_BY_VARIANT['audit-retry'].slot, VERDICT_BY_VARIANT['reviewer-fix'].slot);
});

it('completes each variant only on its own marker at its own slot', () => {
  assert.deepEqual(variantProposal(approving('audit-retry')), { kind: 'complete' });
  assert.deepEqual(variantProposal(approving('reviewer-fix')), { kind: 'complete' });
});

it('refuses one variant a verdict written in the other variant\'s terms', () => {
  const auditRetry = approving('audit-retry');
  assert.deepEqual(
    variantProposal({ ...auditRetry, finalAssistantText: 'done [FIX-VERIFIED]' }),
    { kind: 'block', reason: 'verdict_marker_absent' },
  );
  const reviewerFix = approving('reviewer-fix');
  assert.deepEqual(
    variantProposal({ ...reviewerFix, finalAssistantText: 'done [IMPL-APPROVED]' }),
    { kind: 'block', reason: 'verdict_marker_absent' },
  );
  // The other variant's slot is equally not a substitute for this one's.
  assert.deepEqual(
    variantProposal({
      ...auditRetry, finalStep: { agentSlotId: 'benchmark-fixer', stage: 'auditFix', index: 1 },
    }),
    { kind: 'block', reason: 'wrong_terminal_slot' },
  );
});

it('blocks every terminal state that is not a completed thread', () => {
  for (const terminalState of TERMINAL_STATES.filter(state => state !== 'completed')) {
    assert.deepEqual(
      variantProposal({ ...approving('audit-retry'), terminalState }),
      { kind: 'block', reason: 'thread_not_completed' }, terminalState,
    );
  }
});

it('blocks a run whose last step is not the variant\'s verdict slot', () => {
  assert.deepEqual(
    variantProposal({
      ...approving('audit-retry'),
      finalStep: { agentSlotId: 'benchmark-coder', stage: 'retry', index: 2 },
    }),
    { kind: 'block', reason: 'wrong_terminal_slot' },
  );
  // A run that executed no step at all has no verdict slot either.
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), finalStep: null }),
    { kind: 'block', reason: 'wrong_terminal_slot' },
  );
});

it('keeps a missing verdict text distinct from a verdict that withholds the marker', () => {
  // A dropped event and a reviewer that declined to approve are different facts about the run,
  // and an operator reading the block reason needs exactly this distinction.
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), finalAssistantText: null }),
    { kind: 'block', reason: 'verdict_text_unavailable' },
  );
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), finalAssistantText: '' }),
    { kind: 'block', reason: 'verdict_marker_absent' },
  );
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), finalAssistantText: 'blockers remain' }),
    { kind: 'block', reason: 'verdict_marker_absent' },
  );
});

it('blocks an approval the loop only reached by exhausting its iterations', () => {
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), stopReason: 'max_iterations' }),
    { kind: 'block', reason: 'iterations_exhausted' },
  );
  // Every other stop reason leaves a real approval standing.
  for (const stopReason of STOP_REASONS.filter(reason => reason !== 'max_iterations')) {
    assert.deepEqual(
      variantProposal({ ...approving('audit-retry'), stopReason }), { kind: 'complete' }, stopReason,
    );
  }
});

it('reports the missing verdict before the exhausted iterations that caused it', () => {
  // Both conjuncts fail on an audit-retry run that never converged. The verdict's absence is the
  // fact the operator acts on; the exhausted budget is how the loop noticed.
  assert.deepEqual(
    variantProposal({
      ...approving('audit-retry'),
      finalAssistantText: 'the remaining blockers stand',
      stopReason: 'max_iterations',
    }),
    { kind: 'block', reason: 'verdict_marker_absent' },
  );
});

it('makes block the default arm over the whole input space', () => {
  const variants = ['audit-retry', 'reviewer-fix'] as const;
  const slots = [null, 'benchmark-coder', 'benchmark-reviewer', 'benchmark-fixer'];
  const texts = [null, '', 'no verdict', 'yes [IMPL-APPROVED]', 'yes [FIX-VERIFIED]'];
  const reasons = new Set<string>();
  let completes = 0;
  for (const variant of variants) {
    for (const terminalState of TERMINAL_STATES) {
      for (const slot of slots) {
        for (const finalAssistantText of texts) {
          for (const stopReason of STOP_REASONS) {
            const intent = variantProposal({
              variant, terminalState, finalAssistantText, stopReason,
              finalStep: slot === null ? null : { agentSlotId: slot, stage: null, index: 0 },
            });
            if (intent.kind === 'complete') {
              // Every completion is the exact conjunction, never an accident of the default path.
              completes += 1;
              assert.equal(terminalState, 'completed');
              assert.equal(slot, VERDICT_BY_VARIANT[variant].slot);
              assert.ok(finalAssistantText?.includes(VERDICT_BY_VARIANT[variant].marker));
              assert.notEqual(stopReason, 'max_iterations');
            } else {
              reasons.add(intent.reason);
            }
          }
        }
      }
    }
  }
  assert.equal(completes, 2 * 1 * 1 * 1 * (STOP_REASONS.length - 1));
  assert.deepEqual([...reasons].sort(), [
    'iterations_exhausted', 'thread_not_completed', 'verdict_marker_absent',
    'verdict_text_unavailable', 'wrong_terminal_slot',
  ]);
});

it('degrades an unknown terminal state or stop reason to block rather than to approval', () => {
  // A state or reason added later must not widen the approval: complete is the guarded arm.
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), terminalState: 'sealed' as ProposalTerminalState }),
    { kind: 'block', reason: 'thread_not_completed' },
  );
  // The completing arm names the stop reasons it accepts, so a reason added later cannot walk
  // through the `!== max_iterations` gap and turn an unclassified stop into an approval.
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), stopReason: 'answer_frozen' as ProposalStopReason }),
    { kind: 'block', reason: 'iterations_exhausted' },
  );
  assert.deepEqual(
    variantProposal({ ...approving('audit-retry'), variant: 'manager' as 'audit-retry' }),
    { kind: 'block', reason: 'wrong_terminal_slot' },
  );
});

it('returns the same intent for the same input and mutates nothing it is given', () => {
  const input = approving('audit-retry');
  const snapshot = JSON.stringify(input);

  const first = variantProposal(input);
  const second = variantProposal(input);

  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'each call returns its own intent object');
  assert.equal(JSON.stringify(input), snapshot);
});
