// input:  RunRequest + RunObserver[] plus today's facade AgentHandle / NormalizedEvent stream
// output: AgentRun state machine — phases, results, registry hooks, cancel/subscribe, legacy process
// pos:    The run ownership object. P1.3 wraps facade.runAgent; P2 replaces the engine path under it.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import type { RunRegistry } from '@core/run-registry.js';
import type { AgentHandle } from '@core/types/agent-types.js';
import { remainingBg } from '../../agent-adapter/bg-wait.js';
import { CAPABILITIES_BY_BACKEND, Capability } from '../../agent-adapter/capabilities.js';
import type {
  AgentProcess, ContinuationSink, InjectionAckSink, UserMessage,
} from '../../agent-adapter/types.js';
import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import type { AgentConfig, RunAgentOptions } from '../agents/spawn-config.js';
// Imported from the facade directly: `runAgent` is no longer part of the `domain/agents` barrel
// (only the run layer may start a run). Tests that need to intercept the spawn mock this module.
import { runAgent } from '../agents/facade.js';
import {
  continuationSinkToEvents, toRunEvent,
  type RunEvent, type RunPhase,
} from './events.js';
import type { RunObserver, RunRequest, RunResult } from './request.js';

const log = createLogger('run');

/** The run lifecycle. `starting → running → (background) → completed | failed | cancelled | rate-limited`. */
export type RunStatus =
  | 'starting' | 'running' | 'background' | 'completed' | 'failed' | 'cancelled' | 'rate-limited';

/** The one ownership object for a run (plan §3.3). P1.8 wires `steer`; P2.4 wires `respondToDialog`. */
export interface AgentRun {
  readonly id: string;
  readonly request: RunRequest;
  readonly executionId: string;
  readonly status: RunStatus;
  readonly phase: RunPhase;
  readonly numTurns: number | null;
  readonly attempt: { index: number; config: AgentConfig };
  readonly backendSessionId: string | null;
  readonly capabilities: ReadonlySet<Capability>;
  /** The awaited foreground turn's result. */
  readonly result: Promise<RunResult>;
  /** Terminal run outcome, including the background phase (D1). */
  readonly settled: Promise<RunResult>;
  /**
   * Deliver `msg` into the live turn without opening a new Cortex run (D2). The run decides
   * capability from `this.capabilities` — callers never inspect the process. Resolves `refused`
   * when the backend cannot take the message (the caller then falls back to the queue). The
   * authoritative fold/queue outcome arrives later as an `injection_delivered` RunEvent.
   * `injectionId` lets the caller (the pending-injection ledger in `orchestration/transcript-sink`)
   * correlate the eventual ack event with its durable pending record.
   */
  steer(msg: UserMessage, injectionId?: string): Promise<'folded' | 'queued' | 'refused'>;
  /**
   * Answer an in-flight backend dialog (PI `ask_user` / plan approval) through this run.
   * Returns false when the backend exposes no dialog channel or no live dialog waits on `id`;
   * callers then fall through to their webhook path instead of dropping the answer.
   *
   * Transitional: P4.1 replaces the `agentProcess` hop with the `EngineSession`.
   */
  respondToDialog(id: string, payload: Record<string, unknown>): boolean;
  cancel(reason: 'user' | 'supersede' | 'shutdown'): void;
  subscribe(observer: RunObserver): () => void;
  /**
   * @deprecated Transitional P1.3 accessor for call sites that still hand the raw process to the
   * old background-hold machinery. P2.3 deletes it.
   */
  legacyProcess(): AgentProcess | undefined;
  /**
   * True once a legacy background hold has subscribed through `runToContinuationSink` and taken
   * over persisting the background turn's rows. `AgentProcess.setContinuationSink` used to be a
   * single slot, so exactly one consumer ever wrote those rows; this flag keeps that guarantee now
   * that several observers can watch the same run. P4.1 removes it with the holds.
   */
  readonly backgroundTranscriptOwned: boolean;
  /** Claim the background transcript for a hold. Idempotent. */
  claimBackgroundTranscript(): void;
  /**
   * Transitional: the `ContinuationSink` view of this run, so P1.5's hold adapters can register the
   * run as a sink without reaching into the process. P4.1 folds the hold path into the run and
   * removes this.
   */
  continuationSink(): ContinuationSink;
}

