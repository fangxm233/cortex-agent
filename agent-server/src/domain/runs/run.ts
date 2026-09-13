// input:  RunRequest + RunObserver[] plus today's facade AgentHandle / NormalizedEvent stream
// output: AgentRun state machine — phases, results, registry hooks, cancel/subscribe, legacy process
// pos:    The run ownership object. Wraps `facade.runAgent`, which drives the engine path.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import type { RunRegistry } from '@core/run-registry.js';
import { remainingBg } from '../../agent-adapter/bg-wait.js';
import { CAPABILITIES_BY_BACKEND, Capability } from '../../agent-adapter/capabilities.js';
import type { UserMessage } from '../../agent-adapter/types.js';
import type { RunEvent, RunPhase } from '../../agent-adapter/run-events.js';
import type { AgentConfig, EngineAttemptHandle, RunAgentOptions } from '../agents/spawn-config.js';
// Imported from the facade directly: `runAgent` is no longer part of the `domain/agents` barrel
// (only the run layer may start a run). Tests that need to intercept the attempt mock this module.
import { runAgent } from '../agents/facade.js';
import type { RunObserver, RunRequest, RunResult } from './request.js';

const log = createLogger('run');

/** The run lifecycle. `starting → running → (background) → completed | failed | cancelled | rate-limited`. */
export type RunStatus =
  | 'starting' | 'running' | 'background' | 'completed' | 'failed' | 'cancelled' | 'rate-limited';

/** The one ownership object for a run (plan §3.3). */
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
   */
  respondToDialog(id: string, payload: Record<string, unknown>): boolean;
  cancel(reason: 'user' | 'supersede' | 'shutdown'): void;
  subscribe(observer: RunObserver): () => void;
  /**
   * True once a background surface (`status-renderer` / `web-status-renderer`) has claimed the
   * background turn's rows. `AgentProcess.setContinuationSink` used to be a single slot, so exactly
   * one consumer ever wrote those rows; this flag keeps that guarantee now that several observers
   * can watch the same run.
   */
  readonly backgroundTranscriptOwned: boolean;
  /** Claim the background transcript for a hold. Idempotent. */
  claimBackgroundTranscript(): void;
  /**
   * Push an event produced outside this run's own turn into its stream (see
   * `EngineSession.ingestExternal`). False once the run is over.
   */
  ingestExternal(event: RunEvent): boolean;
}

/** What the run reports back to `startRun` when it reaches a terminal state. */
export interface RunTerminalInfo {
  status: RunStatus;
  result: RunResult | null;
  error?: Error;
  durationS: number;
}

/** The slice of the attempt layer the run depends on: it opens one engine session for the request
 *  and hands back the attempt handle. Injectable for tests. */
export type RunAgentFn = (message: string, options: RunAgentOptions) => EngineAttemptHandle;

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
 *    `run_fallback` event. */
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
  onRunEvent: (event: RunEvent) => void,
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
    observers: [{ onEvent: onRunEvent }],
  };
}

/** The `AgentRun`. One per `startRun`; owns all per-run mutable state. */
export class AgentRunImpl implements AgentRun {
  readonly id: string;
  readonly request: RunRequest;
  readonly executionId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly result: Promise<RunResult>;
  readonly settled: Promise<RunResult>;

  private attemptValue: { index: number; config: AgentConfig };
  /** Reporting model of the latest assistant event, restamped onto the synthesized notices. */
  private lastAssistantModel: string | null = null;
  private backgroundTranscriptOwnedValue = false;
  private statusValue: RunStatus = 'starting';
  private phaseValue: RunPhase = 'foreground';
  private numTurnsValue: number | null = null;
  private backendSessionIdValue: string | null;
  private foregroundResult: RunResult | null = null;
  /** Fanned out only so a surface can tell "the engine is still streaming" from "nothing happened
   *  yet"; the authoritative numbers come from the attempt handle's `settled`. */
  private lastBackgroundResult: RunResult | null = null;

  private readonly observers: RunObserver[];
  private readonly registry: RunRegistry;
  private readonly onTerminal: (info: RunTerminalInfo) => void;
  private readonly startedAt: number;
  private readonly runAgentFn: RunAgentFn;
  private readonly settleDeferred = deferred<RunResult>();
  private readonly resultDeferred = deferred<RunResult>();

  private handle: EngineAttemptHandle | null = null;
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
  get backgroundTranscriptOwned(): boolean { return this.backgroundTranscriptOwnedValue; }

  claimBackgroundTranscript(): void { this.backgroundTranscriptOwnedValue = true; }

