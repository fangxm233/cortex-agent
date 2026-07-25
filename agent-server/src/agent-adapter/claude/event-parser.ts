// input:  Claude stream-json events (complete + `stream_event` partials), user message, sessionId
// output: formatters, extractors, buildPrompt, plan-file helpers, stream-delta cursor
// pos:    Claude event parsing, plan file tracking, and token-level delta extraction
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readFileSync } from 'fs';
import { CancelledError, DEFAULT_PLAN_DIRS, PROJECT_SETTINGS } from './defaults.js';
import { summarizeToolInput } from './tool-summarizers.js';
import { buildPrompt as sharedBuildPrompt } from '../normalize/prompt-builder.js';

// ── Token-level streaming (`--include-partial-messages`) ────────────────────────────────────────
//
// With that flag the CLI interleaves `stream_event` lines into stdout while a block is being
// generated. Observed sequence for a reply that thinks first (live capture, Claude Code 2.1.x):
//
//   message_start(msg_X) → content_block_start(0, thinking) → thinking deltas
//     → assistant(1 block: thinking) → content_block_stop(0)
//     → content_block_start(1, text) → text deltas
//     → assistant(1 block: text)     → content_block_stop(1)
//     → message_delta → message_stop → result
//
// Two consequences drive the design below:
//  1. Each content block gets its OWN complete `assistant` event carrying a single-element
//     `content` array. The block's position in that array is therefore always 0 and can NOT be
//     used to recover the streamed `content_block_index` (here the text block is index 1). The
//     open text block is what ties them together — see takeTextBlockId.
//  2. The `assistant` event arrives just BEFORE its block's content_block_stop, so the id must
//     survive the stop event.
//
// Only text streams in v1: `thinking_delta` carries no content anyway (the CLI redacts it to an
// empty string plus a token estimate) and `input_json_delta` is tool arguments, which Cortex
// renders from the complete tool_use block.

/** Per-session cursor over the `stream_event` sequence. Cheap and self-healing: every
 *  `message_start` resets it, so a missed line can at worst drop one block's deltas. */
export interface StreamDeltaState {
  /** `message.id` of the message being streamed — the first half of every blockId. */
  messageId: string | null;
  /** blockId of the text block currently open, awaiting its complete `assistant` event. */
  textBlockId: string | null;
}

export function createStreamDeltaState(): StreamDeltaState {
  return { messageId: null, textBlockId: null };
}

/**
 * Translate one raw stdout line (already JSON-parsed) into an incremental text chunk, advancing
 * `state`. Returns null for every line that is not a non-empty text delta — including all complete
 * events, which keep travelling their existing path untouched.
 *
 * `blockId` is `${message.id}:${content_block_index}` per the streaming contract: stable for one
 * assistant text block and shared with the finalizing message via {@link takeTextBlockId}.
 */
export function parseStreamEvent(
  data: any,
  state: StreamDeltaState,
): { text: string; blockId: string } | null {
  if (!data || data.type !== 'stream_event') return null;
  const ev = data.event;
  if (!ev || typeof ev.type !== 'string') return null;

  if (ev.type === 'message_start') {
    state.messageId = typeof ev.message?.id === 'string' ? ev.message.id : null;
    state.textBlockId = null;
    return null;
  }
  if (ev.type === 'content_block_start') {
    if (ev.content_block?.type === 'text' && state.messageId && typeof ev.index === 'number') {
      state.textBlockId = `${state.messageId}:${ev.index}`;
    }
    return null;
  }
  if (ev.type !== 'content_block_delta') return null;
  if (ev.delta?.type !== 'text_delta') return null;

  const text = ev.delta.text;
  if (typeof text !== 'string' || text.length === 0) return null;
  // No message_start seen (stream joined mid-flight): a blockId would be fabricated and could
  // never match the finalizing message, so drop the chunk rather than render an orphan row.
  if (!state.messageId || typeof ev.index !== 'number') return null;
  const blockId = `${state.messageId}:${ev.index}`;
  // A delta for a block whose content_block_start was missed still identifies its own block.
  state.textBlockId = blockId;
  return { text, blockId };
}

