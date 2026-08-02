// input:  core agent types
// output: NormalizedEvent with exact nullable accounting fields
// pos:    Backend-neutral event schema
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContextUsage } from '@core/types/agent-types.js';

export interface QuestionSpec {
  question: string;
  multi?: boolean;
  options?: string[];
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
  | { type: 'cost_record'; provider: string; model: string; tokens_in: number | null; tokens_out: number | null; prompt_tokens: number | null; cached_tokens: number | null; cost_usd: number | null }
  | { type: 'turn_progress'; numTurns: number }
  | { type: 'turn_complete'; numTurns: number; totalCostUsd: number | null; error?: string | null }
  | { type: 'error'; message: string; fatal: boolean };
