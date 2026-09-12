// input:  parsed Claude stdout lines, turn callbacks, continuation/injection sinks
// output: settled turns, streamed assistant/tool events, accounting, continuation delivery
// pos:    Claude print-mode turn machine (the turn half of the persistent session)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createWriteStream, mkdirSync } from 'fs';
import { Writable } from 'stream';
import * as path from 'path';
import { readableTimestamp } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { handleRateLimitEvent } from '@domain/costs/rate-limit-throttle.js';
import type {
  AgentCompactUsage, ContinuationSink, InjectionAckSink, UserMessage,
} from '../types.js';
import type { AgentResult, ContextUsage, ReportedAccountingSnapshot } from '@core/types/agent-types.js';
import type { ToolUseSubagent } from '../normalize/event-types.js';
import { CancelledError, LOGS_DIR } from './defaults.js';
import {
  buildPrompt,
  clearActivePlanFile,
  extractResult,
  formatEvent,
  isPlanFilePath,
  setActivePlanFile,
  createStreamDeltaState,
  parseStreamEvent,
  takeTextBlockId,
  parseModelFallbackEvent,
  type ModelFallbackEvent,
  type StreamDeltaState,
} from './event-parser.js';
import { BgTaskTracker, isContinuationResult, routeLine, type SubagentEndStatus } from './bg-task-tracker.js';
import {
  promptAccounting,
  tokenValue,
  type SubagentActivityKind,
  type TurnTokenUsage,
} from './event-translator.js';
import { ClaudeContextUsageTracker } from './context-usage.js';
import { activeClaudeCaptureRegistry } from './active-capture-registry.js';

const log = createLogger('claude-bridge');

/** One foreground or synthetic turn in flight: its callbacks, its transcript streams and
 *  the bookkeeping the line handlers accumulate before it settles. */
export interface PendingTurn {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  resultData: any;
  planFilePath: string | null;
  enteredPlanMode: boolean;
  exitedPlanMode: boolean;
  askUserQuestions: any[];
  finalOutput: string | null;
  longestOutput: string | null;
  /** Main-agent assistant messages only. Native-subagent lines are counted separately below, the
   *  same split ATIF keeps between `total_steps` and `subagent_turns`. */
  turnCount: number;
  subagentTurnCount: number;
  capturePairKey?: string | null;
  releaseCapture?: (() => void) | null;
  onProgress: ((progress: any) => void) | null;
  /** Complete assistant text block. `blockId` ties it to the deltas that streamed it (absent when
   *  nothing streamed — kill switch, older CLI, or a reply that produced no partial messages). */
  onAssistantMessage: ((
    text: string, blockId?: string, model?: string | null, subagent?: ToolUseSubagent,
  ) => void) | null;
  /** Incremental text chunk while a block is still being generated (never the accumulated total).
   *  Web UI preview only — the complete message above stays authoritative. */
  onAssistantDelta: ((text: string, blockId: string) => void) | null;
  /** `subagent` is set only when a native subagent made the call (see ToolUseSubagent).
   *  Optional so existing implementations that ignore attribution still satisfy the type. */
  onToolUse: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  onToolResult: ((
    toolUseId: string, content: string, isError: boolean, subagent?: ToolUseSubagent,
  ) => void) | null;
  onCompact: ((info: { trigger: string; preTokens?: number }) => void) | null;
  onModelFallback: ((event: Omit<ModelFallbackEvent, 'type'>) => void) | null;
  onContextUsage: ((usage: ContextUsage) => void) | null;
  /** OC-11 / §17 G4-SA5: one census call per native-subagent line, carrying only the linkage. */
  onSubagentActivity: ((
    parentToolUseId: string, subagentType: string | null, kind: SubagentActivityKind,
  ) => void) | null;
  /** Authoritative end of one subagent spawned by this turn. A backgrounded child can reach its
   *  terminal state while the parent turn is still open, so the signal needs an in-turn route —
   *  the continuation sink only exists once the turn has ended and a background hold is up. */
  onSubagentEnd: ((
    parentToolUseId: string, status: SubagentEndStatus,
  ) => void) | null;
  rawStream: Writable;
  txtStream: Writable;
  killed: boolean;
  /** True for a synthetic turn opened to capture a background-task continuation
   *  (the spontaneous turn the CLI emits after a run_in_background task finishes). */
  spontaneous?: boolean;
}

/** The two subagent line shapes §17 G4-SA6 admits. A replay echo is the CLI's delivery ack for an
 *  injected message, not subagent work, so it is not a census line. */
/** Read the subagent linkage the CLI puts on every stdout line. Undefined = the main agent's
 *  own call. Nothing is added to any tool's parameter schema: this rides the transport
 *  envelope, so the model neither sees nor reports it. */
