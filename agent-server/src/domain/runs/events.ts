// input:  ContinuationSink (agent-adapter), RunEvent/RunPhase (agent-adapter/run-events)
// output: RunEvent re-exports plus pure ContinuationSink → RunEvent translation
// pos:    Run layer's consumer of the backend-neutral event vocabulary; the union and the
//         NormalizedEvent translation live in agent-adapter/run-events.ts so the engine contract
//         can name them without importing domain.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContinuationSink } from '../../agent-adapter/types.js';
import { sinkToRunEvents } from '../../agent-adapter/continuation-phase.js';
import type { RunEvent } from '../../agent-adapter/run-events.js';

export type { AttemptLabel, RunEvent, RunPhase } from '../../agent-adapter/run-events.js';
export { toRunEvent } from '../../agent-adapter/run-events.js';

/**
 * The run-layer view of a continuation turn: the engine's `sinkToRunEvents` plus the two members
 * that are control flow there — `onTurnOpen` reports the phase boundary with the last known counts,
 * and `onResult` closes the phase with the authoritative result. Held by the legacy
 * `facade.runAgent` path (the engine's own `ContinuationPhase` owns these for a real run).
 */
export function continuationSinkToEvents(emit: (event: RunEvent) => void): ContinuationSink {
  // `onTurnOpen` fires before the continuation turn's result, so the phase event reports the most
  // recent counts (0 until the first background_result arrives).
  let pendingBackground = 0;
  let undeliveredBackground = 0;
  return {
    ...sinkToRunEvents(emit),
    onTurnOpen: () => {
      emit({ type: 'phase', phase: 'background', pendingBackground, undeliveredBackground });
    },
    onResult: (result) => {
      pendingBackground = result.pendingBackgroundTasks ?? 0;
      undeliveredBackground = result.undeliveredBackgroundTasks ?? 0;
      emit({ type: 'background_result', result });
    },
  };
}
