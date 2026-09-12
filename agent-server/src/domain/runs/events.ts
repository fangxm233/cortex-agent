// input:  NormalizedEvent + ContinuationSink (agent-adapter), RunEvent (agent-adapter), RunResult (./request)
// output: RunPhase/RunEvent re-exports plus pure NormalizedEvent/ContinuationSink translation
// pos:    Run layer's consumer of the backend-neutral event vocabulary; the union itself lives in
//         agent-adapter/run-events.ts so the engine contract can name it without importing domain.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContinuationSink } from '../../agent-adapter/types.js';
import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import type { RunEvent, RunPhase } from '../../agent-adapter/run-events.js';
import type { RunResult } from './request.js';

export type { AttemptLabel, RunEvent, RunPhase } from '../../agent-adapter/run-events.js';

/** Compile-time guard: a future `NormalizedEvent` member makes `toRunEvent` fail to typecheck
 *  instead of silently falling through. */
function unhandled(event: never): never {
  throw new Error(`Unhandled NormalizedEvent: ${JSON.stringify(event)}`);
}

/**
 * `NormalizedEvent.turn_complete` is the stream's terminal marker and carries only the turn count
 * and cost; the authoritative `AgentResult` is returned by `AgentProcess.send()` /
 * `ContinuationSink.onResult`. `RunEvent`'s result kinds are typed to carry a full `RunResult`
 * (plan §3.3), so the fields the marker cannot supply degrade to their absent values. The run layer
 * (P1.3) must prefer the resolved `send()` result when it needs an authoritative one.
 */
function resultFromTurnComplete(
  event: Extract<NormalizedEvent, { type: 'turn_complete' }>,
): RunResult {
  return {
    sessionId: null,
    total_cost_usd: event.totalCostUsd,
    num_turns: event.numTurns,
    rateLimited: false,
    rateLimitMessage: null,
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
    finalOutput: null,
  };
}

/** Total translation of the current `NormalizedEvent` union into a phased `RunEvent`. */
export function toRunEvent(event: NormalizedEvent, phase: RunPhase): RunEvent {
  switch (event.type) {
    case 'session_started':
      return {
        type: 'engine_started',
        backendSessionId: event.sessionId,
        ...(event.sessionFile !== undefined ? { sessionFile: event.sessionFile } : {}),
      };
    case 'assistant_text':
      return { ...event, phase };
    case 'assistant_delta':
      return { ...event, phase };
    case 'tool_use':
      return { ...event, phase };
    case 'tool_result':
      return { ...event, phase };
    case 'todo_update':
      return { ...event, phase };
    case 'ask_user_question':
      return {
        type: 'dialog_request',
        dialogId: event.toolUseId,
        kind: 'ask_user',
        payload: event.questions,
      };
    case 'plan_mode_entered':
      return { ...event, phase };
    case 'plan_written':
      return { ...event, phase };
    case 'context_compacted':
      return { ...event, phase };
    case 'model_fallback':
      return { ...event, phase };
    case 'context_usage':
      return { ...event, phase };
    case 'rate_limit':
      return { type: 'rate_limit', raw: event.raw };
    case 'cost_record':
      return { ...event };
    case 'turn_progress':
      return { ...event };
    case 'turn_complete':
      return phase === 'background'
        ? { type: 'background_result', result: resultFromTurnComplete(event) }
        : { type: 'foreground_result', result: resultFromTurnComplete(event) };
    case 'subagent_activity':
      return { ...event, phase };
    case 'subagent_end':
      return { ...event, phase };
    case 'error':
      return { ...event };
    default:
      return unhandled(event);
  }
}

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