function subagentAttribution(data: any): ToolUseSubagent | undefined {
  const parentToolUseId = data?.parent_tool_use_id;
  if (typeof parentToolUseId !== 'string' || !parentToolUseId) return undefined;
  return {
    parentToolUseId,
    type: typeof data?.subagent_type === 'string' ? data.subagent_type : null,
    description: typeof data?.task_description === 'string' ? data.task_description : null,
    model: typeof data?.message?.model === 'string' ? data.message.model : null,
  };
}

/** Flatten a `tool_result` block's content to the string shape every sink expects. Shared by the
 *  in-turn path and the orphan-subagent path so the two cannot drift. */
function toolResultText(block: any): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    const allText = block.content.every((item: any) => item?.type === 'text' && typeof item.text === 'string');
    return allText ? block.content.map((item: any) => item.text).join('\n') : JSON.stringify(block.content);
  }
  return JSON.stringify(block.content ?? '');
}

function subagentActivityKind(data: any): SubagentActivityKind | null {
  if (data.type === 'assistant') return 'assistant';
  if (data.type === 'user' && !data.isReplay) return 'tool_result';
  return null;
}

type ContinuationDelivery = (sink: ContinuationSink) => void;

/**
 * Extract the prompt text from a `--replay-user-messages` echo. `message.content` arrives either
 * as a bare string or as text blocks. Returns null for anything else — notably the tool_result
 * carriers print mode already emits as `user` lines, which must never be read as a prompt echo.
 */
export function extractReplayText(data: any): string | null {
  const content = data?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string);
  return parts.length ? parts.join('') : null;
}

/**
 * The narrow port the turn machine holds on the process half (`ClaudeSession`). One direction
 * only: `adapter.ts` imports this module, never the reverse.
 */
export interface TurnHost {
  readonly sessionId: string;
  readonly channel: string;
  readonly captureTranscriptLogs: boolean;
  readonly preserveUnreportedAccounting: boolean;
  readonly anthropicBaseUrl: string | undefined;
  /** `this.alive && !!this.proc?.stdin` — the injectUserMessage guard, named. */
  canWriteStdin(): boolean;
  writeTurnStdin(prompt: string): void;
  resetIdleTimer(): void;
  bumpTurnIdleTimer(): void;
  /** `if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer); this.turnIdleTimer = null;` */
  clearTurnIdleTimer(): void;
}

/** The turn half of a persistent Claude session: everything from a line on stdout to a settled
 *  turn, an accounting snapshot, or a continuation delivery. */
export class ClaudeTurnMachine {
  currentTurn: PendingTurn | null = null;
  /** Cursor over the `stream_event` sequence (--include-partial-messages). Session-scoped rather
   *  than turn-scoped because the stream is a property of the process, and every `message_start`
   *  resets it anyway. */
  private streamDeltaState: StreamDeltaState = createStreamDeltaState();
  /** Current provider-call usage plus configured/result-reconciled context window. */
  private contextUsageTracker: ClaudeContextUsageTracker;
  /** Tracks in-flight background tasks (run_in_background) for this session. */
  bgTracker = new BgTaskTracker();
  /** Set by orchestration to receive spontaneous background-task continuation turns. */
  continuationSink: ContinuationSink | null = null;
  /** One-shot events that arrived before completion-only waiting installed its sink. */
  private pendingContinuationDeliveries: ContinuationDelivery[] = [];
  /** Messages injected into an in-flight turn that the CLI has not echoed back yet, in write
   *  order. Each is popped by its `--replay-user-messages` echo (the delivery ack). */
  private pendingInjections: { prompt: string; text: string }[] = [];
  /** Set by orchestration to receive injection delivery acks. */
  private injectionAck: InjectionAckSink | null = null;
  /** Set when an injected message was consumed with NO turn in flight — the CLI is about to start
   *  a turn of its own for it. Consumed by the next assistant line, which opens the
   *  synthetic turn that captures the reply. */
  private injectionContinuationArmed = false;
  private cumulativeCostUsd: number = 0;
  /** Captured from result event's modelUsage key for cost_record. */
  lastModelName: string | null = null;
  /** Captured from result event's usage for legacy cost_record and compact accounting. */
  lastTokenUsage: TurnTokenUsage | null = null;

  constructor(private readonly host: TurnHost, contextUsageTracker: ClaudeContextUsageTracker) {
    this.contextUsageTracker = contextUsageTracker;
  }

