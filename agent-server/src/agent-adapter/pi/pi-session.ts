// input:  PiSessionRequest, a PiRuntimeFactory, the transcript path registry
// output: PISession: one pooled in-process PI session serving Cortex turns
// pos:    Turn, steering, compaction and lifecycle state over a PI runtime handle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { CodexQuotaReading } from '@domain/costs/codex-quota.js';
import type {
  AgentCompactResult, AgentCompactUsage, InjectionAckSink, UserMessage,
} from '../types.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import {
  createPIEventParserState, piContextUsageFromStats, piEventToNormalized, type PIEventParserState,
} from './event-parser.js';
import type { PiSessionRequest } from './session-options.js';
import type { PiRawEvent, PiRuntimeFactory, PiRuntimeHandle } from './runtime.js';
import {
  EventQueue,
  PISteeringQueue,
  PI_CONTEXT_USAGE_SAMPLE_MS,
  PI_IDLE_SESSION_TIMEOUT,
  PI_TURN_IDLE_TIMEOUT,
  buildPromptText,
  type PendingPiInjection,
  type PendingPiTurn,
  type SwitchResult,
} from './session-support.js';

const log = createLogger('pi-adapter');

type PiTurnComplete = Extract<NormalizedEvent, { type: 'turn_complete' }>;

export interface PISessionOptions {
  request: PiSessionRequest;
  runtimeFactory: PiRuntimeFactory;
  /** Exact request identity this session was created from; the pool's reuse test. */
  identity: string;
  /** sessionId → transcript path, shared with the adapter's resume lookup. */
  registry: Map<string, string>;
  /** Passed the closing session itself so the pool only evicts the entry it still owns. */
  onClose?: (sessionKey: string, session: unknown) => void;
  /** Called with each provider quota reading; set only for gateway-routed runs. */
  onProviderQuota?: (reading: CodexQuotaReading) => void;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactUsage(value: unknown): AgentCompactUsage | null {
  const usage = record(value);
  if (Object.keys(usage).length === 0) return null;
  return {
    inputTokens: numberOrNull(usage['input']) ?? 0,
    outputTokens: numberOrNull(usage['output']) ?? 0,
    cacheReadTokens: numberOrNull(usage['cacheRead']) ?? 0,
    cacheWriteTokens: numberOrNull(usage['cacheWrite']) ?? 0,
    costUsd: numberOrNull(record(usage['cost'])['total']),
  };
}

/** PI rejects a compaction with this when the transcript is too small to have a cut point. */
function isNothingToCompact(message: string): boolean {
  return /nothing to compact|no messages to compact/i.test(message);
}

function isUserStart(message: unknown): boolean {
  return record(message)['role'] === 'user';
}

/** Expose one turn's queue as the AsyncIterable the run event loop consumes. */
export function turnStreamIterable(stream: EventQueue): AsyncIterable<NormalizedEvent> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<NormalizedEvent> => ({
      next: () => stream.next(),
    }),
  };
}

/**
 * One PI session living in this process, pooled per sessionKey across Cortex turns.
 *
 * Creation is asynchronous (the SDK loads extensions and resolves the model), so the session is
 * constructed synchronously and every operation awaits `ready`. Events flow from the runtime
 * handle into the current turn's stream; dialogs raised by extensions come back through
 * `sendExtensionUiResponse`.
 */