/** What the run reports back to `startRun` when it reaches a terminal state. */
export interface RunTerminalInfo {
  status: RunStatus;
  result: RunResult | null;
  error?: Error;
  durationS: number;
}

/** The slice of facade.runAgent the run depends on. Injectable for tests and P2. */
export type RunAgentFn = (message: string, options: RunAgentOptions) => AgentHandle;

export interface CreateAgentRunArgs {
  request: RunRequest;
  observers: RunObserver[];
  executionId: string;
  attemptConfig: AgentConfig;
  registry: RunRegistry;
  onTerminal: (info: RunTerminalInfo) => void;
  /** Unix ms the execution record was opened. */
  startedAt: number;
  /** Override for tests; defaults to facade.runAgent. */
  runAgentFn?: RunAgentFn;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A message written to the live backend but whose delivery ack has not arrived yet. `id` is the
 *  caller's pending-injection id, carried on the eventual `injection_delivered`/`_rejected` event. */
interface PendingInjectionAck {
  id: string;
  text: string;
}

function cancellationError(reason: string): Error {
  return Object.assign(new Error(`Run cancelled (${reason})`), { cancelled: true });
}

/** Build the attempt config the legacy facade consumes from the resolved profile. */
export function agentConfigFromProfile(profile: RunRequest['profile']): AgentConfig {
  return {
    model: profile.model,
    backend: profile.backend,
    mode: profile.mode,
    provider: profile.provider,
    extraEnv: profile.extraEnv,
    extraOption: profile.extraOption,
    claudeBackend: profile.claudeBackend,
    thinking: profile.thinking,
    maxOutputTokens: profile.maxOutputTokens,
  };
}

/** Attempt identity as the facade renders it (`model/mode`) — the label `run_fallback` carries. */
export function attemptLabel(config: AgentConfig): string {
  return `${config.model}/${config.mode || 'default'}`;
}

/**
 * The two legacy callbacks the run still has to supply, because the facade generates signals that
 * exist nowhere in the `NormalizedEvent` stream:
 *  - `onAssistantMessage` is the ONLY path for facade-synthesized notices (held rate-limit card,
 *    auto-resume warning, terminal error text, backend-session reset, compaction, fallback) and it
 *    is also what arms `AttemptNoticeTracker` at all — passing null silently disables every notice.
 *    It additionally carries `assistantNoticeLevel(text)` for ordinary prose, which the raw event
 *    does not. The run therefore takes assistant prose from HERE, not from the adapter tee.
 *  - `onFallback` fires when the profile's fallback chain switches attempt; the run turns it into a
 *    `run_fallback` event. P4.1 moves the chain itself into the run and both hooks disappear.
 */
export interface RunAgentHooks {
  onAssistantMessage: NonNullable<RunAgentOptions['onAssistantMessage']>;
  onFallback: NonNullable<RunAgentOptions['onFallback']>;
}

/**
 * Translate a fully-resolved `RunRequest` into today's `RunAgentOptions`. Every legacy callback is
 * left unset except the two in `RunAgentHooks`: the run observes the raw adapter stream through
 * `observers` and fans it out as `RunEvent`s, so no call site has to wire eleven callbacks.
 */
export function buildRunAgentOptions(
  request: RunRequest,
  executionId: string,
  onAdapterEvent: (event: NormalizedEvent) => void,
  hooks: RunAgentHooks,
): RunAgentOptions {
  const files = (request.prompt.attachments ?? []).map((attachment) => ({
    mimeType: attachment.mimeType, path: attachment.path,
  }));
  const background = request.policy.background;
  return {
    profileName: request.profile.name,
    sessionId: request.session.backendSessionId,
    trackSessionId: request.session.sessionId,
    sessionKey: request.session.engineKey,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    channel: request.context.channel,
    executionId,
    sessionName: request.session.sessionName,
    project: request.context.project,
    trigger: request.context.trigger,
    threadId: request.context.threadId ?? null,
    threadDepth: request.context.threadDepth ?? null,
    taskId: request.context.taskId ?? null,
    taskProject: request.context.taskProject ?? null,
    taskGeneration: request.context.taskGeneration ?? null,
    scheduleTaskId: request.context.scheduleTaskId ?? null,
    callbackSource: request.context.callbackSource ?? null,
    isUserInitiated: request.context.isUserInitiated,
    commissionMode: request.context.commissionMode,
    commissionTools: request.context.commissionTools,
    systemPrompt: request.spec.systemPrompt,
    appendSystemPrompt: request.spec.appendSystemPrompt ?? undefined,
    outputStyle: request.spec.backendOptions.outputStyle ?? null,
    claudeAgent: request.spec.backendOptions.claudeAgent ?? null,
    tools: request.spec.tools,
    pluginDirs: request.spec.pluginDirs,
    mcpComposition: request.policy.mcpComposition,
    useCoreMcp: request.policy.useCoreMcp,
    mcpToolAllowlist: request.policy.mcpToolAllowlist,
    browserCdpEndpoint: request.policy.browserCdpEndpoint ?? null,
    recordCost: request.policy.recordCost,
    loadCortexRules: request.policy.loadRules,
    disableHooks: !request.policy.hooks,
    streamDeltas: request.policy.streamDeltas,
    captureTranscriptLogs: request.policy.captureTranscripts,
    // The run owns the background phase (D1). Only inline/completion-only policies let the facade
    // keep the turn promise open; otherwise the continuation sink reports background turns.
    awaitBackground: background === 'inline' || background === 'completion-only',
    backgroundWaitPolicy: background === 'completion-only' ? 'completion-only' : 'bounded',
    resolvedProfileConfig: request.profile,
    rootThreadId: request.benchmark?.rootThreadId ?? null,
    parentThreadId: request.benchmark?.parentThreadId ?? null,
    templateName: request.benchmark?.templateName ?? null,
    agentSlotId: request.benchmark?.agentSlotId ?? null,
    stage: request.benchmark?.stage ?? null,
    identityDirective: request.benchmark?.identityDirective,
    productionBenchmarkEvidenceContext: request.benchmark?.evidenceContext ?? null,
    pinnedEnv: request.benchmark?.pinnedEnv,
    cliPath: request.benchmark?.cliPath,
    processSpawner: request.benchmark?.spawner,
    mcpConfigPaths: request.benchmark?.mcpConfigPaths,
    preserveUnreportedAccounting: request.benchmark?.preserveUnreportedAccounting ?? false,
    files,
    onAssistantMessage: hooks.onAssistantMessage,
    onFallback: hooks.onFallback,
    // The run observes the raw adapter stream for everything the two hooks above do not carry.
    observers: [{ onEvent: onAdapterEvent }],
  };
}

/** The Phase 1 `AgentRun`. One per `startRun`; owns all per-run mutable state. */
export class AgentRunImpl implements AgentRun {
  readonly id: string;
  readonly request: RunRequest;
  readonly executionId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly result: Promise<RunResult>;
  readonly settled: Promise<RunResult>;