  /** Deliver a synthetic interrupted result to the continuation sink (single-fire: the sink
   *  reference is cleared before invoking). Fires only when background work may still produce
   *  a continuation (or `force`, for a dying spontaneous turn); otherwise just clears the sink. */
  notifyBgInterrupted(force = false): void {
    const sink = this.continuationSink;
    if (!sink) return;
    this.continuationSink = null;
    // An injected message that was never echoed back, or one already consumed into a spontaneous
    // turn that never arrived, is work the caller is still waiting on — seal it like pending
    // background work rather than dropping the sink silently.
    const injectionOutstanding = this.pendingInjections.length > 0 || this.injectionContinuationArmed;
    if (!force && !this.bgTracker.hasPending() && !this.bgTracker.continuationArmed && !injectionOutstanding) return;
    const result: AgentResult = {
      sessionId: this.host.sessionId,
      total_cost_usd: null, num_turns: null,
      rateLimited: false, rateLimitMessage: null,
      planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
      finalOutput: null,
      pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0,
      backgroundInterrupted: true,
    };
    try { sink.onResult(result); } catch (e) { log.warn('bg-interrupted sink onResult threw:', (e as Error).message); }
  }

  createTurnStreams(userMessage: string): { rawStream: Writable; txtStream: Writable; pairKey: string | null; releaseCapture: (() => void) | null } {
    if (!this.host.captureTranscriptLogs) {
      const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
      return { rawStream: sink(), txtStream: sink(), pairKey: null, releaseCapture: null };
    }
    mkdirSync(LOGS_DIR, { recursive: true });
    const ts = readableTimestamp();
    const rawPath = path.join(LOGS_DIR, `claude-output-${ts}.jsonl`);
    const txtPath = path.join(LOGS_DIR, `claude-output-${ts}.txt`);
    const rawStream = createWriteStream(rawPath, { flags: 'a' });
    const txtStream = createWriteStream(txtPath, { flags: 'a' });
    const releaseCapture = activeClaudeCaptureRegistry.register(ts, [rawPath, txtPath]);
    txtStream.write(`=== Cortex session started at ${new Date().toISOString()} ===\n=== channel=${this.host.channel}, session=${this.host.sessionId} ===\n\n`);
    txtStream.write(`[user-input] ${userMessage}\n\n`);
    return { rawStream, txtStream, pairKey: ts, releaseCapture };
  }

  registerTurn(resolve: any, reject: any, streams: { rawStream: Writable; txtStream: Writable; pairKey: string | null; releaseCapture: (() => void) | null }, options: any): void {
    clearActivePlanFile(this.host.sessionId);
    this.currentTurn = {
      resolve, reject,
      resultData: null,
      planFilePath: null,
      enteredPlanMode: false,
      exitedPlanMode: false,
      askUserQuestions: [],
      finalOutput: null,
      longestOutput: null,
      turnCount: 0,
      subagentTurnCount: 0,
      capturePairKey: streams.pairKey,
      releaseCapture: streams.releaseCapture,
      onProgress: options.onProgress || null,
      onAssistantMessage: options.onAssistantMessage || null,
      onAssistantDelta: options.onAssistantDelta || null,
      onToolUse: options.onToolUse || null,
      onToolResult: options.onToolResult || null,
      onCompact: options.onCompact || null,
      onModelFallback: options.onModelFallback || null,
      onContextUsage: options.onContextUsage || null,
      onSubagentActivity: options.onSubagentActivity || null,
      onSubagentEnd: options.onSubagentEnd || null,
      rawStream: streams.rawStream,
      txtStream: streams.txtStream,
      killed: false,
    };
  }

  private deliverContinuation(delivery: ContinuationDelivery): void {
    const sink = this.continuationSink;
    if (!sink) {
      if (this.host.preserveUnreportedAccounting) this.pendingContinuationDeliveries.push(delivery);
      return;
    }
    try { delivery(sink); }
    catch (error) { log.warn('continuation sink threw:', (error as Error).message); }
  }

  /** Register/replace the continuation sink. Persists across normal turns; lives as long
   *  as the pooled session, until close()/kill(). */
  setContinuationSink(sink: ContinuationSink): void {
    this.continuationSink = sink;
    const pending = this.pendingContinuationDeliveries.splice(0);
    for (const delivery of pending) this.deliverContinuation(delivery);
  }

  clearContinuationSink(): void {
    this.continuationSink = null;
    this.pendingContinuationDeliveries.length = 0;
  }

  /** Register/replace the injection delivery-ack sink. Lifetime mirrors continuationSink. */
  setInjectionAckSink(sink: InjectionAckSink): void {
    this.injectionAck = sink;
  }

  clearInjectionAckSink(): void {
    this.injectionAck = null;
  }

