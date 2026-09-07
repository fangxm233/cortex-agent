// input:  PI session events and parser state
// output: Normalized events including attributed runtime prompts
// pos:    Translates PI session events
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ContextUsage } from '@core/types/agent-types.js';
import type { NormalizedEvent, QuestionSpec, ToolUseSubagent } from '../normalize/event-types.js';
import { toCanonical } from '../normalize/tool-names.js';
import { parseTodoWrite } from '../normalize/todo.js';
import { decodeSubagentNotice, type SubagentNotice } from './subagent-notice.js';

interface PIPendingCompletion {
  numTurns: number;
  totalCostUsd: number | null;
  error: string | null;
}

interface PIAgentEndSummary extends PIPendingCompletion {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputReported: boolean;
  outputReported: boolean;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
}

export interface PIEventParserState {
  /** Cumulative turn count; incremented on each message_end to drive turn_progress. */
  turnProgressCount: number;
  /** Low-level PI runs accumulated until agent_settled closes the Cortex turn. */
  pendingCompletion: PIPendingCompletion;
}

export function createPIEventParserState(): PIEventParserState {
  return {
    turnProgressCount: 0,
    pendingCompletion: emptyPendingCompletion(),
  };
}

/**
 * Translate one PI session event (as delivered by `AgentSession.subscribe`, or an
 * `extension_ui_request` the host raised for an extension) to zero or more NormalizedEvents.
 *
 * Dropped events (return []): turn_start, turn_end, message_start, agent_start,
 * queue_update, compaction_end, auto_retry_start/end, message_update without text_delta,
 * fire-and-forget extension_ui_request.
 * message_end emits a turn_progress heartbeat (non-terminal, state.turnProgressCount++).
 * compaction_start emits a context_compacted event (user notification); compaction_end is dropped
 * to avoid a duplicate notice. Session identity and context usage are not events here: the
 * session reads both straight off the SDK session.
 */
