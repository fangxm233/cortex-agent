// input:  RunRequest + RunObserver[] plus today's facade AgentHandle / NormalizedEvent stream
// output: AgentRun state machine — phases, results, registry hooks, cancel/subscribe, legacy process
// pos:    The run ownership object. P1.3 wraps facade.runAgent; P2 replaces the engine path under it.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { RunRegistry } from '@core/run-registry.js';
import type { AgentHandle } from '@core/types/agent-types.js';
import { remainingBg } from '../../agent-adapter/bg-wait.js';
import { CAPABILITIES_BY_BACKEND } from '../../agent-adapter/capabilities.js';
import type { Capability } from '../../agent-adapter/capabilities.js';
import type {
  AgentProcess, ContinuationSink, UserMessage,
} from '../../agent-adapter/types.js';
import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import type { AgentConfig, RunAgentOptions } from '../agents/spawn-config.js';
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

/** The one ownership object for a run (plan §3.3). `steer`/`respondToDialog` are stubs in Phase 1:
 *  P1.8 wires `steer`, P2.4 wires `respondToDialog`. */
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
  /** Phase 1 stub — P1.8 implements mid-turn injection. */
  steer(msg: UserMessage): Promise<'folded' | 'queued' | 'refused'>;
  /** Phase 1 stub — P2.4 implements dialog responses. */
  respondToDialog(id: string, payload: Record<string, unknown>): boolean;
  cancel(reason: 'user' | 'supersede' | 'shutdown'): void;
  subscribe(observer: RunObserver): () => void;
  /**
   * @deprecated Transitional P1.3 accessor for call sites that still hand the raw process to the
   * old background-hold machinery. P2.3 deletes it.
   */
  legacyProcess(): AgentProcess | undefined;
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

/**
 * Translate a fully-resolved `RunRequest` into today's `RunAgentOptions`. Every legacy callback is
 * left unset: the run observes the raw adapter stream through `observers` and fans it out as
 * `RunEvent`s, so no call site has to wire eleven callbacks.
 */
export function buildRunAgentOptions(
  request: RunRequest,
  executionId: string,
  onAdapterEvent: (event: NormalizedEvent) => void,
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
    outputStyle: request.spec.backendOptions.outputStyle ?? null,
    claudeAgent: request.spec.backendOptions.claudeAgent ?? null,
    tools: request.spec.tools,
    pluginDirs: request.spec.pluginDirs,
    mcpComposition: request.policy.mcpComposition,
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
    // The run observes the raw adapter stream; the facade never sees a legacy callback from here.
    observers: [{ onEvent: onAdapterEvent }],
  };
}

/** The Phase 1 `AgentRun`. One per `startRun`; owns all per-run mutable state. */
export class AgentRunImpl implements AgentRun {
  readonly id: string;
  readonly request: RunRequest;
  readonly executionId: string;
  readonly attempt: { index: number; config: AgentConfig };
  readonly capabilities: ReadonlySet<Capability>;
  readonly result: Promise<RunResult>;
  readonly settled: Promise<RunResult>;

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
  private started = false;
  private terminal = false;
  private observersClosed = false;
  private cancelRequested = false;

  constructor(args: CreateAgentRunArgs) {
    this.request = args.request;
    this.executionId = args.executionId;
    this.id = args.request.runId;
    this.attempt = { index: 0, config: args.attemptConfig };
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
        buildRunAgentOptions(this.request, this.executionId, (event) => this.onAdapterEvent(event)),
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

  steer(_msg: UserMessage): Promise<'folded' | 'queued' | 'refused'> {
    return Promise.resolve('refused');
  }

  respondToDialog(_id: string, _payload: Record<string, unknown>): boolean {
    return false;
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
      trackSessionId: this.request.session.sessionId,
      backendSessionId: handle.sessionId ?? this.request.session.backendSessionId,
      sessionId: handle.sessionId,
    });
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
      if (typeof event.numTurns === 'number') this.setNumTurns(event.numTurns);
      return;
    }
    this.absorb(toRunEvent(event, this.phaseValue));
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

    const pendingBackground = result.pendingBackgroundTasks ?? 0;
    const undeliveredBackground = result.undeliveredBackgroundTasks ?? 0;
    if (this.continuationSinkInstalled && remainingBg(result) > 0) {
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
    if (this.cancelRequested) {
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