/**
 * Consume the blockId of the streamed text block that the complete `assistant` event now being
 * handled belongs to. Returns null when nothing streamed (kill switch, older CLI, thinking-only
 * message) — the finalizing path then behaves exactly as before, without a blockId.
 *
 * Consumed once: a block's id is handed out to exactly one complete message, so a later event
 * can never re-adopt a stale id.
 */
export function takeTextBlockId(state: StreamDeltaState): string | null {
  const id = state.textBlockId;
  state.textBlockId = null;
  return id;
}

export function extractAskUserQuestions(data: any, sessionId: string): Array<{ toolUseId: string | null; questions: any[]; sessionId: string }> {
  const questions = [];
  for (const block of (data.message?.content || [])) {
    if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue;
    questions.push({
      toolUseId: block.id || null,
      questions: Array.isArray(block.input?.questions) ? block.input.questions : [],
      sessionId,
    });
  }
  return questions;
}

export function formatAssistantEvent(data: any): string | null {
  const parts: string[] = [];
  for (const block of (data.message?.content || [])) {
    if (block.type === 'text') {
      parts.push(`[assistant] ${block.text || ''}`);
    } else if (block.type === 'tool_use') {
      parts.push(`[tool_use] ${block.name || '?'}: ${summarizeToolInput(block.name, block.input || {})}`);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

export function formatUserEvent(data: any): string | null {
  const parts: string[] = [];
  for (const block of (data.message?.content || [])) {
    if (block.type !== 'tool_result') continue;
    let inner = block.content || '';
    let preview;
    if (Array.isArray(inner)) preview = inner.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join(' ');
    else if (typeof inner === 'string') preview = inner;
    else preview = JSON.stringify(inner);
    parts.push(`[tool_result]${block.is_error ? ' [ERROR]' : ''}: ${preview}`);
  }
  return parts.length ? parts.join('\n') : null;
}

export function formatResultEvent(data: any): string {
  const resultText = data.result || '';
  const costStr = data.total_cost_usd != null ? `$${data.total_cost_usd.toFixed(4)}` : '?';
  const durStr = data.duration_ms != null ? `${(data.duration_ms / 1000).toFixed(1)}s` : '?';
  return `[result] turns=${data.num_turns}, cost=${costStr}, duration=${durStr}\n  → ${resultText}`;
}

const EVENT_FORMATTERS: Record<string, (data: any) => string | null> = {
  assistant: formatAssistantEvent,
  user:      formatUserEvent,
  result:    formatResultEvent,
};

export function formatEvent(data: any): string | null {
  const type = data.type || '';
  if (type === 'system' && data.subtype === 'init') {
    return `[init] model=${data.model || '?'}, session=${(data.session_id || '').substring(0, 8)}`;
  }
  if (type === 'system' || type === 'rate_limit_event') return null;
  const fn = EVENT_FORMATTERS[type];
  return fn ? fn(data) : null;
}

export function buildPrompt(userMessage: string, files: any[]): string {
  const normalized = files.map(f => ({ mimeType: f.mimetype ?? f.mimeType, path: f.localPath ?? f.path }));
  return sharedBuildPrompt(userMessage, normalized);
}

/** Merge a brief epilogue with a substantially longer earlier message (e.g. an orient briefing) so Slack gets the real content.
 *  Triggers only when final is both absolutely short (<300) AND relatively short (<50% of longest). */
export function mergeSubstantialOutput(finalOutput: string | null, longestOutput: string | null): string | null {
  if (!finalOutput || !longestOutput) return finalOutput;
  if (finalOutput === longestOutput) return finalOutput;
  if (finalOutput.length < 300 && finalOutput.length < longestOutput.length * 0.5) {
    return longestOutput + '\n\n---\n' + finalOutput;
  }
  return finalOutput;
}

export type ExtractResultOutcome =
  | { resolved: true; value: any; error?: undefined }
  | { resolved: false; error: Error; value?: undefined };

export function extractResult(
  resultData: any,
  effectiveSessionId: string,
  killed: boolean,
  code: number,
  stderr: string,
  planFilePath: string | null,
  enteredPlanMode: boolean,
  exitedPlanMode: boolean,
  askUserQuestions: any[],
  finalOutput: string | null,
  longestOutput: string | null,
): ExtractResultOutcome {
  let total_cost_usd: number | null = null, num_turns: number | null = null, rateLimited = false, rateLimitMessage: string | null = null;
  // When Claude creates a new session (e.g. because --resume failed), capture the actual
  // session_id so we don't keep reusing a stale one.
  let resolvedSessionId = effectiveSessionId;
  if (resultData) {
    if (resultData.total_cost_usd != null) total_cost_usd = resultData.total_cost_usd;
    if (resultData.num_turns != null) num_turns = resultData.num_turns;
    if (resultData.is_error && typeof resultData.result === 'string' && resultData.result.includes('hit your limit')) {
      rateLimited = true;
      rateLimitMessage = resultData.result;
    }
    // Capture the actual session_id Claude used (may differ from requested on --resume failure)
    if (typeof resultData.session_id === 'string' && resultData.session_id !== effectiveSessionId) {
      resolvedSessionId = resultData.session_id;
    }
    // Non-rate-limit errors from Claude (e.g. "No conversation found with session ID"),
    // reported inline via is_error on the result event. Previously these were silently
    // treated as success because the process exit code was 0.
    if (resultData.is_error && !rateLimited) {
      const errorMsg = Array.isArray(resultData.errors) && resultData.errors.length > 0
        ? resultData.errors.join('; ')
        : (typeof resultData.result === 'string' && resultData.result ? resultData.result : 'Claude reported an error during execution');
      return { resolved: false, error: new Error(errorMsg) };
    }
  }
  const effectiveOutput = mergeSubstantialOutput(finalOutput, longestOutput);
  const value = { sessionId: resolvedSessionId, total_cost_usd, num_turns, rateLimited, rateLimitMessage, planFilePath, enteredPlanMode, exitedPlanMode, askUserQuestions, finalOutput: effectiveOutput || null };
  if (rateLimited) return { resolved: true, value };
  if (code !== 0) return { resolved: false, error: killed ? new CancelledError() : new Error(stderr || `claude exited with code ${code}`) };
  return { resolved: true, value };
}

// --- Plan file detection ---

function normalizePlanDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function resolvePlanDirectories(): string[] {
  const dirs: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(PROJECT_SETTINGS, 'utf8'));
    const configured = normalizePlanDir(settings?.plansDirectory);
    if (configured) dirs.push(configured);
  } catch {}
  for (const dir of DEFAULT_PLAN_DIRS) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

export const PLAN_DIRS = resolvePlanDirectories();

export function isPlanFilePath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return PLAN_DIRS.some(dir => normalized.includes(`${dir}/`) || normalized.endsWith(`/${dir}`));
}

// sessionId → most recent plan file written in the active turn. Module-scoped per
// DR-0008 task e0b6 Design Decision 3: external callers mutate via setActivePlanFile /
// clearActivePlanFile and read via getCurrentPlanFilePath; the Map is never exported.
const activePlanFiles = new Map<string, string>();

export function setActivePlanFile(sessionId: string, path: string): void {
  if (!sessionId || !path) return;
  activePlanFiles.set(sessionId, path);
}

export function clearActivePlanFile(sessionId: string): void {
  if (!sessionId) return;
  activePlanFiles.delete(sessionId);
}

export function getCurrentPlanFilePath(sessionId: string): string | null {
  if (!sessionId) return null;
  return activePlanFiles.get(sessionId) || null;
}
