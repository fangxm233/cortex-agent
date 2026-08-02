// input:  Claude transcript paths and JSONL records
// output: transcript events with cache-explicit accounting
// pos:    Claude transcript event normalizer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import type { NormalizedEvent, QuestionSpec } from '../normalize/event-types.js';
import { isPlanFilePath } from './event-parser.js';
import { usageToCost, type ClaudeUsage } from './cost-from-usage.js';

// =====================================================================================
//  JsonlEventNormalizer — pure: jsonl raw event → NormalizedEvent[]
// =====================================================================================

function exactToken(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

interface PerMessageUsage {
  usage: ClaudeUsage;
  model: string;
}

function summarizeUsage(entries: PerMessageUsage[]) {
  let totalCost = 0;
  let costKnown = true;
  let tokensIn = 0;
  let tokensOut = 0;
  let cachedTokens = 0;
  let promptKnown = true;
  let cachedKnown = true;
  let model = '';
  for (const entry of entries) {
    const result = usageToCost(entry.usage, entry.model);
    if (result === null) costKnown = false;
    else totalCost += result.totalUsd;
    const input = entry.usage.input_tokens;
    const created = entry.usage.cache_creation_input_tokens;
    const read = entry.usage.cache_read_input_tokens;
    const cacheIsKnown = exactToken(created) && exactToken(read);
    promptKnown &&= exactToken(input) && cacheIsKnown;
    cachedKnown &&= cacheIsKnown;
    tokensIn += (input ?? 0) + (created ?? 0) + (read ?? 0);
    tokensOut += entry.usage.output_tokens ?? 0;
    cachedTokens += (created ?? 0) + (read ?? 0);
    if (entry.model) model = entry.model;
  }
  return { totalCost, costKnown, tokensIn, tokensOut, cachedTokens, promptKnown, cachedKnown, model };
}

/**
 * Tool names that signal AskUserQuestion semantics worth translating into an ACTIONABLE
 * `ask_user_question` NormalizedEvent (which drives the post-hoc Slack posting machinery:
 * facade.onAskUserQuestion + lifecycle.sendMessages).
 *
 * Only the NATIVE `AskUserQuestion` belongs here. The TUI-mode MCP replacement
 * `mcp__cortex-tui-bridge__cortex_ask_user` is deliberately EXCLUDED: it is self-contained — it
 * posts the Slack card, blocks, and returns the answer inline through its own webhook
 * (tui-ask.ts:82 → /hook/ask-user-question → ask-user.requested → hook-bridge-subscribers). The
 * jsonl normalizer is a passive transcript observer; synthesizing an actionable event for an
 * already-resolved tool double-/triple-posts the same question (the stray `Answer (0/1)` cards,
 * one titled `undefined` because this path drops the header). It still surfaces as a plain
 * `tool_use` event below, so the `cortex_ask_user ×1` tool trace renders normally. This mirrors
 * print mode, where extractAskUserQuestions (event-parser.ts) matches only the native tool too.
 */
const ASK_USER_TOOL_NAMES = new Set([
  'AskUserQuestion',
]);

/** Tool names that signal "enter plan mode" semantics (native + TUI-mode MCP replacement). */
const PLAN_ENTER_TOOL_NAMES = new Set([
  'EnterPlanMode',
  'mcp__cortex-tui-bridge__cortex_plan_enter',
]);

/**
 * Pure stateful translator. One instance per Claude session. Holds:
 *  - `seenMsgIds`: msg.id dedup set (one Claude API message may produce multiple jsonl entries)
 *  - `currentTurnUsages`: per-message usage accumulator, summed at turn boundary
 *  - `turnCount`: number of distinct messages so far in the current turn
 *
 * Reset implicitly happens when a `system/turn_duration` event is consumed.
 *
 * @see DR-0012 §3.4 — cost reconstructed from per-message usage; per-message dedup avoids double-counting.
 */
export class JsonlEventNormalizer {
  private seenMsgIds: Set<string> = new Set();
  private currentTurnUsages: PerMessageUsage[] = [];
  private turnCount = 0;

  consume(raw: any): NormalizedEvent[] {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return [];
    switch (raw.type) {
      case 'assistant': return this.handleAssistant(raw);
      case 'user': return this.handleUser(raw);
      case 'system':
        if (raw.subtype === 'turn_duration') return this.handleTurnDuration(raw);
        return [];
      // Known non-translatable types — pass through silently.
      case 'permission-mode':
      case 'file-history-snapshot':
      case 'attachment':
      case 'ai-title':
      case 'last-prompt':
      case 'queue-operation':
        return [];
      default:
        return [];
    }
  }

  private handleAssistant(raw: any): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const msg = raw.message || {};
    const msgId: string | undefined = msg.id;
    const isNewMessage = !!msgId && !this.seenMsgIds.has(msgId);
    if (isNewMessage) {
      this.seenMsgIds.add(msgId);
      this.currentTurnUsages.push({
        usage: (msg.usage as ClaudeUsage) || {},
        model: typeof msg.model === 'string' ? msg.model : '',
      });
      this.turnCount += 1;
    }

    const model = typeof msg.model === 'string' ? msg.model : undefined;
    for (const block of (msg.content || [])) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        events.push({
          type: 'assistant_text', text: block.text,
          blockId: typeof block.id === 'string' ? block.id : msgId,
          ...(model !== undefined ? { model } : {}),
        });
      } else if (block.type === 'tool_use') {
        const toolUseId = typeof block.id === 'string' ? block.id : '';
        const name = typeof block.name === 'string' ? block.name : '?';
        events.push({ type: 'tool_use', toolUseId, name, input: block.input ?? null });

        // Special-cased translations — produce additional semantic events alongside the raw tool_use.
        if (PLAN_ENTER_TOOL_NAMES.has(name)) {
          events.push({ type: 'plan_mode_entered', toolUseId, planFilePath: '' });
        }
        if (ASK_USER_TOOL_NAMES.has(name)) {
          events.push({
            type: 'ask_user_question',
            toolUseId,
            questions: extractQuestionsFromInput(block.input),
          });
        }
        if (name === 'Write' && isPlanFilePath(block.input?.file_path)) {
          events.push({
            type: 'plan_written',
            toolUseId,
            path: String(block.input.file_path),
            content: typeof block.input.content === 'string' ? block.input.content : '',
          });
        }
      }
      // thinking blocks intentionally not surfaced (per existing -p adapter behavior)
    }

    if (isNewMessage) {
      events.push({ type: 'turn_progress', numTurns: this.turnCount });
    }

    return events;
  }

  private handleUser(raw: any): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const content = raw.message?.content;
    if (!Array.isArray(content)) return events;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const ok = !block.is_error;
      let contentStr: string;
      if (typeof block.content === 'string') {
        contentStr = block.content;
      } else if (Array.isArray(block.content)) {
        contentStr = block.content
          .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
        if (contentStr === '') contentStr = JSON.stringify(block.content);
      } else {
        contentStr = JSON.stringify(block.content ?? '');
      }
      events.push({ type: 'tool_result', toolUseId, ok, content: contentStr });
    }
    return events;
  }

  private handleTurnDuration(_raw: any): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const usage = summarizeUsage(this.currentTurnUsages);
    if (this.currentTurnUsages.length > 0) {
      events.push({
        type: 'cost_record', provider: 'claude', model: usage.model,
        tokens_in: usage.tokensIn, tokens_out: usage.tokensOut,
        prompt_tokens: usage.promptKnown ? usage.tokensIn : null,
        cached_tokens: usage.cachedKnown ? usage.cachedTokens : null,
        cost_usd: usage.costKnown ? usage.totalCost : null,
      });
    }
    events.push({
      type: 'turn_complete', numTurns: this.turnCount,
      totalCostUsd: usage.costKnown && this.currentTurnUsages.length > 0
        ? usage.totalCost : null,
    });
    this.currentTurnUsages = [];
    this.turnCount = 0;
    return events;
  }

  /** Reset all state (typically called when starting a fresh session, not between turns). */
  reset(): void {
    this.seenMsgIds.clear();
    this.currentTurnUsages = [];
    this.turnCount = 0;
  }
}

