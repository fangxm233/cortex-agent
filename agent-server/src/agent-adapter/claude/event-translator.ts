// input:  Claude turn callbacks and resolved AgentResult/accounting
// output: NormalizedEvents pushed to the turn stream
// pos:    Claude turn → NormalizedEvent translator
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import type { NormalizedEvent, ToolUseSubagent } from '../normalize/event-types.js';
import { parseTodoWrite } from '../normalize/todo.js';
import type { ModelFallbackEvent } from './event-parser.js';
import type { SubagentEndStatus } from './bg-task-tracker.js';
import type { UserMessage } from '../types.js';

export type SubagentActivityKind = 'assistant' | 'tool_result';

export type TurnTokenUsage = {
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
};

export function tokenValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function sumKnownTokens(values: unknown[]): number | null {
  const tokens = values.map(tokenValue);
  if (tokens.some(value => value === null)) return null;
  const total = tokens.reduce((sum, value) => sum + value!, 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function promptAccounting(usage: TurnTokenUsage | null) {
  return {
    promptTokens: sumKnownTokens([
      usage?.input, usage?.cacheCreation, usage?.cacheRead,
    ]),
    cachedTokens: sumKnownTokens([usage?.cacheRead]),
  };
}

/** Options bag accepted by `ClaudeSession.sendMessage`. */
export interface ClaudeTurnCallbacks {
  attachments?: UserMessage['attachments'];
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  isUserInitiated?: boolean;
  onProgress?: ((progress: any) => void) | null;
  onAssistantMessage?: ((
    text: string, blockId?: string, model?: string | null, subagent?: ToolUseSubagent,
  ) => void) | null;
  onAssistantDelta?: ((text: string, blockId: string) => void) | null;
  onToolUse?: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  onToolResult?: ((
    toolUseId: string, content: string, isError: boolean, subagent?: ToolUseSubagent,
  ) => void) | null;
  onCompact?: ((info: { trigger: string; preTokens?: number }) => void) | null;
  onModelFallback?: ((event: Omit<ModelFallbackEvent, 'type'>) => void) | null;
  onContextUsage?: ((usage: ContextUsage) => void) | null;
  onSubagentActivity?: ((
    parentToolUseId: string, subagentType: string | null, kind: SubagentActivityKind,
  ) => void) | null;
  onSubagentEnd?: ((parentToolUseId: string, status: SubagentEndStatus) => void) | null;
}

/** The three session fields the derived cost_record block reads after a turn settles. */
export interface ClaudeTurnAccountingSource {
  lastTokenUsage: TurnTokenUsage | null;
  lastModelName: string | null;
  modelName: string | null;
}

export function claudeTurnCallbacks(push: (event: NormalizedEvent) => void): ClaudeTurnCallbacks {
  return {
    onAssistantMessage: (
      text: string, blockId?: string, model?: string | null, subagent?: ToolUseSubagent,
    ) =>
      push({
        type: 'assistant_text', text,
        ...(blockId ? { blockId } : {}),
        ...(model != null ? { model } : {}),
        ...(subagent ? { subagent } : {}),
      }),
    // Token-level preview of the block above. Same FIFO stream, so every delta is delivered
    // before the complete message that supersedes it.
    onAssistantDelta: (text: string, blockId: string) =>
      push({ type: 'assistant_delta', text, blockId }),
    onToolUse: (name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => {
      push({ type: 'tool_use', toolUseId, name, input, ...(subagent ? { subagent } : {}) });
      // Derived semantic event alongside the raw call (cf. plan_written /
      // ask_user_question). Subagent lists are deliberately dropped: a subagent keeps
      // its own plan and emitting it would clobber the main agent's on every surface.
      if (subagent) return;
      const snapshot = parseTodoWrite('claude', name, input);
      if (snapshot) push({ type: 'todo_update', toolUseId, snapshot });
    },
    onToolResult: (
      toolUseId: string, content: string, isError: boolean, subagent?: ToolUseSubagent,
    ) =>
      push({
        type: 'tool_result', toolUseId, content, ok: !isError,
        ...(subagent ? { subagent } : {}),
      }),
    onCompact: (info: { trigger: string; preTokens?: number }) =>
      push({ type: 'context_compacted', trigger: info.trigger, preTokens: info.preTokens }),
    onModelFallback: (event: Omit<ModelFallbackEvent, 'type'>) =>
      push({ type: 'model_fallback', ...event }),
    onContextUsage: (usage: ContextUsage) =>
      push({ type: 'context_usage', ...usage }),
    onProgress: (p: { num_turns?: number } | null) => {
      push({ type: 'turn_progress', numTurns: p?.num_turns ?? 0 });
    },
    onSubagentActivity: (
      parentToolUseId: string, subagentType: string | null, kind: SubagentActivityKind,
    ) => push({ type: 'subagent_activity', parentToolUseId, subagentType, kind }),
    onSubagentEnd: (parentToolUseId: string, status: SubagentEndStatus) =>
      push({ type: 'subagent_end', parentToolUseId, status }),
  };
}

export function pushDerivedTurnEvents(
  push: (event: NormalizedEvent) => void,
  result: AgentResult,
  accountingSource: ClaudeTurnAccountingSource,
  preserveUnreportedAccounting: boolean,
): void {
  // Derived events, in order, before the terminating turn_complete.
  for (const q of (result.askUserQuestions || [])) {
    push({
      type: 'ask_user_question',
      toolUseId: q.toolUseId ?? '',
      questions: q.questions as any,
    });
  }
  if (result.planFilePath) {
    push({
      type: 'plan_written',
      toolUseId: '',
      path: result.planFilePath,
      content: '',
    });
  }
  if (result.rateLimited) {
    push({ type: 'rate_limit', raw: { message: result.rateLimitMessage } });
  }
  // Emit cost_record from the resolved turn, not mutable session accounting.
  const preserveReportedness = preserveUnreportedAccounting;
  const accounting = result.reportedAccounting;
  const hasReportableAccounting = preserveReportedness
    ? result.costReported === true || accounting?.usageReported === true
    : result.total_cost_usd != null || accountingSource.lastTokenUsage !== null;
  if (hasReportableAccounting) {
    const legacyUsage = accountingSource.lastTokenUsage;
    const exactPrompt = promptAccounting(legacyUsage);
    push({
      type: 'cost_record', provider: 'anthropic',
      model: (preserveReportedness ? accounting?.model : accountingSource.lastModelName)
        || accountingSource.modelName || 'unknown',
      tokens_in: preserveReportedness
        ? accounting?.promptTokens ?? null : exactPrompt.promptTokens,
      tokens_out: preserveReportedness
        ? accounting?.outputTokens ?? null : legacyUsage?.output ?? 0,
      prompt_tokens: preserveReportedness
        ? accounting?.promptTokens ?? null : exactPrompt.promptTokens,
      cached_tokens: preserveReportedness
        ? accounting?.cachedTokens ?? null : exactPrompt.cachedTokens,
      input_tokens: accounting?.inputTokens ?? null,
      output_tokens: accounting?.outputTokens ?? null,
      cache_read_tokens: accounting?.cacheReadTokens ?? null,
      cache_creation_tokens: accounting?.cacheCreationTokens ?? null,
      provider_requests: Number.isSafeInteger(result.num_turns)
        && Number(result.num_turns) > 0 ? result.num_turns : null,
      cost_usd: preserveReportedness && result.costReported !== true
        ? null : result.total_cost_usd ?? null,
    });
  }
  push({
    type: 'turn_complete',
    numTurns: preserveReportedness ? result.num_turns : result.num_turns ?? 0,
    totalCostUsd: result.total_cost_usd ?? null,
  });
}