  private attemptValue: { index: number; config: AgentConfig };
  /** Reporting model of the latest raw assistant event, restamped onto the hook's message. */
  private lastAssistantModel: string | null = null;
  private backgroundTranscriptOwnedValue = false;
  private statusValue: RunStatus = 'starting';
  private phaseValue: RunPhase = 'foreground';
  private numTurnsValue: number | null = null;
  private backendSessionIdValue: string | null;
  private foregroundResult: RunResult | null = null;
  private backgroundResult: RunResult | null = null;

  private readonly observers: RunObserver[];
  private readonly registry: RunRegistry;
  private readonly onTerminal: (info: RunTerminalInfo) => void;
  private readonly startedAt: number;
  private readonly runAgentFn: RunAgentFn;
  private readonly settleDeferred = deferred<RunResult>();
  private readonly resultDeferred = deferred<RunResult>();

  private handle: AgentHandle | null = null;
  private continuationSinkValue: ContinuationSink | null = null;
  private continuationSinkInstalled = false;
  private injectionAckInstalled = false;
  /** Injections accepted by the backend whose ack has not arrived. Keeps the run in `background`
   *  after its foreground result so a post-result injection's spontaneous turn is not dropped. */
  private pendingInjections: PendingInjectionAck[] = [];
  private started = false;
  private terminal = false;
  private observersClosed = false;
  private cancelRequested = false;

