// input:  core agent types and normalized subagent attribution
// output: RunPhase, AttemptLabel and the phased RunEvent union
// pos:    Backend-neutral run event vocabulary shared by engine sessions and the run layer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type {
  AgentResult, ChatNoticeLevel, ContextUsage, NoticeAction, TodoSnapshot,
} from '@core/types/agent-types.js';
import type { ToolUseSubagent } from './normalize/event-types.js';

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
      // Notices are synthesized by the facade (rate-limit hold, compaction, fallback) and reach the
      // transcript through the same `onAssistantMessage` callback as ordinary prose. They are part
      // of the event so the transcript sink can persist/publish them identically; `NormalizedEvent`
      // never sets them.
      noticeLevel?: ChatNoticeLevel; noticeAction?: NoticeAction;
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
  | { type: 'foreground_result'; result: AgentResult }
  | { type: 'background_result'; result: AgentResult }
  | { type: 'error'; message: string; fatal: boolean };
