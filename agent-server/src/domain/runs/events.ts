// input:  ContinuationSink (agent-adapter), RunEvent/RunPhase (agent-adapter/run-events)
// output: RunEvent re-exports plus pure ContinuationSink → RunEvent translation
// pos:    Run layer's consumer of the backend-neutral event vocabulary; the union and the
//         NormalizedEvent translation live in agent-adapter/run-events.ts so the engine contract
//         can name them without importing domain.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContinuationSink } from '../../agent-adapter/types.js';
import type { RunEvent } from '../../agent-adapter/run-events.js';

export type { AttemptLabel, RunEvent, RunPhase } from '../../agent-adapter/run-events.js';
export { toRunEvent } from '../../agent-adapter/run-events.js';

/**
 * Adapt today's `ContinuationSink` callbacks into the same `RunEvent` stream, tagged
 * `phase: 'background'`. Phase 1 installs this on the legacy agent process so the new run layer can
 * observe continuation turns without a second callback protocol.
 */
export function continuationSinkToEvents(emit: (event: RunEvent) => void): ContinuationSink {
  // `onTurnOpen` fires before the continuation turn's result, so the phase event reports the most
  // recent counts (0 until the first background_result arrives).
  let pendingBackground = 0;
  let undeliveredBackground = 0;
  return {
    onTurnOpen: () => {
      emit({ type: 'phase', phase: 'background', pendingBackground, undeliveredBackground });
    },
    onAssistantText: (text, model, subagent) => {
      emit({
        type: 'assistant_text', text, phase: 'background',
        ...(model !== undefined ? { model } : {}),
        ...(subagent !== undefined ? { subagent } : {}),
      });
    },
    onToolUse: (name, input, toolUseId, subagent) => {
      emit({
        type: 'tool_use', toolUseId: toolUseId ?? '', name, input, phase: 'background',
        ...(subagent !== undefined ? { subagent } : {}),
      });
    },
    onToolResult: (toolUseId, content, isError, subagent) => {
      emit({
        type: 'tool_result', toolUseId, ok: !isError, content, phase: 'background',
        ...(subagent !== undefined ? { subagent } : {}),
      });
    },
    onContextUsage: (usage) => {
      emit({ type: 'context_usage', ...usage, phase: 'background' });
    },
    onSubagentEnd: (parentToolUseId, status) => {
      emit({ type: 'subagent_end', parentToolUseId, status, phase: 'background' });
    },
    onResult: (result) => {
      pendingBackground = result.pendingBackgroundTasks ?? 0;
      undeliveredBackground = result.undeliveredBackgroundTasks ?? 0;
      emit({ type: 'background_result', result });
    },
  };
}