  constructor(args: CreateAgentRunArgs) {
    this.request = args.request;
    this.executionId = args.executionId;
    this.id = args.request.runId;
    this.attemptValue = { index: 0, config: args.attemptConfig };
    this.capabilities = CAPABILITIES_BY_BACKEND[args.request.profile.backend];
    this.backendSessionIdValue = args.request.session.backendSessionId;
    this.observers = [...args.observers];
    this.registry = args.registry;
    this.onTerminal = args.onTerminal;
    this.startedAt = args.startedAt;
    this.runAgentFn = args.runAgentFn ?? runAgent;
    this.result = this.resultDeferred.promise;
    this.settled = this.settleDeferred.promise;
    // Both promises reject on a failed/cancelled run, and not every caller awaits both (a surface
    // that only awaits `result` still gets a rejected `settled`). Mark them handled here so an
    // unawaited one cannot take the process down with an unhandled rejection; a real awaiter still
    // observes the rejection normally.
    void this.result.catch(() => undefined);
    void this.settled.catch(() => undefined);
  }

  get attempt(): { index: number; config: AgentConfig } { return this.attemptValue; }
  get status(): RunStatus { return this.statusValue; }
  get phase(): RunPhase { return this.phaseValue; }
  get numTurns(): number | null { return this.numTurnsValue; }
  get backendSessionId(): string | null { return this.backendSessionIdValue; }

  /** Begin the run. Called exactly once by `startRun`, synchronously. */
  start(): void {
    if (this.started) return;
    this.started = true;
    let handle: AgentHandle;
    try {
      handle = this.runAgentFn(
        this.request.prompt.text,
        buildRunAgentOptions(this.request, this.executionId, (event) => this.onAdapterEvent(event), {
          onAssistantMessage: (text, blockId, noticeLevel, noticeAction, subagent) => {
            this.absorb({
              type: 'assistant_text', text, phase: this.phaseValue,
              ...(this.lastAssistantModel ? { model: this.lastAssistantModel } : {}),
              ...(blockId ? { blockId } : {}),
              ...(noticeLevel ? { noticeLevel } : {}),
              ...(noticeAction ? { noticeAction } : {}),
              ...(subagent ? { subagent } : {}),
            });
          },
          onFallback: async (current, next) => { this.onChainFallback(current, next); },
        }),
      );
    } catch (error) {
      this.onForegroundError(error);
      return;
    }
    this.handle = handle;
    this.statusValue = 'running';
    this.registerHandle(handle);
    this.installContinuationSink(handle);
    void handle.promise.then(
      (result) => this.onForegroundResult(result),
      (error) => this.onForegroundError(error),
    );
  }

  steer(msg: UserMessage, injectionId?: string): Promise<'folded' | 'queued' | 'refused'> {
    if (this.terminal) return Promise.resolve('refused');
    if (!this.capabilities.has(Capability.MidTurnInject)) return Promise.resolve('refused');
    const proc = this.handle?.agentProcess as AgentProcess | undefined;
    if (!proc || typeof proc.injectUserMessage !== 'function') return Promise.resolve('refused');
    this.installInjectionAckSink(proc);
    const entry: PendingInjectionAck = { id: injectionId ?? randomUUID(), text: msg.text };
    this.pendingInjections.push(entry);
    let accepted = false;
    try {
      accepted = proc.injectUserMessage(msg);
    } catch (error) {
      log.warn('run inject failed:', asError(error).message);
    }
    if (!accepted) {
      this.removePendingInjection(entry.id);
      return Promise.resolve('refused');
    }
    // The write was accepted. The authoritative folded/queued outcome is delivered later as an
    // `injection_delivered` event; the synchronous return only tells the caller not to queue it.
    return Promise.resolve(this.phaseValue === 'background' ? 'queued' : 'folded');
  }