  /**
   * Deliver a user message into the turn already in flight.
   *
   * Writes the SAME NDJSON user line a normal turn writes, but registers NO turn: the message is
   * absorbed by the run already in progress, so the already-awaited turn promise covers it and no
   * second result is fabricated. Cost/turn accounting stays with the running turn.
   *
   * Where it lands is a race the caller cannot control, so both outcomes are wired here:
   *   - tool-result boundary → folds into the running turn, ONE result. Nothing extra
   *     to do; the turn's own callbacks carry the reply.
   *   - mid-text-generation → the CLI drains its queue only after this turn's result and then
   *     starts a turn of its own. The echo handler arms the existing spontaneous-turn
   *     path so that reply is captured by continuationSink instead of dropped.
   *
   * Returns false when there is no live process or no active turn — the caller then falls back to
   * the normal queue.
   */
  injectUserMessage(message: UserMessage): boolean {
    if (!this.host.canWriteStdin()) return false;
    // No turn in flight ⇒ nothing to inject INTO. A message written here would open an untracked
    // turn whose reply nobody is awaiting; the caller must enqueue it as a normal turn instead.
    if (!this.currentTurn) return false;

    const files = (message.attachments || []).map((a) => ({
      mimetype: a.mimeType, localPath: a.path, name: path.basename(a.path),
    }));
    const prompt = buildPrompt(message.text, files);
    try {
      this.host.writeTurnStdin(prompt);
    } catch {
      // writeTurnStdin already marked the session dead and rejected the in-flight turn — the pipe
      // is gone, so report "cannot inject" rather than propagating into the caller's routing.
      return false;
    }
    this.pendingInjections.push({ prompt, text: message.text });
    this.host.resetIdleTimer();
    this.host.bumpTurnIdleTimer();
    log.info(`Injected mid-turn message into ${this.host.sessionId.substring(0, 8)} (${prompt.length} chars)`);
    return true;
  }

  /**
   * Handle a `--replay-user-messages` echo. The CLI echoes EVERY user message, so most echoes are
   * the turn's own opening prompt and must be ignored; only an echo matching the head of the
   * pending-injection queue is a delivery ack. Nothing else in the system reads these events.
   */
  private handleReplayEcho(data: any): void {
    const text = extractReplayText(data);
    if (text === null) return;
    const head = this.pendingInjections[0];
    if (!head || head.prompt !== text) return; // the turn's own prompt (or a tool_result carrier)
    this.pendingInjections.shift();
    // Consumed with no turn in flight ⇒ this is the post-result outcome: the CLI is starting a turn
    // of its own. Arm the spontaneous-turn capture before its first assistant line arrives.
    const foldedIntoTurn = !!this.currentTurn;
    if (!foldedIntoTurn) this.injectionContinuationArmed = true;
    const ack = this.injectionAck;
    if (!ack) return;
    try { ack.onDelivered({ text: head.text, foldedIntoTurn }); }
    catch (e) { log.warn('injection onDelivered threw:', (e as Error).message); }
  }

  private continuationCallbacks() {
    return {
      resolve: (value: any) => this.deliverContinuation(sink => sink.onResult(value as AgentResult)),
      reject: (error: Error) => log.warn('continuation turn rejected:', error?.message ?? String(error)),
      onAssistantMessage: (
        text: string, _blockId?: string, model?: string | null, subagent?: ToolUseSubagent,
      ) => this.deliverContinuation(sink => sink.onAssistantText(text, model, subagent)),
      onToolUse: (name: string, input: any, id: string, subagent?: ToolUseSubagent) =>
        this.deliverContinuation(sink => sink.onToolUse?.(name, input, id, subagent)),
      onToolResult: (id: string, content: string, isError: boolean, subagent?: ToolUseSubagent) =>
        this.deliverContinuation(sink => sink.onToolResult?.(id, content, isError, subagent)),
      onContextUsage: (usage: ContextUsage) =>
        this.deliverContinuation(sink => sink.onContextUsage?.(usage)),
      onModelFallback: null,
    };
  }

  /** Open a synthetic turn to capture the spontaneous continuation the CLI emits after a
   *  background task finishes. Its output is delivered or buffered for continuationSink. */
  private openContinuationTurn(label = '[background-task continuation]'): void {
    this.bgTracker.disarmContinuation();
    const streams = this.createTurnStreams(label);
    // The hold's watchdogs bound the WAIT for this turn, not the turn itself: a continuation
    // that runs longer than the grace/max-wait window must not be sealed idle mid-stream.
    this.deliverContinuation(sink => sink.onTurnOpen?.());
    this.currentTurn = {
      ...this.continuationCallbacks(),
      resultData: null, planFilePath: null,
      enteredPlanMode: false, exitedPlanMode: false,
      askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0, subagentTurnCount: 0,
      capturePairKey: streams.pairKey,
      releaseCapture: streams.releaseCapture,
      onProgress: null, onAssistantDelta: null, onCompact: null, onSubagentActivity: null,
      onSubagentEnd: null,
      rawStream: streams.rawStream, txtStream: streams.txtStream,
      killed: false, spontaneous: true,
    };
  }

  compactUsage(result: AgentResult): AgentCompactUsage | null {
    const tokens = this.lastTokenUsage;
    if (!tokens && !result.total_cost_usd) return null;
    return {
      inputTokens: tokens?.input ?? 0,
      outputTokens: tokens?.output ?? 0,
      cacheReadTokens: tokens?.cacheRead ?? 0,
      cacheWriteTokens: tokens?.cacheCreation ?? 0,
      costUsd: result.total_cost_usd,
    };
  }