export class PISession {
  readonly sessionKey: string;
  /** Session ID assigned at creation (immutable afterwards). */
  sessionId: string | null = null;
  /** Absolute path to the session JSONL file, when the transcript is persisted. */
  sessionFile: string | null = null;
  /**
   * Session currently active in the runtime (updated on successful switch). Distinct from
   * sessionId, which is the session this instance was created with and never changes.
   */
  currentSessionId: string | null = null;
  /** Resolves once the runtime exists; rejects when creation failed. */
  readonly ready: Promise<void>;
  private handle: PiRuntimeHandle | null = null;
  /**
   * Event stream for the turn currently being served, opened by `openTurnStream()` on every
   * adapter spawn and closed at the terminal event. Per-turn rather than per-session so a finished
   * turn can end its consumer's `for await` loop while the session stays pooled for the next one.
   * Null between turns: events that arrive with no open stream have no run to belong to.
   */
  private turnStream: EventQueue | null = null;
  private readonly parserState: PIEventParserState = createPIEventParserState();
  private readonly request: PiSessionRequest;
  private readonly registry: Map<string, string>;
  private readonly onClose: PISessionOptions['onClose'];
  private readonly onProviderQuota: PISessionOptions['onProviderQuota'];
  private readonly identity: string;
  private alive = true;
  /** Buffer for assistant_text deltas; flushed on message_end / turn_complete / non-text events. */
  private textBuffer = '';
  /** blockId of the text currently in textBuffer; attached to the flushed assistant_text. */
  private textBlockId: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Accumulator for the current in-flight Cortex turn. */
  private pendingTurn: PendingPiTurn | null = null;
  private readonly steering = new PISteeringQueue();
  /**
   * Where PI's own agent loop is, tracked off its event stream because the injection form depends
   * on it. `starting` = a prompt is dispatched but PI has not entered the loop yet; only the
   * dedicated steer call is safe there.
   */
  private loopState: 'idle' | 'starting' | 'running' = 'idle';
  private compacting = false;
  private lastContextSampleAt = 0;

  constructor(opts: PISessionOptions) {
    this.sessionKey = opts.request.sessionKey;
    this.request = opts.request;
    this.identity = opts.identity;
    this.registry = opts.registry;
    this.onClose = opts.onClose;
    this.onProviderQuota = opts.onProviderQuota;
    this.ready = this.start(opts.runtimeFactory);
    // Consumers observe the failure through send()/compact(); an unobserved start must not crash.
    this.ready.catch(() => undefined);
    this.resetIdleTimer();
  }

  private async start(factory: PiRuntimeFactory): Promise<void> {
    let handle: PiRuntimeHandle;
    try {
      handle = await factory(this.request, {
        onEvent: (event) => this.handleRawEvent(event),
        onProviderQuota: (reading) => this.handleProviderQuota(reading),
      });
    } catch (error) {
      const failure = errorValue(error);
      this.fail(failure);
      throw failure;
    }
    if (!this.alive) {
      await handle.dispose().catch(() => undefined);
      throw new Error('PI session closed while starting');
    }
    this.handle = handle;
    this.announceSession(handle.session.sessionId, handle.session.sessionFile ?? null);
  }

  /** Runtime creation failed: end the session and the turn waiting on it. */
  private fail(error: Error): void {
    if (!this.alive) return;
    this.alive = false;
    this.clearTimers();
    this.steering.abandon();
    this.steering.clearSink();
    this.rejectPendingTurn(error);
    this.turnStream?.push({ type: 'error', message: error.message, fatal: true });
    this.closeTurnStream();
    this.onClose?.(this.sessionKey, this);
  }

  private announceSession(sessionId: string, sessionFile: string | null): void {
    this.sessionId = sessionId;
    this.currentSessionId = sessionId;
    this.sessionFile = sessionFile;
    this.registry.set(
      sessionId,
      sessionFile ?? path.join(this.request.sessionDir, `${sessionId}.jsonl`),
    );
    this.emitNormalizedEvent(sessionFile
      ? { type: 'session_started', sessionId, sessionFile }
      : { type: 'session_started', sessionId });
  }

  /**
   * Flush buffered text as a single assistant_text event, tagged with the blockId its deltas
   * carried so the UI can replace the streamed preview with this authoritative message.
   */
  private flushTextBuffer(): void {
    if (this.textBuffer.length > 0) {
      this.turnStream?.push(
        this.textBlockId !== null
          ? { type: 'assistant_text', text: this.textBuffer, blockId: this.textBlockId }
          : { type: 'assistant_text', text: this.textBuffer },
      );
      this.textBuffer = '';
    }
    this.textBlockId = null;
  }

