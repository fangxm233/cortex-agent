// input:  nothing (leaf type-only module)
// output: NormalizedEvent discriminated union + QuestionSpec
// pos:    Unified event schema that all adapters translate to
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export interface QuestionSpec {
  question: string;
  multi?: boolean;
  options?: string[];
}

export type NormalizedEvent =
  | { type: 'session_started'; sessionId: string; sessionFile?: string }
  | { type: 'assistant_text'; text: string; blockId?: string }
  | { type: 'assistant_delta'; text: string; blockId: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; content: string }
  | { type: 'ask_user_question'; toolUseId: string; questions: QuestionSpec[] }
  | { type: 'plan_mode_entered'; toolUseId: string; planFilePath: string }
  | { type: 'plan_written'; toolUseId: string; path: string; content: string }
  | { type: 'context_compacted'; trigger: string; preTokens?: number }
  | { type: 'rate_limit'; raw: unknown }
  | { type: 'cost_record'; provider: string; model: string; tokens_in: number; tokens_out: number; cost_usd: number | null }
  | { type: 'turn_progress'; numTurns: number }
  | { type: 'turn_complete'; numTurns: number; totalCostUsd: number | null; error?: string | null }
  | { type: 'error'; message: string; fatal: boolean };