  private turnCost(data: any): number {
    if (data.total_cost_usd == null) return 0;
    const cumulativeCost = data.total_cost_usd;
    const turnCost = cumulativeCost - this.cumulativeCostUsd;
    this.cumulativeCostUsd = cumulativeCost;
    return turnCost > 0 ? turnCost : 0;
  }

  private captureTurnAccounting(data: any): number {
    const missingToken = this.host.preserveUnreportedAccounting ? null : 0;
    this.lastTokenUsage = data.usage ? {
      input: data.usage.input_tokens ?? missingToken,
      output: data.usage.output_tokens ?? missingToken,
      cacheCreation: data.usage.cache_creation_input_tokens ?? missingToken,
      cacheRead: data.usage.cache_read_input_tokens ?? missingToken,
    } : null;
    const models = data.modelUsage ? Object.keys(data.modelUsage) : [];
    this.lastModelName = models[0] ?? null;
    return this.turnCost(data);
  }

  private reportedAccounting(data: any): ReportedAccountingSnapshot {
    const usage = data.usage;
    const turnUsage = usage ? {
      input: tokenValue(usage.input_tokens),
      output: tokenValue(usage.output_tokens),
      cacheCreation: tokenValue(usage.cache_creation_input_tokens),
      cacheRead: tokenValue(usage.cache_read_input_tokens),
    } : null;
    return {
      usageReported: usage != null,
      inputTokens: turnUsage?.input ?? null,
      outputTokens: turnUsage?.output ?? null,
      cacheReadTokens: turnUsage?.cacheRead ?? null,
      cacheCreationTokens: turnUsage?.cacheCreation ?? null,
      ...promptAccounting(turnUsage),
      model: data.modelUsage ? Object.keys(data.modelUsage)[0] ?? null : null,
    };
  }

  private settleResultTurn(
    turn: PendingTurn, data: any, result: ReturnType<typeof extractResult>,
  ): void {
    if (result.resolved) {
      const value = result.value as AgentResult;
      value.reportedAccounting = this.reportedAccounting(data);
      if (this.host.preserveUnreportedAccounting) {
        value.costReported = data.total_cost_usd != null;
      }
      value.pendingBackgroundTasks = this.bgTracker.pendingCount;
      // A background notification observed during this turn whose own turn has not opened yet
      // (it landed while the model was producing this turn's final text) is one more delivery
      // still owed: the CLI opens that turn right after this result. Count it as undelivered so
      // the hold waits (grace-bounded) instead of sealing idle between the two turns.
      value.undeliveredBackgroundTasks = this.bgTracker.undeliveredCount
        + (this.bgTracker.continuationArmed ? 1 : 0);
    }
    this.currentTurn = null;
    this.host.clearTurnIdleTimer();
    const formatted = formatEvent(data);
    if (formatted) turn.txtStream.write(formatted + '\n');
    turn.txtStream.write(`\n=== Turn finished at ${new Date().toISOString()} ===\n`);
    turn.rawStream.end();
    turn.txtStream.end();
    turn.releaseCapture?.();
    turn.releaseCapture = null;
    if (result.resolved) turn.resolve(result.value);
    else turn.reject(result.error);
  }

  private handleResultEvent(turn: PendingTurn, data: any): void {
    turn.resultData = { ...data, total_cost_usd: this.captureTurnAccounting(data) };
    const result = extractResult(turn.resultData, this.host.sessionId, false, 0, '',
      turn.planFilePath, turn.enteredPlanMode, turn.exitedPlanMode, turn.askUserQuestions,
      turn.finalOutput, turn.longestOutput);
    this.settleResultTurn(turn, data, result);
  }

