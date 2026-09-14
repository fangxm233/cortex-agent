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
