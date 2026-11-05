import { createWriteStream, mkdirSync } from 'fs';
import { Writable } from 'stream';
import * as path from 'path';
import { readableTimestamp } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { handleAssistantBlocks } from './assistant-blocks.js';
import type {
  AgentCompactUsage, BackgroundTurnSink, InjectionAckSink, RateLimitObservation, RateLimitOrigin,
  UserMessage,
} from '../types.js';
import type { AgentResult, ContextUsage, ReportedAccountingSnapshot, ToolResultImage } from '@core/types/agent-types.js';
import type { ToolUseSubagent } from '../normalize/event-types.js';
import { toolResultImages } from '../normalize/tool-result-images.js';
import { CancelledError, LOGS_DIR } from './defaults.js';
import {
  buildPrompt,
  clearActivePlanFile,
  extractResult,
  formatEvent,
  createStreamDeltaState,
  parseStreamEvent,
  type ApiRetryEvent,
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
import { reportSystemLine } from './system-lines.js';
import { toolResultText } from './tool-result-text.js';
import { foregroundCallbacks, freshTurnState, type TurnStreams } from './turn-state.js';

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
  onAssistantThinking: ((text: string, blockId?: string) => void) | null;
  onAssistantThinkingDelta: ((text: string, blockId: string) => void) | null;
  /** `subagent` is set only when a native subagent made the call (see ToolUseSubagent).
   *  Optional so existing implementations that ignore attribution still satisfy the type. */
  onToolUse: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  onToolResult: ((
    toolUseId: string, content: string, isError: boolean, subagent?: ToolUseSubagent,
    images?: ToolResultImage[],
  ) => void) | null;
  onCompact: ((info: { trigger: string; preTokens?: number }) => void) | null;
  onModelFallback: ((event: Omit<ModelFallbackEvent, 'type'>) => void) | null;
  onApiRetry: ((event: Omit<ApiRetryEvent, 'type'>) => void) | null;
  onContextUsage: ((usage: ContextUsage) => void) | null;
  /** OC-11 / §17 G4-SA5: one census call per native-subagent line, carrying only the linkage. */
  onSubagentActivity: ((
    parentToolUseId: string, subagentType: string | null, kind: SubagentActivityKind,
  ) => void) | null;
  /** Authoritative end of one subagent spawned by this turn. A backgrounded child can reach its
   *  terminal state while the parent turn is still open, so the signal needs an in-turn route —
   *  the background-turn sink only exists once the turn has ended and a background hold is up. */
  onSubagentEnd: ((
    parentToolUseId: string, status: SubagentEndStatus,
  ) => void) | null;
  rawStream: Writable;
  txtStream: Writable;
  killed: boolean;
  /** Why the turn was killed, when it was not a cancel (the idle watchdog). */
  killError?: Error;
  /** True for a synthetic turn opened to capture a background-task continuation
   *  (the spontaneous turn the CLI emits after a run_in_background task finishes). */
  spontaneous?: boolean;
  /** Set by the prompt's `--replay-user-messages` echo: the CLI has read this turn's prompt, so
   *  every result from here on is this turn's, whatever its origin. */
  promptConsumed?: boolean;
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

function subagentActivityKind(data: any): SubagentActivityKind | null {
  if (data.type === 'assistant') return 'assistant';
  if (data.type === 'user' && !data.isReplay) return 'tool_result';
  return null;
}

type ContinuationDelivery = (sink: BackgroundTurnSink) => void;

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

/** A stdout line as JSON; undefined when it is not JSON. */
function parseLine(line: string): any {
  try { return JSON.parse(line); } catch { return undefined; }
}

/**
 * The narrow port the turn machine holds on the process half (`ClaudeSession`). One direction
 * only: `adapter.ts` imports this module, never the reverse.
 */
export interface TurnHost {
  readonly sessionId: string;
  readonly channel: string;
  readonly captureTranscriptLogs: boolean;
  /** The connection this session was routed on; rate limits are filed under it. */
  readonly connection: string | undefined;
  /** Hand a provider rate-limit window to whoever owns throttle policy. Deliberately NOT a turn
   *  event: the CLI emits `rate_limit_event` with no turn in flight (between turns, and during a
   *  spontaneous continuation turn), which is exactly when the notice matters most, so routing it
   *  through the per-turn callback bag or the run's event stream would drop it. */
  reportRateLimit(info: RateLimitObservation, origin: RateLimitOrigin): Promise<void>;
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
  backgroundTurnSink: BackgroundTurnSink | null = null;
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

  /** Deliver a synthetic interrupted result to the background-turn sink (single-fire: the sink
   *  reference is cleared before invoking). Fires only when background work may still produce
   *  a continuation (or `force`, for a dying spontaneous turn); otherwise just clears the sink. */
  notifyBgInterrupted(force = false): void {
    const sink = this.backgroundTurnSink;
    if (!sink) return;
    this.backgroundTurnSink = null;
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

  createTurnStreams(userMessage: string): TurnStreams {
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

  registerTurn(resolve: any, reject: any, streams: TurnStreams, options: any): void {
    clearActivePlanFile(this.host.sessionId);
    this.displaceOpenTurn();
    this.currentTurn = { resolve, reject, ...freshTurnState(streams), ...foregroundCallbacks(options) };
  }

  /**
   * A turn is registering while a user turn is still open: a second run reached this session
   * mid-turn. The CLI folds the new prompt into its running loop and emits one result, which now
   * belongs to the new turn. Settle the open turn with what it produced so far — overwritten
   * silently, its run never ended and kept the session busy (2026-11-04).
   */
  private displaceOpenTurn(): void {
    const turn = this.currentTurn;
    if (!turn || turn.spontaneous) return;
    log.info(`New turn on ${this.host.sessionId.substring(0, 8)} while a user turn is open; settling the open one`);
    turn.txtStream.write('[displaced by a new turn — the loop result goes to that turn]\n');
    const result = extractResult(null, this.host.sessionId, 0, '',
      turn.planFilePath, turn.enteredPlanMode, turn.exitedPlanMode, turn.finalOutput, turn.longestOutput);
    this.settleResultTurn(turn, {}, result);
  }

  private deliverContinuation(delivery: ContinuationDelivery): void {
    const sink = this.backgroundTurnSink;
    if (!sink) return;
    try { delivery(sink); }
    catch (error) { log.warn('background-turn sink threw:', (error as Error).message); }
  }

  /** Register/replace the background-turn sink. Persists across normal turns; lives as long
   *  as the pooled session, until close()/kill(). */
  setBackgroundTurnSink(sink: BackgroundTurnSink): void {
    this.backgroundTurnSink = sink;
  }

  /** Register/replace the injection delivery-ack sink. Lifetime mirrors backgroundTurnSink. */
  setInjectionAckSink(sink: InjectionAckSink): void {
    this.injectionAck = sink;
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
   *     path so that reply is captured by backgroundTurnSink instead of dropped.
   *
   * Returns false when there is no live process or no active turn — the caller then falls back to
   * the normal queue.
   */
  injectUserMessage(message: UserMessage): boolean {
    if (!this.host.canWriteStdin()) return false;
    // No turn in flight ⇒ nothing to inject INTO. A message written here would open an untracked
    // turn whose reply nobody is awaiting; the caller must enqueue it as a normal turn instead.
    if (!this.currentTurn) return false;

    const prompt = buildPrompt(message.text, message.attachments ?? []);
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
    if (text === null) return; // a tool_result carrier
    const head = this.pendingInjections[0];
    if (!head || head.prompt !== text) { this.notePromptEcho(data, text); return; }
    this.pendingInjections.shift();
    // Consumed with no turn in flight ⇒ this is the post-result outcome: the CLI is starting a turn
    // of its own. Arm the spontaneous-turn capture before its first assistant line arrives.
    const foldedIntoTurn = !!this.currentTurn;
    if (!foldedIntoTurn) this.injectionContinuationArmed = true;
    this.ackDelivered(head.text, foldedIntoTurn, data.uuid);
  }

  /** An echo that is not an injection is the open turn's own prompt being read — unless it is a
   *  background notification the CLI folded into the loop, which says nothing about the prompt.
   *  Older CLIs echo those without `origin` (2026-08-21 logs), hence the text check. */
  private notePromptEcho(data: any, text: string): void {
    const notification = data.origin?.kind === 'task-notification' || text.startsWith('<task-notification>');
    if (this.currentTurn && !notification) this.currentTurn.promptConsumed = true;
  }

  /** `uuid` is the echo's: the id of the transcript entry the message was written as. */
  private ackDelivered(text: string, foldedIntoTurn: boolean, uuid: unknown): void {
    const ack = this.injectionAck;
    if (!ack) return;
    const position = typeof uuid === 'string' && uuid ? { before: uuid } : undefined;
    try { ack.onDelivered({ text, foldedIntoTurn, ...(position ? { position } : {}) }); }
    catch (e) { log.warn('injection onDelivered threw:', (e as Error).message); }
  }

  private continuationCallbacks() {
    return {
      resolve: (value: any) => this.deliverContinuation(sink => sink.onResult(value as AgentResult)),
      reject: (error: Error) => log.warn('continuation turn rejected:', error?.message ?? String(error)),
      onAssistantMessage: (
        text: string, _blockId?: string, model?: string | null, subagent?: ToolUseSubagent,
      ) => this.deliverContinuation(sink => sink.onAssistantText(text, model, subagent)),
      onAssistantThinking: (text: string, blockId?: string) =>
        this.deliverContinuation(sink => sink.onAssistantThinking?.(text, blockId)),
      onToolUse: (name: string, input: any, id: string, subagent?: ToolUseSubagent) =>
        this.deliverContinuation(sink => sink.onToolUse?.(name, input, id, subagent)),
      onToolResult: (
        id: string, content: string, isError: boolean, subagent?: ToolUseSubagent, images?: ToolResultImage[],
      ) => this.deliverContinuation(sink => sink.onToolResult?.(id, content, isError, subagent, images)),
      onContextUsage: (usage: ContextUsage) =>
        this.deliverContinuation(sink => sink.onContextUsage?.(usage)),
      onModelFallback: null,
      onApiRetry: null,
    };
  }

  /** Open a synthetic turn to capture the spontaneous continuation the CLI emits after a
   *  background task finishes (or after an injected message it consumed with no turn in flight).
   *  Its output is delivered or buffered for backgroundTurnSink. */
  private openContinuationTurn(fromInjection: boolean): void {
    const summaries = this.bgTracker.disarmContinuation();
    const label = fromInjection ? '[injected-message continuation]' : '[background-task continuation]';
    const streams = this.createTurnStreams(label);
    // The hold's watchdogs bound the WAIT for this turn, not the turn itself: a continuation
    // that runs longer than the grace/max-wait window must not be sealed idle mid-stream.
    const wake = fromInjection ? undefined : { summaries };
    this.deliverContinuation(sink => sink.onTurnOpen?.(wake));
    this.currentTurn = {
      ...this.continuationCallbacks(),
      resultData: null, planFilePath: null,
      enteredPlanMode: false, exitedPlanMode: false,
      finalOutput: null, longestOutput: null, turnCount: 0, subagentTurnCount: 0,
      capturePairKey: streams.pairKey,
      releaseCapture: streams.releaseCapture,
      onProgress: null, onAssistantDelta: null, onCompact: null, onSubagentActivity: null,
      onSubagentEnd: null, onAssistantThinkingDelta: null,
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

  /** Start a fresh process's cost cursor at the total the CLI restored on `--resume` (0 for a new
   *  session): `total_cost_usd` is cumulative across processes, so a zero cursor would bill the
   *  first resumed turn the whole session history. */
  resetCostBaseline(restoredUsd: number): void {
    this.cumulativeCostUsd = restoredUsd;
  }

  private turnCost(data: any): number {
    if (data.total_cost_usd == null) return 0;
    const cumulativeCost = data.total_cost_usd;
    const turnCost = cumulativeCost - this.cumulativeCostUsd;
    this.cumulativeCostUsd = cumulativeCost;
    return turnCost > 0 ? turnCost : 0;
  }

  private captureTurnAccounting(data: any): number {
    this.lastTokenUsage = data.usage ? {
      input: data.usage.input_tokens ?? 0,
      output: data.usage.output_tokens ?? 0,
      cacheCreation: data.usage.cache_creation_input_tokens ?? 0,
      cacheRead: data.usage.cache_read_input_tokens ?? 0,
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
    const result = extractResult(turn.resultData, this.host.sessionId, 0, '',
      turn.planFilePath, turn.enteredPlanMode, turn.exitedPlanMode, turn.finalOutput, turn.longestOutput);
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
      const images = toolResultImages(block.content);
      try {
        turn.onToolResult(
          toolUseId, toolResultText(block), block.is_error === true, subagent, images.length ? images : undefined,
        );
      } catch (e) { log.warn('onToolResult threw:', (e as Error).message); }
    }
  }

  /**
   * A backgrounded subagent's own `assistant`/`user` line arriving with no turn open. Routed here
   * by `routeLine` → 'subagent-orphan' instead of being dropped. Deliberately minimal: it feeds
   * the background-turn sink the same three attributed callbacks the in-turn path uses, and touches
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
        const images = toolResultImages(block.content);
        this.deliverContinuation(s => s.onToolResult?.(
          id, toolResultText(block), block.is_error === true, subagent, images.length ? images : undefined,
        ));
      }
    }
  }

  private handleAssistantEvent(turn: PendingTurn, data: any): void {
    handleAssistantBlocks(turn, data, this.streamDeltaState, this.host.sessionId, subagentAttribution(data));
  }

  private handleStreamEvent(data: any): void {
    this.emitContextUsage(data);
    const delta = parseStreamEvent(data, this.streamDeltaState);
    if (!delta) return;
    const callback = delta.kind === 'thinking'
      ? (getSettings().showThinking ? this.currentTurn?.onAssistantThinkingDelta : null)
      : this.currentTurn?.onAssistantDelta;
    try { callback?.(delta.text, delta.blockId); }
    catch (e) { log.warn('assistant delta callback threw:', (e as Error).message); }
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

  handleLine(line: string) {
    if (!line) return;
    this.host.resetIdleTimer();
    this.host.bumpTurnIdleTimer();
    const parsed = parseLine(line);
    // `stream_event` lines are the token-level preview of a block the CLI will also deliver
    // complete. They dominate stdout once --include-partial-messages is on (measured: 74-86% of
    // all lines), and everything they carry is repeated verbatim by the complete event, so they
    // are deliberately kept out of the per-turn raw jsonl and the daemon log. Handled first, and
    // separately, because everything below is about complete events.
    if (parsed?.type === 'stream_event') {
      this.handleStreamEvent(parsed);
      return;
    }
    this.currentTurn?.rawStream?.write(line + '\n');
    if (this.handleCompleteLine(line, parsed)) log.info('stream:', line.substring(0, 200));
  }

  /** One complete line; a line that is not JSON, or that a handler choked on, is kept raw in the
   *  turn transcript. False when a result consumed it — results are not echoed to the daemon log. */
  private handleCompleteLine(line: string, parsed: any): boolean {
    try {
      if (parsed === undefined) throw new Error('not json');
      return this.handleEvent(parsed);
    } catch {
      this.currentTurn?.txtStream?.write(`[raw] ${line}\n`);
      return true;
    }
  }

  private handleEvent(data: any): boolean {
    this.observeLine(data);
    this.routeTurnlessLine(data);
    if (data.type === 'result' && this.currentTurn) {
      this.handleTurnResult(this.currentTurn, data);
      return false;
    }
    if (data.type === 'assistant' && this.currentTurn) this.handleAssistantEvent(this.currentTurn, data);
    // Emitted last so the census event trails the normalized events the same line already
    // produced, keeping contiguous tool batches contiguous for the ATIF grouper.
    this.emitSubagentActivity(data);
    const formatted = formatEvent(data);
    if (formatted) this.currentTurn?.txtStream?.write(formatted + '\n');
    return true;
  }

  /** The bookkeeping every complete line feeds, whether or not a turn is open. */
  private observeLine(data: any): void {
    // A compaction boundary invalidates the old provider-call cursor before the turn hears of it.
    if (data.type === 'system' && data.subtype === 'compact_boundary') this.emitContextUsage(data);
    reportSystemLine(this.currentTurn, data);
    if (data.type === 'rate_limit_event' && data.rate_limit_info) {
      this.host.reportRateLimit(data.rate_limit_info, {
        provider: 'anthropic', displayName: 'Anthropic', mode: this.host.connection,
      }).catch(e => log.error('handleRateLimitEvent error:', e));
    }
    this.observeUserLine(data);
    // Track background-task lifecycle on every line (even with no active turn) so the
    // pending count stays accurate across the turn boundary.
    this.bgTracker.observe(data);
    this.forwardSubagentEnd(data);
  }

  private observeUserLine(data: any): void {
    if (data.type !== 'user') return;
    // `--replay-user-messages` echo: the CLI's delivery ack for an injected message.
    // Handled here and nowhere else — it is deliberately NOT fed to turn bookkeeping, background
    // tracking, or conversation history (a `user` record there would shift every later turn
    // index and break edit/rewind). Replays are inert for every other consumer.
    if (data.isReplay) this.handleReplayEcho(data);
    else if (this.currentTurn) this.handleToolResultEvent(this.currentTurn, data);
  }

  /** Authoritative end-of-subagent, forwarded whether or not a turn is open: a subagent can
   *  finish inside its parent turn as easily as beside it, and `subagentEndFor` is consuming,
   *  so the signal is emitted exactly once either way. */
  private forwardSubagentEnd(data: any): void {
    const end = this.bgTracker.subagentEndFor(data);
    if (!end) return;
    // In-turn first: a subagent that finishes while its parent turn is still open has no
    // background-turn sink to reach (one is registered only when the turn ends holding background
    // work), and `subagentEndFor` is consuming — dropping it here loses the end for good.
    const inTurn = this.currentTurn?.onSubagentEnd;
    if (!inTurn) {
      this.deliverContinuation(s => s.onSubagentEnd?.(end.parentToolUseId, end.status));
      return;
    }
    try { inTurn(end.parentToolUseId, end.status); }
    catch (e) { log.warn('onSubagentEnd threw:', (e as Error).message); }
  }

  private routeTurnlessLine(data: any): void {
    if (this.currentTurn) return;
    // A backgrounded subagent keeps working after its parent turn closed, and the CLI keeps
    // streaming its lines. With no turn open the turn branches skip them, so route them to the
    // background-turn sink here — otherwise the whole tail of a background agent's trajectory
    // (tool calls AND its final report) is received and then dropped.
    if (routeLine(this.bgTracker, data) === 'subagent-orphan') this.handleOrphanSubagentLine(data);
    if (this.startsContinuation(data)) {
      const fromInjection = this.injectionContinuationArmed;
      this.injectionContinuationArmed = false;
      this.openContinuationTurn(fromInjection);
    }
  }

  /** No active turn, and the model just started speaking anyway: either a background task
   *  finished (bgTracker armed) or an injected message was consumed after this turn's result.
   *  Both make the CLI open a turn of its own — open a synthetic turn for it so its
   *  output is routed (to backgroundTurnSink) instead of being dropped. */
  private startsContinuation(data: any): boolean {
    return !!this.backgroundTurnSink && data.type === 'assistant'
      && (this.injectionContinuationArmed || routeLine(this.bgTracker, data) === 'open-continuation');
  }

  /**
   * A result with a turn open. A task-notification result settles a user turn only once the CLI
   * has read that turn's prompt. Before the prompt echo it is the CLI closing a notification turn
   * of its own — on `--resume` it reports background work orphaned by the previous process and
   * emits a 0-turn result BEFORE reading the prompt on stdin; settling there resolved the user turn
   * empty in ~2s and dropped the minutes of real work that followed (2026-09-06). After the echo,
   * a notification is folded into the same loop as the prompt and the loop's one result carries
   * that origin; ignoring it left a 162-turn user turn open until a manual Stop (2026-11-04).
   */
  private handleTurnResult(turn: PendingTurn, data: any): void {
    if (isContinuationResult(data) && !turn.spontaneous && !turn.promptConsumed) {
      log.info(`Ignoring notification-turn result on user turn ${this.host.sessionId.substring(0, 8)} (num_turns=${data.num_turns ?? '?'})`);
      turn.txtStream.write('[notification-turn result ignored — user turn still open]\n');
      return;
    }
    this.emitContextUsage(data);
    this.handleResultEvent(turn, data);
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
        turn.reject(turn.killError ?? new CancelledError());
      } else {
        const result = extractResult(turn.resultData, this.host.sessionId, code || 1, stderr,
          turn.planFilePath, turn.enteredPlanMode, turn.exitedPlanMode, turn.finalOutput, turn.longestOutput);
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

  /** The open turn rejects as cancelled when its process closes, or with `reason` if given. */
  markCurrentTurnKilled(reason?: Error): void {
    if (!this.currentTurn) return;
    this.currentTurn.killed = true;
    this.currentTurn.killError = reason;
  }
}