/**
 * Best-effort question extraction. Both native AskUserQuestion and the cortex_ask_user MCP tool
 * now share the same shape: `{ questions: [{ question, options[], multiSelect }, ...] }`
 * (cortex_ask_user was aligned to the native shape so this normalizer has one branch).
 *
 * A legacy flat-question shape (`{ question, options?[], multi_select? }`) is still recognized
 * as a defensive fallback in case an older agent or stale prompt produces it.
 */
function extractQuestionsFromInput(input: any): QuestionSpec[] {
  if (!input || typeof input !== 'object') return [];
  // Canonical shape — used by both native AskUserQuestion and cortex_ask_user MCP tool.
  if (Array.isArray(input.questions)) {
    return input.questions.map((q: any): QuestionSpec => ({
      question: typeof q.question === 'string' ? q.question : '',
      multi: !!q.multiSelect,
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => typeof o === 'string' ? o : (o?.label ?? String(o)))
        : undefined,
    }));
  }
  // Legacy fallback — flat single-question shape. Kept for safety; remove once no callers exist.
  if (typeof input.question === 'string') {
    return [{
      question: input.question,
      multi: !!(input.multi_select ?? input.multiSelect),
      options: Array.isArray(input.options)
        ? input.options.map((o: any) => typeof o === 'string' ? o : (o?.label ?? String(o)))
        : undefined,
    }];
  }
  return [];
}