  private clearTimers(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.clearTurnIdleTimer();
    this.flushTextBuffer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info(`Session ${this.sessionKey} idle for 65min, closing`);
      void this.close();
      this.onClose?.(this.sessionKey, this);
    }, PI_IDLE_SESSION_TIMEOUT);
    this.idleTimer.unref?.();
  }

  private startTurnIdleTimer(): void {
    this.turnIdleTimer = setTimeout(() => {
      log.info(`Session ${this.sessionKey} turn idle for 60min, killing`);
      this.kill();
      this.onClose?.(this.sessionKey, this);
    }, PI_TURN_IDLE_TIMEOUT);
    this.turnIdleTimer.unref?.();
  }

  private bumpTurnIdleTimer(): void {
    if (!this.turnIdleTimer) return;
    clearTimeout(this.turnIdleTimer);
    this.startTurnIdleTimer();
  }

  private clearTurnIdleTimer(): void {
    if (!this.turnIdleTimer) return;
    clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = null;
  }

  private async liveHandle(): Promise<PiRuntimeHandle> {
    await this.ready;
    if (!this.alive || !this.handle) throw new Error('PI session is not alive');
    return this.handle;
  }

  async compact(): Promise<AgentCompactResult> {
    if (this.compacting) throw new Error('PI compact already in progress');
    const handle = await this.liveHandle();
    this.compacting = true;
    try {
      const result = await handle.session.compact();
      return {
        status: 'compacted',
        tokensBefore: numberOrNull(result.tokensBefore),
        estimatedTokensAfter: numberOrNull(result.estimatedTokensAfter),
        usage: compactUsage(result.usage),
        contextUsage: this.currentContextUsage(),
      };
    } catch (error) {
      const failure = errorValue(error);
      if (isNothingToCompact(failure.message)) {
        return {
          status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null,
          contextUsage: null, usage: null,
        };
      }
      throw failure;
    } finally {
      this.compacting = false;
    }
  }

  private currentContextUsage(): AgentCompactResult['contextUsage'] {
    const session = this.handle?.session;
    if (!session) return null;
    try {
      return piContextUsageFromStats(session.getSessionStats());
    } catch (error) {
      log.warn(`PI session ${this.sessionKey}: session stats unavailable: ${errorValue(error).message}`);
      return null;
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  /** True when this live session was created from exactly the configuration a new spawn
   *  resolved to, and may therefore serve it. */
  matchesSpawn(identity: string): boolean {
    return this.identity === identity;
  }

  /**
   * Open the stream for one turn and hand it to the caller. The adapter calls this once per
   * spawn, so a reused session gets a fresh stream while keeping its runtime, session id and
   * parser state. A stream still open from a previous turn is closed first: it can only mean its
   * consumer went away without the turn reaching a terminal event.
   *
   * For a freshly constructed session this must be called in the same synchronous block as the
   * constructor: runtime creation is asynchronous, so nothing can be announced before that block
   * yields, and the `session_started` event lands on this stream.
   */
  openTurnStream(): EventQueue {
    this.closeTurnStream();
    const stream = new EventQueue();
    this.turnStream = stream;
    return stream;
  }

  private closeTurnStream(): void {
    if (this.turnStream === null) return;
    this.turnStream.close();
    this.turnStream = null;
  }

  /** End one run's stream. Detaches it from the session only when it is still the current turn,
   *  so a late close from an abandoned run cannot silence the turn that replaced it. */
  closeTurnStreamFor(stream: EventQueue): void {
    if (this.turnStream === stream) this.closeTurnStream();
    else stream.close();
  }

  private handleRawEvent(event: PiRawEvent): void {
    if (!this.alive) return;
    this.resetIdleTimer();
    this.bumpTurnIdleTimer();
    this.observeLoop(event);
    for (const evt of piEventToNormalized(event, this.parserState)) {
      const output = this.processPendingTurnEvent(evt);
      if (output !== null) this.emitWithContext(output);
    }
    if (this.pendingTurn && (event.type === 'message_update' || event.type === 'message_end')) {
      this.sampleContextUsage(false);
    }
  }

  /** Terminal events carry a fresh context reading ahead of them, as the RPC probe did. */
  private emitWithContext(event: NormalizedEvent): void {
    if (event.type === 'turn_complete') this.sampleContextUsage(true);
    this.emitNormalizedEvent(event);
  }

  /** Read context usage straight off the session; throttled while a turn streams. */
  private sampleContextUsage(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastContextSampleAt < PI_CONTEXT_USAGE_SAMPLE_MS) return;
    this.lastContextSampleAt = now;
    const usage = this.currentContextUsage();
    if (usage) this.turnStream?.push({ type: 'context_usage', ...usage });
  }

  /** Track PI's loop state and the opening-user/steering delivery order off its own events. */
  private observeLoop(event: PiRawEvent): void {
    // agent_start is emitted from inside the loop, so it is the first point at which PI's own run
    // flag is provably set; agent_settled is the point at which it is provably clear again.
    if (event.type === 'agent_start') this.loopState = 'running';
    else if (event.type === 'agent_settled') this.loopState = 'idle';
    if (event.type !== 'message_start' || !isUserStart(event['message'])) return;
    const turn = this.pendingTurn;
    if (turn && !turn.openingUserSeen) turn.openingUserSeen = true;
    else if (turn) this.steering.consumeNext();
  }

  private handleProviderQuota(reading: CodexQuotaReading): void {
    if (!reading?.windows?.length) return;
    this.onProviderQuota?.(reading);
    this.turnStream?.push({ type: 'rate_limit', raw: reading });
  }

  /** Update the outer send() promise and optionally replace/suppress a terminal event. */
  private processPendingTurnEvent(evt: NormalizedEvent): NormalizedEvent | null {
    const turn = this.pendingTurn;
    if (!turn) return evt;
    if (evt.type === 'plan_written') turn.planFilePath = evt.path;
    // ask_user_question is handled live by the facade; accumulating it would post it twice.
    else if (evt.type === 'ask_user_question') { /* intentionally not accumulated */ }
    else if (evt.type === 'turn_complete') return this.handleTurnComplete(evt);
    else if (evt.type === 'error' && evt.fatal) {
      this.flushTextBuffer();
      this.clearTurnIdleTimer();
      this.steering.abandon();
      this.pendingTurn = null;
      turn.reject(new Error(evt.message));
    }
    return evt;
  }

  private handleTurnComplete(evt: PiTurnComplete): PiTurnComplete | null {
    const turn = this.pendingTurn!;
    this.flushTextBuffer();
    turn.numTurns += evt.numTurns;
    if (evt.totalCostUsd !== null) turn.totalCostUsd = (turn.totalCostUsd ?? 0) + evt.totalCostUsd;
    if (evt.error) {
      this.steering.abandon();
      return this.settlePendingTurn(evt.error);
    }
    if (this.steering.hasPending) {
      turn.deferredCompletion = true;
      return null;
    }
    return this.settlePendingTurn();
  }

  private finishDeferredTurn(): PiTurnComplete | null {
    if (!this.pendingTurn?.deferredCompletion || this.steering.hasPending) return null;
    return this.settlePendingTurn();
  }

  private settlePendingTurn(error?: string): PiTurnComplete {
    const turn = this.pendingTurn!;
    this.pendingTurn = null;
    this.clearTurnIdleTimer();
    const terminal: PiTurnComplete = error
      ? { type: 'turn_complete', numTurns: turn.numTurns, totalCostUsd: turn.totalCostUsd, error }
      : { type: 'turn_complete', numTurns: turn.numTurns, totalCostUsd: turn.totalCostUsd };
    // `turn_complete.error` is PI reporting its own turn ended with `stopReason: "error"` --
    // a provider- or model-side failure, not a Cortex fault. Tagging the rejection lets the
    // runner classify it instead of guessing from a crash. The message is PI's own, verbatim.
    if (error) turn.reject(Object.assign(new Error(error), { reason: 'provider_error' }));
    else turn.resolve(this.buildAgentResult(turn));
    return terminal;
  }

  private buildAgentResult(turn: PendingPiTurn): AgentResult {
    return {
      sessionId: this.sessionId,
      total_cost_usd: turn.totalCostUsd,
      num_turns: turn.numTurns,
      rateLimited: false,
      rateLimitMessage: null,
      planFilePath: turn.planFilePath,
      enteredPlanMode: false,
      exitedPlanMode: turn.planFilePath !== null,
      askUserQuestions: turn.askUserQuestions.length > 0 ? turn.askUserQuestions : undefined,
      finalOutput: null,
    };
  }

  /** Buffer deltas into whole assistant messages while preserving Web preview events. */
  private emitNormalizedEvent(evt: NormalizedEvent): void {
    if (evt.type === 'context_usage') {
      this.turnStream?.push(evt);
      return;
    }
    // Forwarded subagent prose is already a complete message, not a token delta. Putting it in the
    // main-agent text buffer would erase attribution when flushTextBuffer reconstructs the event.
    if (evt.type === 'assistant_text' && evt.subagent) {
      this.flushTextBuffer();
      this.turnStream?.push(evt);
      return;
    }
    if (evt.type !== 'assistant_text') {
      this.flushTextBuffer();
      this.turnStream?.push(evt);
      // Terminal event: end this turn's stream so its consumer's `for await` returns. The
      // session is deliberately left running — the pool decides its fate, not the turn.
      if (evt.type === 'turn_complete') this.closeTurnStream();
      return;
    }
    const blockId = evt.blockId ?? null;
    if (this.textBuffer.length > 0 && blockId !== this.textBlockId) this.flushTextBuffer();
    this.textBlockId = blockId;
    if (this.request.streamDeltas && blockId !== null) {
      this.turnStream?.push({ type: 'assistant_delta', text: evt.text, blockId });
    }
    this.textBuffer += evt.text;
  }

  /**
   * Hand the opening prompt to PI. The call resolves only when the whole agent run has finished,
   * so it is not awaited here; the turn is settled off the event stream instead. A rejection
   * before PI entered its loop means no `agent_settled` will ever come, so the turn fails here.
   */
  private dispatchPrompt(handle: PiRuntimeHandle, promptText: string): void {
    this.loopState = 'starting';
    if (this.pendingTurn) this.pendingTurn.promptDispatched = true;
    handle.session.prompt(promptText).catch((error: unknown) => this.promptFailed(errorValue(error)));
  }

  private promptFailed(error: Error): void {
    log.warn(`PI session ${this.sessionKey}: prompt failed: ${error.message}`);
    this.loopState = 'idle';
    if (!this.pendingTurn) return;
    this.flushTextBuffer();
    this.clearTurnIdleTimer();
    this.steering.abandon();
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    turn.reject(error);
    this.turnStream?.push({ type: 'error', message: error.message, fatal: true });
    this.closeTurnStream();
  }

  /**
   * Queue a message at PI's next agent-loop boundary without opening a new Cortex run.
   *
   * The form has to follow PI's loop state. `prompt` with streamingBehavior=steer is only queued
   * when PI already considers itself streaming; during the prompt preflight window (which includes
   * our own before_agent_start hook scripts, seconds long) PI instead takes its plain-prompt path
   * and fails. The dedicated `steer` call bypasses that check and is drained by the opening
   * steering poll of the loop about to start. Once the loop runs, or once PI has settled and the
   * message must reopen a turn, prompt+steer is the correct form.
   */
  injectUserMessage(msg: UserMessage): boolean {
    const handle = this.handle;
    if (!this.alive || !handle || !this.pendingTurn?.promptDispatched) return false;
    const entry = this.steering.begin(msg.text);
    const text = buildPromptText(msg);
    const attempt = this.loopState === 'starting'
      ? handle.session.steer(text)
      : handle.session.prompt(text, { streamingBehavior: 'steer' });
    // A prompt handed to an idle PI opens a fresh run, so the next injection is a preflight one.
    if (this.loopState === 'idle') this.loopState = 'starting';
    attempt.catch((error: unknown) => {
      const message = `injection refused: ${errorValue(error).message}`;
      log.warn(`PI session ${this.sessionKey}: ${message}`);
      // Keep the refusal observable on the turn stream, as the RPC error frame used to be.
      this.turnStream?.push({ type: 'error', message, fatal: false });
      this.rejectInjection(entry);
    });
    return true;
  }

  /** PI refused a queued message: seal it, and settle a turn that was only waiting on it. */
  private rejectInjection(entry: PendingPiInjection): void {
    if (!this.steering.reject(entry)) return;
    const terminal = this.finishDeferredTurn();
    if (terminal !== null) this.emitWithContext(terminal);
  }

  setInjectionAckSink(sink: InjectionAckSink): void {
    this.steering.setSink(sink);
  }

  /** Re-point the runtime at another transcript. {ok:false} when the session is gone or PI
   *  refused; never throws. */
  async sendSwitchSession(targetPath: string): Promise<SwitchResult> {
    if (!this.alive) return { ok: false, cancelled: false };
    let handle: PiRuntimeHandle;
    try {
      handle = await this.liveHandle();
    } catch {
      return { ok: false, cancelled: false };
    }
    try {
      const result = await handle.switchSession(targetPath);
      return { ok: !result.cancelled, cancelled: result.cancelled };
    } catch (error) {
      log.warn(`PI session ${this.sessionKey}: switch to ${targetPath} failed: ${errorValue(error).message}`);
      return { ok: false, cancelled: false };
    }
  }

  /**
   * Send a user message, switching to targetSessionId first when the runtime is currently serving
   * a different transcript. The prompt is dispatched in every branch: a refused switch leaves the
   * prompt on the current session, best-effort, and the caller can inspect `switched`.
   */
  async sendTurn(
    targetSessionId: string | null,
    targetPath: string | null,
    message: UserMessage,
  ): Promise<{ switched: boolean; cancelled: boolean }> {
    const handle = await this.liveHandle();
    const promptText = buildPromptText(message);
    let switched = false;
    let cancelled = false;
    if (targetSessionId !== null && this.currentSessionId !== targetSessionId && targetPath !== null) {
      const result = await this.sendSwitchSession(targetPath);
      if (result.ok) this.currentSessionId = targetSessionId;
      switched = result.ok;
      cancelled = result.cancelled;
    }
    if (!this.alive || !this.handle) throw new Error('PI session closed before its prompt was sent');
    this.dispatchPrompt(handle, promptText);
    return { switched, cancelled };
  }

  /**
   * Answer a pending extension dialog. Payload fields depend on the dialog method:
   *   select/input/editor: { value: string } or { cancelled: true }
   *   confirm: { confirmed: boolean } or { cancelled: true }
   */
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): void {
    if (!this.alive) return;
    if (!this.handle?.respondToUi(id, payload)) {
      log.debug(`PI session ${this.sessionKey}: no dialog waits on ui request ${id}`);
    }
  }

  /** Begin a new turn: set up the pendingTurn accumulator before the prompt is dispatched.
   *  A turn already in flight is rejected (superseded) so its Promise cannot leak. */
  beginTurn(
    resolve: (r: AgentResult) => void,
    reject: (e: Error) => void,
  ): void {
    this.beginTurnReject(new Error('PISession.beginTurn: superseded by a newer send()'));
    // Turn-scoped counter on a session-scoped parser state: without this reset a pooled session's
    // second turn would start its progress heartbeat at the first turn's final count.
    this.parserState.turnProgressCount = 0;
    this.pendingTurn = {
      resolve,
      reject,
      planFilePath: null,
      askUserQuestions: [],
      numTurns: 0,
      totalCostUsd: null,
      promptDispatched: false,
      openingUserSeen: false,
      deferredCompletion: false,
    };
    this.startTurnIdleTimer();
  }

  /** Reject the pendingTurn if it is still outstanding (not yet settled by events). */
  beginTurnReject(err: Error): void {
    this.rejectPendingTurn(err);
  }

  private rejectPendingTurn(err: Error): void {
    if (this.pendingTurn === null) return;
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    this.clearTurnIdleTimer();
    this.steering.abandon();
    turn.reject(err);
  }

  async close(): Promise<void> {
    this.clearTimers();
    if (!this.alive) return;
    this.alive = false;
    this.steering.abandon();
    this.steering.clearSink();
    this.rejectPendingTurn(new Error('PI session closed before turn_complete'));
    this.closeTurnStream();
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    try {
      await handle.dispose();
    } catch (error) {
      log.warn(`PI session ${this.sessionKey}: dispose failed: ${errorValue(error).message}`);
    }
  }

  /** Abort whatever PI is doing and release the session. True when it was alive. */
  kill(): boolean {
    if (!this.alive) return false;
    const handle = this.handle;
    if (handle) handle.session.abort().catch(() => undefined);
    void this.close();
    return true;
  }
}
