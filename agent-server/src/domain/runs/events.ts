// input:  NormalizedEvent + ContinuationSink (agent-adapter) and RunResult (./request)
// output: RunPhase, RunEvent union, and pure NormalizedEvent/ContinuationSink translation
// pos:    Backend-neutral run event vocabulary — the single stream Phase 1 funnels every
//         foreground/background signal through. Pure types + pure functions, no callers changed.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContextUsage, TodoSnapshot } from '@core/types/agent-types.js';
import type { ContinuationSink } from '../../agent-adapter/types.js';
import type { NormalizedEvent, ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import type { RunResult } from './request.js';

/** Where in the run's lifetime an event was produced.
 *  - `foreground` — the awaited turn the caller asked for.
 *  - `background` — a continuation turn the backend opened after the foreground result
 *    (Claude background tasks, PI deferred completion, post-result injected messages).
 *  - `done` — terminal bookkeeping after every background task has settled. */
export type RunPhase = 'foreground' | 'background' | 'done';

/** Opaque label identifying one attempt of the fallback chain, e.g. `model/mode`.
 *  The plan sketches `run_fallback` with this type but does not define it; declared here so the
 *  event union is self-contained until `domain/runs/run.ts` (P1.3) owns the real shape. */
export type AttemptLabel = string;

/** The one event union every run produces. Passthrough kinds keep the exact field names of the
 *  `NormalizedEvent` member they translate from and add a `phase` tag; the remaining kinds are the
 *  run's own vocabulary (dialogs, injections, accounting, fallback, terminal results). */
export type RunEvent =
  | { type: 'engine_started'; backendSessionId: string; sessionFile?: string }
  | { type: 'phase'; phase: RunPhase; pendingBackground: number; undeliveredBackground: number }
  | {
      type: 'assistant_text'; text: string; blockId?: string; model?: string | null;
      subagent?: ToolUseSubagent; phase: RunPhase;
    }
  | { type: 'assistant_delta'; text: string; blockId: string; phase: RunPhase }
  | {
      type: 'tool_use'; toolUseId: string; name: string; input: unknown;
      subagent?: ToolUseSubagent; phase: RunPhase;
    }
  | {
      type: 'tool_result'; toolUseId: string; ok: boolean; content: string;
      subagent?: ToolUseSubagent; phase: RunPhase;
    }
  | { type: 'todo_update'; toolUseId: string; snapshot: TodoSnapshot; phase: RunPhase }
  | ({ type: 'context_usage'; phase: RunPhase } & ContextUsage)
  | { type: 'context_compacted'; trigger: string; preTokens?: number; phase: RunPhase }
  | { type: 'model_fallback'; originalModel: string; fallbackModel: string; phase: RunPhase }
  | {
      type: 'subagent_activity'; parentToolUseId: string; subagentType: string | null;
      kind: 'assistant' | 'tool_result'; phase: RunPhase;
    }
  | {
      type: 'subagent_end'; parentToolUseId: string;
      status: 'completed' | 'failed' | 'killed'; phase: RunPhase;
    }
  | { type: 'plan_written'; toolUseId: string; path: string; content: string; phase: RunPhase }
  | { type: 'plan_mode_entered'; toolUseId: string; planFilePath: string; phase: RunPhase }
  | {
      type: 'dialog_request'; dialogId: string;
      kind: 'ask_user' | 'plan_approval' | 'select' | 'confirm' | 'input'; payload: unknown;
    }
  | { type: 'injection_delivered'; injectionId: string; foldedIntoTurn: boolean }
  | { type: 'injection_rejected'; injectionId: string; reason: string }
  // provider/mode are optional because the legacy NormalizedEvent.rate_limit carries neither; the
  // Phase 2 adapter always sets them.
  | { type: 'rate_limit'; provider?: string; mode?: string; raw: unknown }
  | { type: 'quota'; provider: string; raw: unknown }
  | {
      type: 'cost_record'; provider: string; model: string;
      /** Legacy backend-specific input metric retained for compatibility. */
      tokens_in: number | null; tokens_out: number | null;
      /** Exact prompt total when the backend reports every input category. */
      prompt_tokens?: number | null; cached_tokens?: number | null;
      input_tokens: number | null; output_tokens: number | null;
      cache_read_tokens: number | null; cache_creation_tokens: number | null;
      provider_requests: number | null; cost_usd: number | null;
    }
  | { type: 'turn_progress'; numTurns: number }
  | { type: 'run_fallback'; from: AttemptLabel; to: AttemptLabel; reason: string }
  | { type: 'foreground_result'; result: RunResult }
  | { type: 'background_result'; result: RunResult }
  | { type: 'error'; message: string; fatal: boolean };

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