  /** Install the backend-neutral injection ack sink once. Every ack becomes a run event. */
  private installInjectionAckSink(proc: AgentProcess): void {
    if (this.injectionAckInstalled) return;
    if (typeof proc.setInjectionAckSink !== 'function') return;
    this.injectionAckInstalled = true;
    const sink: InjectionAckSink = {
      onDelivered: ({ text, foldedIntoTurn }) => {
        const entry = this.takePendingInjection(text);
        if (!entry) return;
        this.absorb({ type: 'injection_delivered', injectionId: entry.id, foldedIntoTurn });
      },
      onUndelivered: ({ text }) => {
        const entry = this.takePendingInjection(text);
        if (!entry) return;
        this.absorb({ type: 'injection_rejected', injectionId: entry.id, reason: 'undelivered' });
      },
    };
    proc.setInjectionAckSink(sink);
  }

  /** Remove and return the oldest pending injection written with `text` (acks are FIFO per text). */
  private takePendingInjection(text: string): PendingInjectionAck | null {
    const index = this.pendingInjections.findIndex((entry) => entry.text === text);
    if (index === -1) return null;
    return this.pendingInjections.splice(index, 1)[0];
  }

  private removePendingInjection(id: string): void {
    this.pendingInjections = this.pendingInjections.filter((entry) => entry.id !== id);
  }

  respondToDialog(id: string, payload: Record<string, unknown>): boolean {
    const proc = this.handle?.agentProcess as
      { sendExtensionUiResponse?: (id: string, payload: Record<string, unknown>) => boolean } | undefined;
    if (typeof proc?.sendExtensionUiResponse !== 'function') return false;
    return proc.sendExtensionUiResponse(id, payload);
  }

  cancel(reason: 'user' | 'supersede' | 'shutdown'): void {
    if (this.terminal) return;
    this.cancelRequested = true;
    try { this.handle?.kill(); } catch (error) { log.warn('run kill failed:', asError(error).message); }
    this.finishTerminal('cancelled', null, cancellationError(reason));
  }

  subscribe(observer: RunObserver): () => void {
    this.observers.push(observer);
    return () => {
      const index = this.observers.indexOf(observer);
      if (index >= 0) this.observers.splice(index, 1);
    };
  }

  get backgroundTranscriptOwned(): boolean { return this.backgroundTranscriptOwnedValue; }

  claimBackgroundTranscript(): void { this.backgroundTranscriptOwnedValue = true; }

  legacyProcess(): AgentProcess | undefined {
    return (this.handle?.agentProcess as AgentProcess | undefined) ?? undefined;
  }

  continuationSink(): ContinuationSink {
    if (!this.continuationSinkValue) {
      this.continuationSinkValue = continuationSinkToEvents((event) => this.absorb(event));
    }
    return this.continuationSinkValue;
  }

  // ── wiring ─────────────────────────────────────────────────────────────

  private registerHandle(handle: AgentHandle): void {
    this.registry.register({
      threadId: this.request.context.threadId ?? null,
      channel: this.request.context.channel,
      agentSlotId: this.request.benchmark?.agentSlotId ?? null,
      executionId: this.executionId,
      kind: this.request.context.executionKind,
      kill: () => handle.kill(),
      backend: this.request.profile.backend,
      agentProcess: handle.agentProcess,
      run: this,
      trackSessionId: this.request.session.sessionId,
      backendSessionId: handle.sessionId ?? this.request.session.backendSessionId,
      sessionId: handle.sessionId,
    });
    // The handle's spawn-time backend id is authoritative even when the adapter never emits a
    // session_started event (an interrupted first turn). Surfaces that persist the resume target on
    // settle read `run.backendSessionId`, so record it here rather than only on engine_started.
    if (handle.sessionId) this.backendSessionIdValue = handle.sessionId;
  }

  private installContinuationSink(handle: AgentHandle): void {
    const proc = handle.agentProcess as AgentProcess | undefined;
    if (proc && typeof proc.setContinuationSink === 'function') {
      this.continuationSinkInstalled = true;
      proc.setContinuationSink(this.continuationSink());
    }
  }

  // ── event flow ─────────────────────────────────────────────────────────

