// input:  ThreadDetail DTOs
// output: exact step-to-cortex-run attribution
// pos:    Shared pure selectors for thread detail/card surfaces
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadDispatchInfo,
} from '@cortex-agent/ui-contract';

/** Cortex-runs attributed to the exact launch step. */
export function dispatchesForStep(
  detail: ThreadDetail,
  step: ThreadStepDetail,
): ThreadDispatchInfo[] {
  return detail.dispatches.filter((run) => run.stepIndex === step.stepIndex);
}
