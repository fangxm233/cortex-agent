// input:  PI --mode rpc stdout JSONL lines
// output: piRpcLineToNormalized + createPIEventParserState (text deltas tagged with a blockId)
// pos:    Pure function translator from PI rpc events to NormalizedEvent
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { NormalizedEvent, QuestionSpec } from '../normalize/event-types.js';
import { toCanonical } from '../normalize/tool-names.js';
import { isPlanFilePath } from '../claude/event-parser.js';

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
}

export function createPIEventParserState(): PIEventParserState {
  return { sessionId: null, pendingPlanPath: null, inPlanMode: false, pendingEnterPlanModeId: null, turnProgressCount: 0 };
}

/**
 * Translate one raw PI rpc stdout line (JSONL) to zero or more NormalizedEvents.
 *
 * Bootstrap dedup: state.sessionId is the sentinel. The parser sets it on first emission and
 * returns [] on subsequent bootstrap hits (Option A per Plan Review N2H-3).
 *
 * Dropped events (return []): turn_start, turn_end, message_start, agent_start,
 * queue_update, compaction_end, auto_retry_end, successful non-bootstrap
 * response, message_update without text_delta, fire-and-forget extension_ui_request.
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

  // --- response (bootstrap or failed) ---
  if (type === 'response') {
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

  // --- agent_end → turn_complete ---
  if (type === 'agent_end') {
    return handleAgentEnd(ev);
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

function handleAgentEnd(ev: Record<string, unknown>): NormalizedEvent[] {
  const messages = ev['messages'];
  const msgs: unknown[] = Array.isArray(messages) ? messages : [];

  // N2H-5: totalCostUsd is null when no messages carry usage.cost.total.
  let totalCostUsd: number | null = null;
  let numTurns = 0;
  // task 1e0b: extract provider/model/token counts for cost_record
  let provider = '';
  let model = '';
  let tokensIn = 0;
  let tokensOut = 0;
  // Turn-level error: PI marks a failed assistant message with stopReason "error" (e.g. a gateway
  // 400). This mirrors Claude's result.is_error — captured here so the adapter can fail the turn
  // instead of silently resolving it as success.
  let turnError: string | null = null;

  for (const msg of msgs) {
    const mr = asRecord(msg);
    if (mr['role'] !== 'assistant') continue;
    numTurns++;
    if (turnError === null && mr['stopReason'] === 'error') {
      const em = mr['errorMessage'];
      turnError = typeof em === 'string' && em.length > 0 ? em : 'PI agent reported an error during execution';
    }
    // First assistant message with a non-empty provider wins
    if (provider === '' && typeof mr['provider'] === 'string' && mr['provider'].length > 0) {
      provider = mr['provider'];
    }
    if (model === '' && typeof mr['model'] === 'string' && mr['model'].length > 0) {
      model = mr['model'];
    }
    const usage = mr['usage'];
    if (usage && typeof usage === 'object') {
      const usageObj = usage as Record<string, unknown>;
      const input = usageObj['input'];
      if (typeof input === 'number' && isFinite(input)) tokensIn += input;
      const output = usageObj['output'];
      if (typeof output === 'number' && isFinite(output)) tokensOut += output;
      const costObj = usageObj['cost'];
      if (costObj && typeof costObj === 'object') {
        const total = (costObj as Record<string, unknown>)['total'];
        if (typeof total === 'number' && isFinite(total)) {
          totalCostUsd = (totalCostUsd ?? 0) + total;
        }
      }
    }
  }

  const result: NormalizedEvent[] = [];
  // Emit cost_record only when provider is present (i.e., real LLM usage occurred)
  if (provider !== '') {
    result.push({ type: 'cost_record', provider, model, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: totalCostUsd });
  }
  // Only attach `error` when the turn actually failed, so success events stay minimal and existing
  // deepEqual assertions on turn_complete keep passing.
  result.push(
    turnError !== null
      ? { type: 'turn_complete', numTurns, totalCostUsd, error: turnError }
      : { type: 'turn_complete', numTurns, totalCostUsd },
  );
  return result;
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

/** Safely cast an unknown value to a plain record (returns {} for non-objects). */
function asRecord(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}
