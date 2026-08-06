// input:  core agent types
// output: NormalizedEvent with documented accounting fields
// pos:    Backend-neutral event schema
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContextUsage } from '@core/types/agent-types.js';

export interface QuestionSpec {
  question: string;
  multi?: boolean;
  options?: string[];
}

interface CostRecordEvent {
  type: 'cost_record';
  provider: string;
  model: string;
  /** Claude input_tokens + cache_creation_input_tokens + cache_read_input_tokens; null if underivable. */
  tokens_in: number | null;
  tokens_out: number | null;
  /** The same Claude prompt total, retained for aggregate metrics. */
  prompt_tokens?: number | null;
  /** Claude cache-read tokens; cache creation remains prompt-only. */
  cached_tokens?: number | null;
  cost_usd: number | null;
}

export type NormalizedEvent =
  | { type: 'session_started'; sessionId: string; sessionFile?: string }
  | { type: 'assistant_text'; text: string; blockId?: string; model?: string | null }
  | { type: 'assistant_delta'; text: string; blockId: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; content: string }
  | { type: 'ask_user_question'; toolUseId: string; questions: QuestionSpec[] }
  | { type: 'plan_mode_entered'; toolUseId: string; planFilePath: string }
  | { type: 'plan_written'; toolUseId: string; path: string; content: string }
  | { type: 'context_compacted'; trigger: string; preTokens?: number }
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
  | { type: 'error'; message: string; fatal: boolean };
