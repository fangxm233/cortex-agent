// input:  PI --mode rpc stdout JSONL lines
// output: NormalizedEvents with PI context usage and settled completion
// pos:    Pure function translator from PI rpc events to NormalizedEvent
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { NormalizedEvent, QuestionSpec } from '../normalize/event-types.js';
import { toCanonical } from '../normalize/tool-names.js';
import { isPlanFilePath } from '../claude/event-parser.js';

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
}

export interface PIEventParserState {
  /** Set on first successful bootstrap response; also serves as the session_started dedup sentinel. */
  sessionId: string | null;
  /** Path of the most recent Write() call to a plan directory. Cleared on new session. */
  pendingPlanPath: string | null;
  /** True while agent is in plan mode (between enter_plan_mode and exit_plan_mode). */
  inPlanMode: boolean;
  /** toolCallId of the pending enter_plan_mode call; used to correlate tool_execution_end. */
  pendingEnterPlanModeId: string | null;
  /** Cumulative turn count; incremented on each message_end to drive turn_progress. */
  turnProgressCount: number;
  /** Low-level PI runs accumulated until agent_settled closes the Cortex turn. */
  pendingCompletion: PIPendingCompletion;
}

export function createPIEventParserState(): PIEventParserState {
  return {
    sessionId: null,
    pendingPlanPath: null,
    inPlanMode: false,
    pendingEnterPlanModeId: null,
    turnProgressCount: 0,
    pendingCompletion: emptyPendingCompletion(),
  };
}

/**
 * Translate one raw PI rpc stdout line (JSONL) to zero or more NormalizedEvents.
 *
 * Bootstrap dedup: state.sessionId is the sentinel. The parser sets it on first emission and
 * returns [] on subsequent bootstrap hits (Option A per Plan Review N2H-3).
 *
 * Dropped events (return []): turn_start, turn_end, message_start, agent_start,
 * queue_update, compaction_end, auto_retry_end, successful unrelated response,
 * message_update without text_delta, fire-and-forget extension_ui_request.
 * message_end emits a turn_progress heartbeat (non-terminal, state.turnProgressCount++).
 * compaction_start emits a context_compacted event (user notification); compaction_end is dropped
 * to avoid a duplicate notice.
 */