  /** Preserve the complete result carrier that print mode emits as a `user` content block. */
  private handleToolResultEvent(turn: PendingTurn, data: any): void {
    if (typeof turn.onToolResult !== 'function') return;
    const content = data.message?.content;
    if (!Array.isArray(content)) return;
    // A `user` line carrying subagent linkage is the subagent's OWN tool result, not the parent's.
    // The parent's `Agent`/`Task` result arrives unlinked, as an ordinary main-agent line.
    const subagent = subagentAttribution(data);
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      try { turn.onToolResult(toolUseId, toolResultText(block), block.is_error === true, subagent); }
      catch (e) { log.warn('onToolResult threw:', (e as Error).message); }
    }
  }

  /**
   * A backgrounded subagent's own `assistant`/`user` line arriving with no turn open. Routed here
   * by `routeLine` → 'subagent-orphan' instead of being dropped. Deliberately minimal: it feeds
   * the continuation sink the same three attributed callbacks the in-turn path uses, and touches
   * NO turn bookkeeping (no turn counts, no finalOutput, no plan-file capture, no delta cursor) —
   * there is no turn here to account for, and the main agent's next real turn must not inherit
   * anything from a subagent that ran beside it.
   */
  private handleOrphanSubagentLine(data: any): void {
    const subagent = subagentAttribution(data);
    if (!subagent) return;
    const content = data.message?.content;
    if (!Array.isArray(content)) return;
    const model = typeof data.message?.model === 'string' ? data.message.model : null;
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        this.deliverContinuation(s => s.onToolUse?.(block.name || '?', block.input || {}, id, subagent));
      } else if (block.type === 'text' && block.text) {
        this.deliverContinuation(s => s.onAssistantText(block.text, model, subagent));
      } else if (block.type === 'tool_result') {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        this.deliverContinuation(
          s => s.onToolResult?.(id, toolResultText(block), block.is_error === true, subagent),
        );
      }
    }
  }

  private handleAssistantToolBlock(turn: PendingTurn, block: any, subagent?: ToolUseSubagent): void {
    if (block.name === 'Write' && isPlanFilePath(block.input?.file_path)) {
      turn.planFilePath = block.input.file_path;
      setActivePlanFile(this.host.sessionId, block.input.file_path);
    }
    if (block.name === 'EnterPlanMode') turn.enteredPlanMode = true;
    if (block.name === 'ExitPlanMode') turn.exitedPlanMode = true;
    if (typeof turn.onToolUse !== 'function') return;
    try {
      turn.onToolUse(block.name || '?', block.input || {}, typeof block.id === 'string' ? block.id : '', subagent);
    } catch (error) {
      log.warn('onToolUse threw:', (error as Error).message);
    }
  }

  private handleAssistantTextBlock(
    turn: PendingTurn, data: any, block: any, subagent?: ToolUseSubagent,
  ): void {
    if (!block.text) return;
    const model = typeof data.message?.model === 'string' ? data.message.model : null;
    // A subagent's text is NOT this turn's answer, and it did not stream: the CLI attaches subagent
    // linkage only to complete `assistant`/`user` messages, never to `stream_event`. So it must not
    // become finalOutput, must not win longestOutput, and — above all — must not consume the delta
    // cursor, which belongs to a main-agent block still being streamed.
    if (subagent) {
      turn.onAssistantMessage?.(block.text, undefined, model, subagent);
      return;
    }
    turn.finalOutput = block.text;
    if (block.text.length > (turn.longestOutput?.length || 0)) turn.longestOutput = block.text;
    const blockId = takeTextBlockId(this.streamDeltaState) ?? undefined;
    const streamedModel = this.streamDeltaState.messageId === data.message?.id
      ? this.streamDeltaState.model
      : null;
    turn.onAssistantMessage?.(block.text, blockId, model ?? streamedModel);
  }

  private handleAssistantEvent(turn: PendingTurn, data: any): void {
    // Every line still walks every branch below — subagent lines are TAGGED, never dropped, so the
    // journal keeps a complete trajectory. What the tag changes is attribution: a subagent's turns
    // are counted apart from the main agent's, and its text cannot be mistaken for the answer.
    const subagent = subagentAttribution(data);
    if (subagent) turn.subagentTurnCount += 1;
    else turn.turnCount += 1;
    for (const block of (data.message?.content || [])) {
      if (block.type === 'tool_use') this.handleAssistantToolBlock(turn, block, subagent);
      if (block.type === 'text') this.handleAssistantTextBlock(turn, data, block, subagent);
    }
    // A subagent's message did not advance the main agent's turn, so re-rendering progress would
    // redraw the same number. The JSONL path withholds turn_progress on sidechain records for the
    // same reason.
    if (!subagent) {
      turn.onProgress?.({ num_turns: turn.turnCount, total_cost_usd: null, duration_ms: null });
    }
  }

  private emitContextUsage(data: unknown): void {
    const usage = this.contextUsageTracker.observe(data);
    const callback = this.currentTurn?.onContextUsage;
    if (!usage || typeof callback !== 'function') return;
    try { callback(usage); }
    catch (e) { log.warn('onContextUsage threw:', (e as Error).message); }
  }

  /**
   * OC-11 / §17 G4-SA5 — read the linkage the CLI already puts on the wire. A non-null
   * `parent_tool_use_id` means the line is a native subagent's output; `null` or absent is the
   * parent's own turn. Purely ADDITIVE: every branch above still sees the line, because
   * `adapter.ts` is shared by every Cortex session and diverting subagent output would change
   * assistant streaming and turn counting for every product surface.
   */
  private emitSubagentActivity(data: any): void {
    const parentToolUseId = data?.parent_tool_use_id;
    if (typeof parentToolUseId !== 'string') return;
    const kind = subagentActivityKind(data);
    if (!kind) return;
    const subagentType = typeof data.subagent_type === 'string' ? data.subagent_type : null;
    const callback = this.currentTurn?.onSubagentActivity;
    if (typeof callback !== 'function') return;
    try { callback(parentToolUseId, subagentType, kind); }
    catch (e) { log.warn('onSubagentActivity threw:', (e as Error).message); }
  }

  private emitModelFallback(data: any): void {
    const event = parseModelFallbackEvent(data);
    const callback = this.currentTurn?.onModelFallback;
    if (!event || !callback) return;
    try {
      callback({ originalModel: event.originalModel, fallbackModel: event.fallbackModel });
    } catch (e) { log.warn('onModelFallback threw:', (e as Error).message); }
  }

  handleLine(line: string) {
    if (!line) return;
    this.host.resetIdleTimer();
    this.host.bumpTurnIdleTimer();

    let parsed: any;
    let isJson = false;
    try { parsed = JSON.parse(line); isJson = true; } catch { /* handled below */ }

    // `stream_event` lines are the token-level preview of a block the CLI will also deliver
    // complete. They dominate stdout once --include-partial-messages is on (measured: 74-86% of
    // all lines), and everything they carry is repeated verbatim by the complete event, so they
    // are deliberately kept out of the per-turn raw jsonl and the daemon log. Handled first, and
    // separately, because everything below is about complete events.
    if (isJson && parsed?.type === 'stream_event') {
      this.emitContextUsage(parsed);
      const delta = parseStreamEvent(parsed, this.streamDeltaState);
      if (delta && typeof this.currentTurn?.onAssistantDelta === 'function') {
        try { this.currentTurn.onAssistantDelta(delta.text, delta.blockId); }
        catch (e) { log.warn('onAssistantDelta threw:', (e as Error).message); }
      }
      return;
    }

    if (this.currentTurn?.rawStream) this.currentTurn.rawStream.write(line + '\n');

    try {
      const data = parsed;
      if (!isJson) throw new Error('not json');
      // Context compaction boundary: invalidate the old provider-call cursor immediately, then
      // surface the boundary to the active turn so observers (e.g. Slack) can notify.
      if (data.type === 'system' && data.subtype === 'compact_boundary') this.emitContextUsage(data);
      if (data.type === 'system' && data.subtype === 'compact_boundary' && this.currentTurn?.onCompact) {
        const meta = data.compact_metadata ?? {};
        try {
          this.currentTurn.onCompact({
            trigger: typeof meta.trigger === 'string' ? meta.trigger : 'auto',
            preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined,
          });
        } catch (e) { log.warn('onCompact threw:', (e as Error).message); }
      }
      this.emitModelFallback(data);
      if (data.type === 'rate_limit_event' && data.rate_limit_info) {
        const mode = this.host.anthropicBaseUrl?.match(/\/m\/([^/]+)\//)?.[1] || undefined;
        handleRateLimitEvent(data.rate_limit_info, {
          provider: 'anthropic', displayName: 'Anthropic', mode,
        }).catch(e => log.error('handleRateLimitEvent error:', e));
      }
      // `--replay-user-messages` echo: the CLI's delivery ack for an injected message.
      // Handled here and nowhere else — it is deliberately NOT fed to turn bookkeeping, background
      // tracking, or conversation history (a `user` record there would shift every later turn
      // index and break edit/rewind). Replays are inert for every other consumer.
      if (data.type === 'user' && data.isReplay) this.handleReplayEcho(data);
      if (data.type === 'user' && !data.isReplay && this.currentTurn) this.handleToolResultEvent(this.currentTurn, data);
      // Track background-task lifecycle on every line (even with no active turn) so the
      // pending count stays accurate across the turn boundary.
      this.bgTracker.observe(data);
      // Authoritative end-of-subagent, forwarded whether or not a turn is open: a subagent can
      // finish inside its parent turn as easily as beside it, and `subagentEndFor` is consuming,
      // so the signal is emitted exactly once either way.
      const subagentEnd = this.bgTracker.subagentEndFor(data);
      if (subagentEnd) {
        // In-turn first: a subagent that finishes while its parent turn is still open has no
        // continuation sink to reach (one is registered only when the turn ends holding background
        // work), and `subagentEndFor` is consuming — dropping it here loses the end for good.
        const inTurn = this.currentTurn?.onSubagentEnd;
        if (inTurn) {
          try { inTurn(subagentEnd.parentToolUseId, subagentEnd.status); }
          catch (e) { log.warn('onSubagentEnd threw:', (e as Error).message); }
        } else {
          this.deliverContinuation(
            s => s.onSubagentEnd?.(subagentEnd.parentToolUseId, subagentEnd.status),
          );
        }
      }
      // A backgrounded subagent keeps working after its parent turn closed, and the CLI keeps
      // streaming its lines. With no turn open the branches above skip them, so route them to the
      // continuation sink here — otherwise the whole tail of a background agent's trajectory
      // (tool calls AND its final report) is received and then dropped.
      if (!this.currentTurn && routeLine(this.bgTracker, data, false) === 'subagent-orphan') {
        this.handleOrphanSubagentLine(data);
      }
      // No active turn, and the model just started speaking anyway: either a background task
      // finished (bgTracker armed) or an injected message was consumed after this turn's result
      // Both make the CLI open a turn of its own — open a synthetic turn for it so its
      // output is routed (to continuationSink) instead of being dropped.
      const canCaptureContinuation = this.continuationSink || this.host.preserveUnreportedAccounting;
      if (!this.currentTurn && canCaptureContinuation && data.type === 'assistant'
          && (this.injectionContinuationArmed || routeLine(this.bgTracker, data, false) === 'open-continuation')) {
        const fromInjection = this.injectionContinuationArmed;
        this.injectionContinuationArmed = false;
        this.openContinuationTurn(fromInjection ? '[injected-message continuation]' : '[background-task continuation]');
      }
      if (data.type === 'result' && this.currentTurn) {
        // A task-notification turn's result can only settle a spontaneous turn. When it lands on
        // a user turn it is the CLI closing a notification turn of its own — on `--resume` it
        // reports background work orphaned by the previous process and emits a 0-turn result
        // BEFORE reading the prompt on stdin. Settling here resolved the user turn empty in ~2s
        // and dropped the minutes of real work that followed (2026-09-06 investigation).
        if (isContinuationResult(data) && !this.currentTurn.spontaneous) {
          log.info(`Ignoring notification-turn result on user turn ${this.host.sessionId.substring(0, 8)} (num_turns=${data.num_turns ?? '?'})`);
          this.currentTurn.txtStream.write('[notification-turn result ignored — user turn still open]\n');
          return;
        }
        this.emitContextUsage(data);
        this.handleResultEvent(this.currentTurn, data);
        return;
      }
      if (data.type === 'assistant' && this.currentTurn) this.handleAssistantEvent(this.currentTurn, data);
      // Emitted last so the census event trails the normalized events the same line already
      // produced, keeping contiguous tool batches contiguous for the ATIF grouper.
      this.emitSubagentActivity(data);
      const formatted = formatEvent(data);
      if (formatted && this.currentTurn?.txtStream) this.currentTurn.txtStream.write(formatted + '\n');
    } catch {
      if (this.currentTurn?.txtStream) this.currentTurn.txtStream.write(`[raw] ${line}\n`);
    }
    log.info('stream:', line.substring(0, 200));
  }

  private closeTurnLogs(turn: PendingTurn) {
    try {
      turn.txtStream.write(`\n=== Turn ended at ${new Date().toISOString()} ===\n`);
      turn.rawStream.end();
      turn.txtStream.end();
    } catch {}
    turn.releaseCapture?.();
    turn.releaseCapture = null;
  }

  // --- Blocks the process half hands over, each lifted verbatim from the method it came out of ---

  /** The `if (this.currentTurn)` block of `ClaudeSession.handleProcessClose`. */
  abortTurnOnProcessClose(code: number | null, stderr: string): void {
    if (this.currentTurn) {
      const turn = this.currentTurn;
      this.currentTurn = null;
      this.closeTurnLogs(turn);
      this.host.clearTurnIdleTimer();
      if (turn.spontaneous) {
        // The process died mid-continuation. The spontaneous turn has no awaiting caller —
        // its reject would only log — so deliver the interruption to the sink directly
        // (single-fire; the resolve path never ran because no result event arrived).
        this.notifyBgInterrupted(true);
      } else if (turn.killed) {
        turn.reject(new CancelledError());
      } else {
        const result = extractResult(turn.resultData, this.host.sessionId, false, code || 1, stderr,
          turn.planFilePath, turn.enteredPlanMode, turn.exitedPlanMode, turn.askUserQuestions,
          turn.finalOutput, turn.longestOutput);
        if (result.resolved) turn.resolve(result.value);
        else turn.reject(result.error);
      }
    }
  }

  /** The `if (this.currentTurn)` block of `ClaudeSession.writeTurnStdin`'s catch. */
  failInFlightTurn(error: Error): void {
    if (this.currentTurn) {
      const turn = this.currentTurn;
      this.currentTurn = null;
      this.closeTurnLogs(turn);
      turn.reject(error);
    }
  }

  /** The hold `ClaudeSession.resetIdleTimer` consults before arming idle-close. */
  holdsIdle(): boolean {
    return this.bgTracker.hasPending() || this.pendingInjections.length > 0 || this.injectionContinuationArmed;
  }

  markCurrentTurnKilled(): void {
    if (this.currentTurn) this.currentTurn.killed = true;
  }
}