  /** Begin the run. Called exactly once by `startRun`, synchronously. */
  start(): void {
    if (this.started) return;
    this.started = true;
    let handle: EngineAttemptHandle;
    try {
      handle = this.runAgentFn(
        this.request.prompt.text,
        buildRunAgentOptions(this.request, this.executionId, (event) => this.onRunEvent(event), {
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
    void handle.promise.then(
      (result) => this.onForegroundResult(result),
      (error) => this.onForegroundError(error),
    );
  }

  /**
   * Deliver `msg` into the live turn without opening a new Cortex run. The engine session owns the
   * backend conversation and answers whether it can take the message; the run only decides what
   * that means for its own lifecycle.
   */
  steer(msg: UserMessage, injectionId?: string): Promise<'folded' | 'queued' | 'refused'> {
    if (this.terminal) return Promise.resolve('refused');
    if (!this.capabilities.has(Capability.MidTurnInject)) return Promise.resolve('refused');
    const engine = this.handle?.engine;
    if (!engine) return Promise.resolve('refused');
    let accepted = false;
    try {
      accepted = engine.steer(msg, injectionId).accepted;
    } catch (error) {
      log.warn('run steer failed:', asError(error).message);
    }
    if (!accepted) return Promise.resolve('refused');
    // The authoritative folded/queued outcome arrives later as an `injection_delivered` event; the
    // synchronous return only tells the caller not to queue it.
    return Promise.resolve(this.phaseValue === 'background' ? 'queued' : 'folded');
  }

  /** Answer an in-flight backend dialog (PI `ask_user` / plan approval) through the live engine. */
  respondToDialog(id: string, payload: Record<string, unknown>): boolean {
    return this.handle?.engine?.respondToDialog(id, payload) ?? false;
  }

  /**
   * Push an event produced outside the run's own turn into its stream: a hosted child that keeps
   * producing rows after its parent turn closed. It lands on the same stream as everything else.
   */
  ingestExternal(event: RunEvent): boolean {
    if (this.terminal) return false;
    return this.handle?.engine?.ingestExternal(event) ?? false;
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

  // ── wiring ─────────────────────────────────────────────────────────────

  private registerHandle(handle: EngineAttemptHandle): void {
    this.registry.register({
      threadId: this.request.context.threadId ?? null,
      channel: this.request.context.channel,
      agentSlotId: this.request.benchmark?.agentSlotId ?? null,
      executionId: this.executionId,
      kind: this.request.context.executionKind,
      kill: () => handle.kill(),
      backend: this.request.profile.backend,
      run: this,
      trackSessionId: this.request.session.sessionId,
      backendSessionId: handle.sessionId ?? this.request.session.backendSessionId,
      sessionId: handle.sessionId,
    });
    // The engine's spawn-time backend id is authoritative even when it never emits a
    // `session_started` event (an interrupted first turn). Surfaces that persist the resume target
    // on settle read `run.backendSessionId`, so record it here.
    if (handle.sessionId) this.backendSessionIdValue = handle.sessionId;
  }

  // ── event flow ─────────────────────────────────────────────────────────

  /**
   * One event of the run's stream. The engine already decided what it means for the run's lifetime
   * (background phase, watchdog, the terminal `phase`), so this only keeps the run's own bookkeeping
   * and fans the event out.
   */
  private onRunEvent(event: RunEvent): void {
    if (this.terminal) return;
    // Assistant prose reaches the run through the `onAssistantMessage` hook instead: that path
    // carries the facade's notice classification and interleaves the synthesized notices in the
    // order they were produced. Relaying the raw event too would double every message.
    if (event.type === 'assistant_text') {
      if (event.model) this.lastAssistantModel = event.model;
      return;
    }
    // The run emits its own `foreground_result` from the attempt handle's resolved result, which
    // carries the full AgentResult; the stream's copy is the engine's own marker.
    if (event.type === 'foreground_result') return;
    if (event.type === 'phase' && event.phase === 'done') {
      this.onEngineDone();
      return;
    }
    this.absorb(event);
  }

  /**
   * The engine's stream ended: the run is over. The accumulated result comes from the attempt
   * handle's `settled`, not from the last event — a multi-continuation run reports the whole run.
   */
  private onEngineDone(): void {
    if (this.terminal) return;
    if (!this.handle) { this.finishTerminal('completed', this.foregroundResult); return; }
    void this.handle.settled.then(
      (result) => this.finishTerminal(result.rateLimited ? 'rate-limited' : 'completed', result),
      (error) => this.finishForegroundError(asError(error)),
    );
  }

  /**
   * The profile's fallback chain switched attempt. Advance the attempt and report it on the stream;
   * the surface renders the notice.
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
      case 'background_result':
        this.lastBackgroundResult = event.result;
        this.absorbResultCounts(event.result);
        break;
      default:
        break;
    }
    this.fanOut(event);
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
    // The engine keeps its stream open exactly while the run still owes background work, and it is
    // the engine that ends the run (see ContinuationPhase). The run mirrors the phase onto its own
    // status so surfaces can tell a held session from a finished one.
    if (remainingBg(result) > 0) {
      this.phaseValue = 'background';
      this.statusValue = 'background';
    }
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
    // abort still kill the process directly, and the engine rejects with a `cancelled` error; the
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
    const terminalResult = result ?? this.lastBackgroundResult ?? this.foregroundResult;
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