export function piRpcLineToNormalized(line: string, state: PIEventParserState): NormalizedEvent[] {
  if (!line) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  const ev = obj as Record<string, unknown>;
  if (typeof ev['type'] !== 'string') return [];
  const type = ev['type'] as string;

  // --- response (bootstrap, optional context stats, or failed) ---
  if (type === 'response') {
    if (ev['command'] === 'get_session_stats') {
      return ev['success'] === true ? contextUsageFromStats(ev['data']) : [];
    }
    if (
      ev['id'] === 'bootstrap' &&
      ev['command'] === 'get_state' &&
      ev['success'] === true
    ) {
      // Bootstrap dedup: only emit if not yet announced (N2H-3 Option A).
      if (state.sessionId !== null) return [];
      const data = ev['data'];
      if (data && typeof data === 'object') {
        const sid = (data as Record<string, unknown>)['sessionId'];
        if (typeof sid === 'string' && sid.length > 0) {
          const sf = (data as Record<string, unknown>)['sessionFile'];
          state.sessionId = sid;
          const event: NormalizedEvent = { type: 'session_started', sessionId: sid };
          if (typeof sf === 'string' && sf.length > 0) {
            (event as any).sessionFile = sf;
          }
          return [event];
        }
      }
      return [];
    }
    // Non-bootstrap failed response → non-fatal error.
    if (ev['success'] === false) {
      const errMsg = ev['error'];
      const cmd = ev['command'];
      const message =
        typeof errMsg === 'string' && errMsg.length > 0
          ? errMsg
          : `pi command failed: ${typeof cmd === 'string' ? cmd : 'unknown'}`;
      return [{ type: 'error', message, fatal: false }];
    }
    return [];
  }

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

  // --- tool_execution_start → tool_use / ask_user_question / plan_written ---
  if (type === 'tool_execution_start') {
    return handleToolExecutionStart(ev, state);
  }

  // --- tool_execution_end → tool_result (+ plan_mode_entered when enter_plan_mode completes) ---
  if (type === 'tool_execution_end') {
    return handleToolExecutionEnd(ev, state);
  }

  // --- agent_end → low-level usage; agent_settled → terminal turn_complete ---
  if (type === 'agent_end') {
    return handleAgentEnd(ev, state);
  }
  if (type === 'agent_settled') {
    return handleAgentSettled(state);
  }

  // --- auto_retry_start → rate_limit ---
  if (type === 'auto_retry_start') {
    return [{ type: 'rate_limit', raw: ev }];
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
  // DR-0008 §5.5 revision #4: extension_ui sub-protocol may handle interactive pseudo-tools.
  if (type === 'extension_ui_request') {
    return handleExtensionUiRequest(ev);
  }

  // Silently drop all other events (turn_start/end, message_start/end, agent_start,
  // queue_update, compaction_end, auto_retry_end, successful non-bootstrap response).
  return [];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function handleToolExecutionStart(
  ev: Record<string, unknown>,
  state: PIEventParserState,
): NormalizedEvent[] {
  const toolCallId = ev['toolCallId'];
  const toolName = ev['toolName'];
  const args = ev['args'] ?? {};

  if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return [];

  // ask_user_question pseudo-tool shim (task 5b5c).
  // DR-0008 §5.6: emit tool_use here (not ask_user_question) to avoid duplicating the
  // ask_user_question NormalizedEvent that extension_ui_request will emit when the shim
  // calls ctx.ui.select/input inside execute(). The ask_user_question NormalizedEvent comes
  // exclusively from the extension_ui_request path (handleExtensionUiRequest below).
  if (toolName === 'ask_user_question') {
    const canonicalName = toCanonical('pi', toolName) ?? toolName;
    return [{ type: 'tool_use', toolUseId: toolCallId, name: canonicalName, input: args }];
  }

  // enter_plan_mode pseudo-tool shim.
  // Emits tool_use + plan_mode_entered so the Cortex adapter can notify observers
  // (e.g. Slack) that the agent entered plan mode. The plan file path is extracted
  // from the tool_result (populated by the shim in execute()), but since we only
  // have tool_execution_start here, we parse it from the tool shim's deterministic
  // path pattern and store it for the subsequent exit_plan_mode to reference.
  if (toolName === 'enter_plan_mode') {
    const canonicalName = toCanonical('pi', toolName) ?? toolName;
    state.inPlanMode = true;
    state.pendingEnterPlanModeId = toolCallId;
    return [{ type: 'tool_use', toolUseId: toolCallId, name: canonicalName, input: args }];
  }

  // exit_plan_mode pseudo-tool shim (task 5b5c).
  // N2H-1: toolUseId is toolCallId from this event.
  // Always emit a tool_use event so onToolUse captures exit_plan_mode (needed by
  // buildInteractiveCallbacks to route the subsequent confirm() as plan approval).
  // Additionally emit plan_written when pendingPlanPath is available.
  if (toolName === 'exit_plan_mode') {
    const canonicalName = toCanonical('pi', toolName) ?? toolName;
    const argsObj = asRecord(args);
    const content =
      typeof argsObj['plan'] === 'string'
        ? argsObj['plan']
        : typeof argsObj['content'] === 'string'
          ? argsObj['content']
          : '';
    const events: NormalizedEvent[] = [
      { type: 'tool_use', toolUseId: toolCallId, name: canonicalName, input: args },
    ];
    if (state.pendingPlanPath !== null) {
      events.push({ type: 'plan_written', toolUseId: toolCallId, path: state.pendingPlanPath, content });
    }
    state.inPlanMode = false;
    // DEBUG: trace plan content flow
    return events;
  }

  // Track Write calls to plan directories so exit_plan_mode can reference the path.
  if (toolName === 'write' || toolName === 'Write') {
    const argsObj = asRecord(args);
    const filePath = argsObj['file_path'] ?? argsObj['path'];  // PI uses `path`, Claude Code uses `file_path`
    if (typeof filePath === 'string' && isPlanFilePath(filePath)) {
      state.pendingPlanPath = filePath;
    }
  }

  // Regular tool → tool_use with canonical name.
  const canonicalName = toCanonical('pi', toolName) ?? toolName;
  return [{ type: 'tool_use', toolUseId: toolCallId, name: canonicalName, input: args }];
}

function handleToolExecutionEnd(ev: Record<string, unknown>, state: PIEventParserState): NormalizedEvent[] {
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

  const events: NormalizedEvent[] = [{ type: 'tool_result', toolUseId: toolCallId, ok: !isError, content }];

  // When enter_plan_mode completes, extract the plan file path from the result
  // text and emit plan_mode_entered for observability (Slack notification etc.).
  if (state.pendingEnterPlanModeId === toolCallId && !isError) {
    state.pendingEnterPlanModeId = null;
    const pathMatch = content.match(/^Plan file:\s*(.+)$/m);
    const planFilePath = pathMatch?.[1]?.trim() ?? '';
    if (planFilePath) {
      events.push({ type: 'plan_mode_entered', toolUseId: toolCallId, planFilePath });
    }
  }

  return events;
}

function emptyPendingCompletion(): PIPendingCompletion {
  return { numTurns: 0, totalCostUsd: null, error: null };
}

function emptyAgentEndSummary(): PIAgentEndSummary {
  return {
    ...emptyPendingCompletion(),
    provider: '',
    model: '',
    tokensIn: 0,
    tokensOut: 0,
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
  return [{
    type: 'cost_record',
    provider: summary.provider,
    model: summary.model,
    tokens_in: summary.tokensIn,
    tokens_out: summary.tokensOut,
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

function captureAssistantUsage(
  summary: PIAgentEndSummary,
  message: Record<string, unknown>,
): void {
  const usage = message['usage'];
  if (!usage || typeof usage !== 'object') return;
  const usageRecord = usage as Record<string, unknown>;
  const input = usageRecord['input'];
  const output = usageRecord['output'];
  if (typeof input === 'number' && isFinite(input)) summary.tokensIn += input;
  if (typeof output === 'number' && isFinite(output)) summary.tokensOut += output;
  const cost = asRecord(usageRecord['cost'])['total'];
  if (typeof cost === 'number' && isFinite(cost)) {
    summary.totalCostUsd = (summary.totalCostUsd ?? 0) + cost;
  }
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

function handleExtensionUiRequest(ev: Record<string, unknown>): NormalizedEvent[] {
  const id = ev['id'];
  const method = ev['method'];
  if (typeof id !== 'string' || typeof method !== 'string') return [];

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

function contextUsageFromStats(data: unknown): NormalizedEvent[] {
  const usage = asRecord(asRecord(data)['contextUsage']);
  const contextWindow = usage['contextWindow'];
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return [];
  }
  const tokens = nullableNonNegativeNumber(usage['tokens']);
  const percent = nullableNonNegativeNumber(usage['percent']);
  return [{
    type: 'context_usage',
    usedTokens: tokens,
    contextWindow,
    percent,
    accuracy: 'estimate',
  }];
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