// =====================================================================================
//  JsonlTail — file watcher emitting raw parsed jsonl events
// =====================================================================================

export interface JsonlTailOptions {
  /** Read pre-existing content when start() is called. Default false (skip to end-of-file). */
  fromStart?: boolean;
  /** @deprecated No longer used. start() is non-blocking and never rejects on a missing file —
   *  the tail polls until the file appears. Kept for backward-compatible construction. */
  waitForFileMs?: number;
  /** Poll interval for file size changes, in ms. Default 200. fs.watch is not used because it's
   *  unreliable on some filesystems; polling is universal and the throughput here is low. */
  pollIntervalMs?: number;
}

type JsonlTailEvents = {
  /** Raw parsed JSON object from one jsonl line. Emitted for EVERY line including unparseable ones (with type='_parse_error'). */
  event: (raw: any) => void;
  /** Emitted when a `system/turn_duration` event is observed. Convenience signal for turn boundary. */
  'turn-end': (raw: { durationMs?: number; messageCount?: number }) => void;
  error: (err: Error) => void;
};

/**
 * Tails a Claude session jsonl file by polling its size and reading appended bytes. Buffers across
 * partial-line writes. Stops on `stop()`.
 *
 * @see DR-0012 §3.2 — feeds JsonlEventNormalizer in the TUI adapter.
 */
export class JsonlTail extends EventEmitter {
  private offset = 0;
  private buffer = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly waitForFileMs: number;
  private readonly pollIntervalMs: number;
  private readonly fromStart: boolean;

  constructor(private readonly filePath: string, opts: JsonlTailOptions = {}) {
    super();
    this.waitForFileMs = opts.waitForFileMs ?? 5000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    this.fromStart = opts.fromStart ?? false;
  }

  // Type-safe on() — pleasant for callers but not enforced by TS without the explicit override.
  on<K extends keyof JsonlTailEvents>(event: K, listener: JsonlTailEvents[K]): this {
    return super.on(event, listener as any);
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    // Non-blocking on a missing file. Current Claude Code creates the session transcript only
    // AFTER the first message is submitted, so the tail must attach BEFORE the file exists
    // (DR-0012 soak finding). We therefore do NOT wait for / require the file here — we begin
    // polling immediately and readNewBytes() picks it up the moment Claude creates it.
    const existedBeforeStart = fs.existsSync(this.filePath);
    // Read from start when: explicitly requested OR file does not exist yet (in the latter case,
    // everything that gets written is "new" from our perspective — i.e. the whole first turn).
    if (this.fromStart || !existedBeforeStart) {
      this.offset = 0;
      this.readNewBytes(); // no-op while the file is absent — statSync is guarded
    } else {
      // Resume: the file already holds prior turns; seek to EOF so we don't reprocess history
      // (which would re-emit a stale turn_duration and prematurely complete the new turn).
      try {
        const st = fs.statSync(this.filePath);
        this.offset = st.size;
      } catch {
        this.offset = 0;
      }
    }
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      try { this.readNewBytes(); } catch (e) { this.emit('error', e as Error); }
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  private readNewBytes(): void {
    let st;
    try { st = fs.statSync(this.filePath); } catch { return; }
    if (st.size <= this.offset) return;
    const fd = fs.openSync(this.filePath, 'r');
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = st.size;
      this.buffer += buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    this.drainBuffer();
  }

  private drainBuffer(): void {
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.dispatchLine(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private dispatchLine(line: string): void {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      this.emit('event', { type: '_parse_error', raw: line });
      return;
    }
    this.emit('event', raw);
    if (raw && raw.type === 'system' && raw.subtype === 'turn_duration') {
      this.emit('turn-end', { durationMs: raw.durationMs, messageCount: raw.messageCount });
    }
  }
}