  private onAdapterEvent(event: NormalizedEvent): void {
    if (this.terminal) return;
    // The authoritative result comes from the resolved AgentHandle, never from turn_complete's
    // synthesized result — relaying it here would double-emit foreground_result.
    if (event.type === 'turn_complete') {
      // The legacy dispatcher called onProgress here with the final count; republish it as
      // turn_progress so the live turn counter and the status line still get the last value.
      if (typeof event.numTurns === 'number') this.absorb({ type: 'turn_progress', numTurns: event.numTurns });
      return;
    }
    // Assistant prose arrives through the `onAssistantMessage` hook instead: that path carries the
    // facade's `assistantNoticeLevel(text)` classification and interleaves the synthesized notices
    // in the order they were produced. Relaying the raw event too would double every message.
    // The raw event is still the only carrier of the reporting model, and the tee runs before the
    // legacy dispatcher, so remembering it here stamps the very message it belongs to.
    if (event.type === 'assistant_text') {
      if (event.model) this.lastAssistantModel = event.model;
      return;
    }
    this.absorb(toRunEvent(event, this.phaseValue));
  }

  /**
   * The profile's fallback chain switched attempt (facade `onFallback`). Advance the attempt and
   * report it on the stream; the surface renders the notice (D7). P4.1 moves the chain itself here.
   */
  private onChainFallback(current: AgentConfig, next: AgentConfig): void {
    this.attemptValue = { index: this.attemptValue.index + 1, config: next };
    this.absorb({
      type: 'run_fallback',
      from: attemptLabel(current),
      to: attemptLabel(next),
      reason: 'rate-limited',
    });
  }

  private absorb(event: RunEvent): void {
    if (this.terminal) return;
    switch (event.type) {
      case 'engine_started':
        this.backendSessionIdValue = event.backendSessionId;
        break;
      case 'turn_progress':
        this.setNumTurns(event.numTurns);
        break;
      case 'injection_delivered':
      case 'injection_rejected':
        this.removePendingInjection(event.injectionId);
        break;
      case 'background_result':
        this.backgroundResult = event.result;
        this.absorbResultCounts(event.result);
        break;
      default:
        break;
    }
    this.fanOut(event);
    if (event.type === 'background_result') {
      if (event.result.backgroundInterrupted || remainingBg(event.result) === 0) {
        this.finishTerminal(event.result.rateLimited ? 'rate-limited' : 'completed', event.result);
      }
    }
    // A post-result injection keeps the run in `background` until its spontaneous turn results.
    // A rejected injection (or one that folded) leaves nothing to wait for, so seal here — the
    // foreground result already settled and carried no background work of its own.
    if (
      (event.type === 'injection_rejected'
        || (event.type === 'injection_delivered' && event.foldedIntoTurn))
      && this.phaseValue === 'background'
      && this.pendingInjections.length === 0
      && this.foregroundResult !== null
      && remainingBg(this.foregroundResult) === 0
    ) {
      this.finishTerminal(
        this.foregroundResult.rateLimited ? 'rate-limited' : 'completed',
        this.foregroundResult,
      );
    }
  }

  /** True when the facade owns the background wait for this policy (`awaitBackground: true`). */
  private awaitsBackgroundInline(): boolean {
    const background = this.request.policy.background;
    return background === 'inline' || background === 'completion-only';
  }

  private setNumTurns(numTurns: number): void {
    this.numTurnsValue = numTurns;
    this.registry.setNumTurns(this.executionId, numTurns);
  }

  private absorbResultCounts(result: RunResult): void {
    if (typeof result.num_turns === 'number') this.setNumTurns(result.num_turns);
    if (result.sessionId) this.backendSessionIdValue = result.sessionId;
  }

  // ── terminal transitions ───────────────────────────────────────────────

