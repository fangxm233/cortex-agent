import type { ContextUsage, TodoSnapshot, ToolResultImage } from '@core/types/agent-types.js';

import type { ToolUseSubagent } from '@core/subagent-spawn.js';

export type { TodoItem, TodoSnapshot, TodoStatus } from '@core/types/agent-types.js';
export type { ToolUseSubagent } from '@core/subagent-spawn.js';

export interface QuestionSpec {
  question: string;
  multi?: boolean;
  options?: string[];
}

interface CostRecordEvent {
  type: 'cost_record';
  provider: string;
  model: string;
  /** Legacy backend-specific input metric retained for compatibility. */
  tokens_in: number | null;
  tokens_out: number | null;
  /** Exact prompt total when the backend reports every input category. */
  prompt_tokens?: number | null;
  cached_tokens?: number | null;
  /** Exact provider-reported token categories; null means unavailable, never inferred zero. */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  /** Positive observed request count, or null when the backend exposes no count. */
  provider_requests: number | null;
  cost_usd: number | null;
}

export type NormalizedEvent =
  | { type: 'session_started'; sessionId: string; sessionFile?: string }
  | { type: 'assistant_text'; text: string; blockId?: string; model?: string | null;
      /** Present only when a native subagent produced the text. See ToolUseSubagent. */
      subagent?: ToolUseSubagent }
  // No `subagent` member, deliberately: subagents never produce token-level deltas. The CLI's
  // stream_event serializer hardcodes `parent_tool_use_id: null`, and the branch that DOES attach
  // subagent linkage re-emits only complete `assistant`/`user` messages. So every delta belongs to
  // the main agent, and a subagent's complete message must not consume the delta cursor.
  | { type: 'assistant_delta'; text: string; blockId: string }
  | { type: 'assistant_thinking'; text: string; blockId?: string }
  | { type: 'assistant_thinking_delta'; text: string; blockId: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown;
      /** Present only when a native subagent made the call. See ToolUseSubagent. */
      subagent?: ToolUseSubagent }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; content: string;
      /** Present only when the result belongs to a native subagent's own call. */
      subagent?: ToolUseSubagent;
      /** Inline images the tool returned. In memory only: `content` describes them as text, and
       *  only the transcript sink persists the bytes (as files). */
      images?: ToolResultImage[] }
  // Derived semantic event emitted ALONGSIDE the raw `tool_use` for a TodoWrite call, never
  // instead of it: the raw call is required-sink evidence (production-attempt-journal → ATIF
  // tool_calls) and dropping it would put a hole in the trajectory. Same family as
  // ask_user_question / plan_written. Subagent calls do NOT produce one —
  // a subagent keeps its own list, and letting it through would clobber the main agent's.
  | { type: 'todo_update'; toolUseId: string; snapshot: TodoSnapshot }
  | { type: 'ask_user_question'; toolUseId: string; questions: QuestionSpec[] }
  | { type: 'plan_written'; toolUseId: string; path: string; content: string }
  | { type: 'context_compacted'; trigger: string; preTokens?: number }
  | { type: 'model_fallback'; originalModel: string; fallbackModel: string }
  | ({ type: 'context_usage' } & ContextUsage)
  | { type: 'rate_limit'; raw: unknown }
  | CostRecordEvent
  | { type: 'turn_progress'; numTurns: number }
  | { type: 'turn_complete'; numTurns: number | null; totalCostUsd: number | null; error?: string | null }
  // OC-11 / §17 G4-SA6: a native subagent produced output under this `Agent`/`Task` call. A CENSUS,
  // not an allocation — it carries no text and no cost, because the CLI keeps one process-global
  // cost accumulator and no per-subagent turn counter, and inventing either would be the guess
  // §9.6 A2 forbids. Subagent text reaches the journal through the existing members, not this one.
  | {
      type: 'subagent_activity';
      parentToolUseId: string;
      subagentType: string | null;
      kind: 'assistant' | 'tool_result';
    }
  // The backend's own task lifecycle reporting that one native subagent reached a terminal state.
  // Not derivable from the transcript: a backgrounded subagent runs beside the main agent (so
  // "the main agent spoke again" proves nothing), and a killed one emits nothing else at all.
  | {
      type: 'subagent_end';
      parentToolUseId: string;
      status: 'completed' | 'failed' | 'killed';
    }
  | { type: 'error'; message: string; fatal: boolean };

/**
 * A consumer of one backend's raw events. The engine forwards the wire-level stream to whoever
 * needs evidence of it (the benchmark attempt journal, a required sink); everything else consumes
 * the derived `RunEvent` stream instead.
 */
export interface EventObserver {
  onEvent(event: NormalizedEvent): void | Promise<void>;
  onClose?(): void | Promise<void>;
}