export function piEventToNormalized(
  event: Record<string, unknown>,
  state: PIEventParserState,
): NormalizedEvent[] {
  const ev = event;
  if (typeof ev['type'] !== 'string') return [];
  const type = ev['type'] as string;

  // --- message_update → assistant_text (text_delta only) ---
  if (type === 'message_update') {
    const ame = ev['assistantMessageEvent'];
    if (ame && typeof ame === 'object') {
      const delta = (ame as Record<string, unknown>)['delta'];
      if (
        (ame as Record<string, unknown>)['type'] === 'text_delta' &&
        typeof delta === 'string' &&
        delta.length > 0
      ) {
        // blockId groups every delta of one assistant message and ties them to the finalizing
        // whole-message assistant_text. PI's AssistantMessage carries no `id`: the stable
        // per-message identifier is `responseId`, which the provider assigns once when the
        // stream opens (anthropic msg_… / openai-compatible chatcmpl-…), before any text_delta.
        // `id` is kept first so any producer that does supply one keeps working.
        const msgObj = ev['message'];
        const blockId =
          msgObj && typeof msgObj === 'object'
            ? (((msgObj as Record<string, unknown>)['id'] ??
                (msgObj as Record<string, unknown>)['responseId']) as string | undefined)
            : undefined;
        const result: NormalizedEvent = { type: 'assistant_text', text: delta };
        if (typeof blockId === 'string') (result as any).blockId = blockId;
        return [result];
      }
    }
    return [];
  }

  // --- tool_execution_start → tool_use ---
  if (type === 'tool_execution_start') {
    return handleToolExecutionStart(ev);
  }

  // --- tool_execution_end → tool_result ---
  if (type === 'tool_execution_end') {
    return handleToolExecutionEnd(ev);
  }

  // --- agent_end → low-level usage; agent_settled → terminal turn_complete ---
  if (type === 'agent_end') {
    return handleAgentEnd(ev, state);
  }
  if (type === 'agent_settled') {
    return handleAgentSettled(state);
  }

  // --- compaction_start → context_compacted (user notification) ---
  // compaction_end is intentionally dropped below to avoid a duplicate notice.
  if (type === 'compaction_start') {
    const reason = typeof ev['reason'] === 'string' && (ev['reason'] as string).length > 0
      ? (ev['reason'] as string)
      : 'auto';
    return [{ type: 'context_compacted', trigger: reason }];
  }

  // --- message_end → turn_progress (live heartbeat per assistant turn) ---
  if (type === 'message_end') {
    state.turnProgressCount++;
    return [{ type: 'turn_progress', numTurns: state.turnProgressCount }];
  }

  // --- extension_error → error (non-fatal) ---
  if (type === 'extension_error') {
    const errVal = ev['error'];
    const message =
      typeof errVal === 'string' && errVal.length > 0 ? errVal : 'extension error';
    return [{ type: 'error', message, fatal: false }];
  }

  // --- extension_ui_request → ask_user_question (dialog methods only) ---
  if (type === 'extension_ui_request') {
    return handleExtensionUiRequest(ev);
  }

  // Silently drop all other events (turn_start/end, message_start, agent_start,
  // queue_update, compaction_end, auto_retry_start/end).
  return [];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function handleToolExecutionStart(ev: Record<string, unknown>): NormalizedEvent[] {
  const toolCallId = ev['toolCallId'];
  const toolName = ev['toolName'];
  const args = ev['args'] ?? {};
  if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return [];
  const canonicalName = toCanonical('pi', toolName) ?? toolName;
  const events: NormalizedEvent[] = [
    { type: 'tool_use', toolUseId: toolCallId, name: canonicalName, input: args },
  ];
  // Derived semantic event alongside the raw call. No subagent guard is needed here: PI subagents
  // run as isolated child processes with their own streams (see pi/subagent.ts), so a subagent's
  // tool calls never reach the parent's event stream in the first place.
  const snapshot = parseTodoWrite('pi', toolName, args);
  if (snapshot) events.push({ type: 'todo_update', toolUseId: toolCallId, snapshot });
  return events;
}

function handleToolExecutionEnd(ev: Record<string, unknown>): NormalizedEvent[] {
  const toolCallId = ev['toolCallId'];
  if (typeof toolCallId !== 'string') return [];

  const isError = ev['isError'] === true;
  const result = ev['result'];

  let content = '';
  if (result && typeof result === 'object') {
    const resObj = result as Record<string, unknown>;
    const contentVal = resObj['content'];
    if (Array.isArray(contentVal)) {
      content = (contentVal as unknown[])
        .filter((b) => asRecord(b)['type'] === 'text')
        .map((b) => String(asRecord(b)['text'] ?? ''))
        .join('');
    } else if (typeof contentVal === 'string') {
      content = contentVal;
    }
  }

  return [{ type: 'tool_result', toolUseId: toolCallId, ok: !isError, content }];
}

function emptyPendingCompletion(): PIPendingCompletion {
  return { numTurns: 0, totalCostUsd: null, error: null };
}

function emptyAgentEndSummary(): PIAgentEndSummary {
  return {
    ...emptyPendingCompletion(), provider: '', model: '',
    tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    inputReported: true, outputReported: true,
    cacheReadReported: true, cacheWriteReported: true,
  };
}

function handleAgentEnd(
  ev: Record<string, unknown>,
  state: PIEventParserState,
): NormalizedEvent[] {
  const messages = Array.isArray(ev['messages']) ? ev['messages'] : [];
  const summary = summarizeAgentEnd(messages);
  accumulatePendingCompletion(state, summary);
  if (summary.provider === '') return [];
  const input = reportedTokens(summary.tokensIn, summary.inputReported);
  const output = reportedTokens(summary.tokensOut, summary.outputReported);
  const cacheRead = reportedTokens(summary.cacheReadTokens, summary.cacheReadReported);
  const cacheCreation = reportedTokens(summary.cacheWriteTokens, summary.cacheWriteReported);
  const prompt = sumReportedTokens(input, cacheRead, cacheCreation);
  return [{
    type: 'cost_record', provider: summary.provider, model: summary.model,
    tokens_in: summary.tokensIn, tokens_out: summary.tokensOut,
    prompt_tokens: prompt, cached_tokens: cacheRead,
    input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    provider_requests: summary.numTurns > 0 ? summary.numTurns : null,
    cost_usd: summary.totalCostUsd,
  }];
}

function handleAgentSettled(state: PIEventParserState): NormalizedEvent[] {
  const completion = state.pendingCompletion;
  state.pendingCompletion = emptyPendingCompletion();
  const base = {
    type: 'turn_complete' as const,
    numTurns: completion.numTurns,
    totalCostUsd: completion.totalCostUsd,
  };
  return completion.error === null ? [base] : [{ ...base, error: completion.error }];
}

function summarizeAgentEnd(messages: unknown[]): PIAgentEndSummary {
  const summary = emptyAgentEndSummary();
  for (const message of messages) {
    const record = asRecord(message);
    if (record['role'] !== 'assistant') continue;
    summary.numTurns++;
    captureAssistantIdentity(summary, record);
    captureAssistantError(summary, record);
    captureAssistantUsage(summary, record);
  }
  return summary;
}

function captureAssistantIdentity(
  summary: PIAgentEndSummary,
  message: Record<string, unknown>,
): void {
  const provider = message['provider'];
  const model = message['model'];
  if (summary.provider === '' && typeof provider === 'string' && provider.length > 0) {
    summary.provider = provider;
  }
  if (summary.model === '' && typeof model === 'string' && model.length > 0) {
    summary.model = model;
  }
}

function captureAssistantError(
  summary: PIAgentEndSummary,
  message: Record<string, unknown>,
): void {
  if (summary.error !== null || message['stopReason'] !== 'error') return;
  const errorMessage = message['errorMessage'];
  summary.error = typeof errorMessage === 'string' && errorMessage.length > 0
    ? errorMessage
    : 'PI agent reported an error during execution';
}

function reportedToken(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function accumulateToken(
  total: number,
  reported: boolean,
  value: unknown,
): [number, boolean] {
  return reportedToken(value) ? [total + value, reported] : [total, false];
}

function captureAssistantUsage(
  summary: PIAgentEndSummary,
  message: Record<string, unknown>,
): void {
  const usage = asRecord(message['usage']);
  [summary.tokensIn, summary.inputReported] = accumulateToken(
    summary.tokensIn, summary.inputReported, usage['input'],
  );
  [summary.tokensOut, summary.outputReported] = accumulateToken(
    summary.tokensOut, summary.outputReported, usage['output'],
  );
  [summary.cacheReadTokens, summary.cacheReadReported] = accumulateToken(
    summary.cacheReadTokens, summary.cacheReadReported, usage['cacheRead'],
  );
  [summary.cacheWriteTokens, summary.cacheWriteReported] = accumulateToken(
    summary.cacheWriteTokens, summary.cacheWriteReported, usage['cacheWrite'],
  );
  const cost = asRecord(usage['cost'])['total'];
  if (typeof cost === 'number' && isFinite(cost)) {
    summary.totalCostUsd = (summary.totalCostUsd ?? 0) + cost;
  }
}

function reportedTokens(total: number, reported: boolean): number | null {
  return reported ? total : null;
}

function sumReportedTokens(...tokens: Array<number | null>): number | null {
  return tokens.some(token => token === null)
    ? null : tokens.reduce<number>((sum, token) => sum + token!, 0);
}

function accumulatePendingCompletion(
  state: PIEventParserState,
  summary: PIAgentEndSummary,
): void {
  const pending = state.pendingCompletion;
  pending.numTurns += summary.numTurns;
  pending.totalCostUsd = sumNullableCosts(pending.totalCostUsd, summary.totalCostUsd);
  pending.error = summary.error;
}

function sumNullableCosts(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

/** One forwarded child event → the normalized event it stands for, attributed to the child that
 *  produced it. `parentToolUseId` is the notice's `ref` (`${agentCallId}#${childIndex}`), so each
 *  child of a parallel batch groups on its own rather than merging into one indistinct block. */
function subagentEvents(notice: SubagentNotice): NormalizedEvent[] {
  const subagent: ToolUseSubagent = {
    parentToolUseId: notice.ref,
    type: notice.type || null,
    description: notice.description || null,
    ...(notice.prompt ? { prompt: notice.prompt } : {}),
    model: notice.model,
  };
  if (notice.kind === 'tool_use') {
    return [{
      type: 'tool_use', toolUseId: notice.toolUseId!, name: notice.name!,
      input: notice.input ?? {}, subagent,
    }];
  }
  if (notice.kind === 'tool_result') {
    return [{
      type: 'tool_result', toolUseId: notice.toolUseId!,
      ok: notice.ok !== false, content: notice.content ?? '', subagent,
    }];
  }
  return [{ type: 'assistant_text', text: notice.text!, subagent }];
}

function handleExtensionUiRequest(ev: Record<string, unknown>): NormalizedEvent[] {
  const id = ev['id'];
  const method = ev['method'];
  if (typeof id !== 'string' || typeof method !== 'string') return [];

  // `notify` is PI's only fire-and-forget message to the host. A PI subagent runs in its own
  // session; its output reaches us only because subagent.ts deliberately forwards it over this
  // channel (see subagent-notice.ts). Anything else is a real user notification and drops.
  if (method === 'notify') {
    const notice = decodeSubagentNotice(ev['message']);
    return notice ? subagentEvents(notice) : [];
  }

  // Only dialog methods produce ask_user_question; fire-and-forget methods → [].
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') {
    return [];
  }

  const titleVal = ev['title'];
  const baseQuestion =
    typeof titleVal === 'string' && titleVal.length > 0 ? titleVal : `${method} request`;

  let spec: QuestionSpec;
  if (method === 'select') {
    const opts = ev['options'];
    const options = Array.isArray(opts) ? (opts as unknown[]).map(String) : undefined;
    spec = { question: baseQuestion };
    if (options) spec.options = options;
  } else if (method === 'confirm') {
    const msgVal = ev['message'];
    const detail =
      typeof msgVal === 'string' && msgVal.length > 0 ? `: ${msgVal}` : '';
    spec = { question: baseQuestion + detail, options: ['Yes', 'No'] };
  } else if (method === 'editor') {
    spec = { question: baseQuestion, multi: true };
  } else {
    // input
    spec = { question: baseQuestion };
  }

  return [{ type: 'ask_user_question', toolUseId: id, questions: [spec] }];
}

/** Validate a session stats payload (`AgentSession.getSessionStats()`) into a ContextUsage. */
export function piContextUsageFromStats(data: unknown): ContextUsage | null {
  const usage = asRecord(asRecord(data)['contextUsage']);
  const contextWindow = usage['contextWindow'];
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return {
    usedTokens: nullableNonNegativeNumber(usage['tokens']),
    contextWindow,
    percent: nullableNonNegativeNumber(usage['percent']),
    accuracy: 'estimate',
  };
}

function nullableNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Safely cast an unknown value to a plain record (returns {} for non-objects). */
function asRecord(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}