  private onForegroundResult(result: RunResult): void {
    if (this.terminal) return;
    this.foregroundResult = result;
    this.absorbResultCounts(result);
    this.resultDeferred.resolve(result);
    this.fanOut({ type: 'foreground_result', result });
    // A required observer may have sealed the run while the result was being fanned out.
    if (this.terminal) return;

    const pendingBackground = result.pendingBackgroundTasks ?? 0;
    const undeliveredBackground = result.undeliveredBackgroundTasks ?? 0;
    // An inline policy means the facade already waited for the background work itself, and its
    // wait replaced the process's single continuation sink to do so. Whatever it did not drain
    // (grace/max-wait expiry with tasks still pending) can no longer reach this run, so entering
    // the background phase here would wait for a result that can never arrive — the execution
    // record would stay open and the session would read as running forever.
    if (this.awaitsBackgroundInline()) {
      this.finishTerminal(result.rateLimited ? 'rate-limited' : 'completed', result);
      return;
    }
    if (this.continuationSinkInstalled && (remainingBg(result) > 0 || this.pendingInjections.length > 0)) {
      this.phaseValue = 'background';
      this.statusValue = 'background';
      this.fanOut({ type: 'phase', phase: 'background', pendingBackground, undeliveredBackground });
      return;
    }
    this.finishTerminal(result.rateLimited ? 'rate-limited' : 'completed', result);
  }

  private onForegroundError(error: unknown): void {
    if (this.terminal) return;
    const failure = asError(error);
    // Defer one microtask before publishing the failure and tearing the execution down. The old
    // hand-rolled conversation path registered the live handle synchronously and only finalized it
    // from the caller's error handler, so a surface that observes the run right after it starts
    // (e.g. the first-turn interrupt/resume test) saw the handle. Tearing down in the same microtask
    // the rejection is delivered would hide it; one hop restores that observation window without
    // changing the terminal contract. `cancel()` still seals synchronously and wins the race.
    queueMicrotask(() => this.finishForegroundError(failure));
  }

  private finishForegroundError(failure: Error): void {
    if (this.terminal) return;
    // `cancelRequested` only covers a cancel that came through this object. Stop/!cancel/thread
    // abort still kill the process directly, and the adapter rejects with a `cancelled` error; the
    // old facade suppressed the terminal notice for exactly that flag, so honour it here too —
    // otherwise a user pressing Stop gets an error card and a 'failed' execution.
    if (this.cancelRequested || (failure as { cancelled?: boolean }).cancelled === true) {
      this.finishTerminal('cancelled', null, failure);
      return;
    }
    this.fanOut({ type: 'error', message: failure.message, fatal: true });
    this.finishTerminal('failed', null, failure);
  }

  private finishTerminal(status: RunStatus, result: RunResult | null, error?: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.statusValue = status;
    this.phaseValue = 'done';
    this.fanOut({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
    const durationS = (Date.now() - this.startedAt) / 1000;
    const terminalResult = result ?? this.backgroundResult ?? this.foregroundResult;
    try {
      this.onTerminal({ status, result: terminalResult, error, durationS });
    } catch (terminalError) {
      log.warn('run terminal handler failed:', asError(terminalError).message);
    }
    if (error) {
      this.resultDeferred.reject(error);
      this.settleDeferred.reject(error);
    } else {
      this.resultDeferred.resolve(terminalResult as RunResult);
      this.settleDeferred.resolve(terminalResult as RunResult);
    }
    this.closeObservers();
  }

  // ── observer fan-out ───────────────────────────────────────────────────

  private fanOut(event: RunEvent): void {
    for (const observer of [...this.observers]) {
      try {
        const pending = observer.onEvent(event);
        if (pending && typeof (pending as Promise<void>).then === 'function') {
          void (pending as Promise<void>).catch((error) => this.onObserverError(observer, error));
        }
      } catch (error) {
        this.onObserverError(observer, error);
      }
    }
  }

  private closeObservers(): void {
    if (this.observersClosed) return;
    this.observersClosed = true;
    for (const observer of [...this.observers]) {
      try {
        const pending = observer.onClose?.();
        if (pending && typeof (pending as Promise<void>).then === 'function') {
          void (pending as Promise<void>).catch((error) => this.onObserverError(observer, error));
        }
      } catch (error) {
        this.onObserverError(observer, error);
      }
    }
  }

  private onObserverError(observer: RunObserver, error: unknown): void {
    log.warn('run observer failed:', asError(error).message);
    if (observer.required === true && !this.terminal) {
      try { this.handle?.kill(); } catch (killError) { log.warn('run kill failed:', asError(killError).message); }
      this.finishTerminal('failed', null, asError(error));
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
