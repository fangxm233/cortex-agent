import { createLogger } from '@core/log.js';
import type { RunRegistry } from '@core/run-registry.js';
import { remainingBg } from '../../agent-adapter/bg-wait.js';
import { mergeContinuation } from '../../agent-adapter/continuation-phase.js';
import { CAPABILITIES_BY_BACKEND, Capability } from '../../agent-adapter/capabilities.js';
import type { EngineSpec, UserMessage } from '../../agent-adapter/types.js';
import type { RunEvent, RunPhase } from '../../agent-adapter/run-events.js';
import { getSettings } from '@core/settings.js';
import { t } from '../../core/i18n.js';
import type { ModeEnv } from './mode-env.js';
import {
  fallbackReasonOf, isRetryableError, isRetryableResult, type FallbackReason,
} from './retryable-errors.js';
import type { RunAttemptConfig } from '../agents/profile-manager.js';
import { publishAuthRecovered, publishAuthRequired, classifyAuthError } from '../auth/auth-events.js';
import {
  attemptProvider, attemptProviderOrNull, rateLimitedResult, shouldSkipAttempt, planAttempts,
  attemptLabel,
} from './fallback.js';
import { requestRoute } from './config-resolver.js';
import { AttemptNoticeTracker, assistantNoticeLevel } from './notices.js';
import { startAttempt, type RunAttempt } from './attempt.js';
import type { RunObserver, RunRequest, RunResult } from './request.js';

const log = createLogger('run');

/** How many plugin skip reasons a notice lists before summarizing the rest. */
const PLUGIN_WARNINGS_SHOWN = 3;

/** How a run ends. `rate-limited` stays its own outcome; the execution record files it as a failure
 *  that names the rate limit (`executions/registry.ts` teardownExecution). */
export type TerminalRunStatus = 'completed' | 'failed' | 'cancelled' | 'rate-limited';

/** The run lifecycle. `running → (background) → completed | failed | cancelled | rate-limited`. */
export type RunStatus = 'running' | 'background' | TerminalRunStatus;

/** The one ownership object for a run (plan §3.3). */
export interface AgentRun {
  readonly id: string;
  readonly request: RunRequest;
  readonly executionId: string;
  readonly status: RunStatus;
  readonly phase: RunPhase;
  readonly numTurns: number | null;
  readonly attempt: { index: number; config: RunAttemptConfig };
  /**
   * The session's resume target: the backend session id on the session's OWN backend (the
   * profile's). A fallback attempt on another backend never names it — its id would be resumed by
   * the wrong CLI next turn — so across such a fallback this keeps the primary's id.
   */
  readonly backendSessionId: string | null;
  /** What the attempt running now can do. Follows the chain onto a fallback's backend. */
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
   * `injectionId` lets the caller (the pending-injection ledger in `orchestration/injection-ledger`)
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
   * True once a background surface (`turn/hold-render-platform` / `hold-render-web`) has claimed the
   * background turn's rows. Only one consumer may write them — the engine binds exactly one
   * background-turn sink — and this flag keeps that guarantee now that several observers can watch
   * the same run.
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
  status: TerminalRunStatus;
  /** What the run had produced when it ended — the foreground turn plus every continuation that
   *  settled, also on a cancelled or failed run, so the spend already incurred is not lost. */
  result: RunResult | null;
  error?: Error;
  durationS: number;
}

export interface CreateAgentRunArgs {
  request: RunRequest;
  observers: RunObserver[];
  executionId: string;
  registry: RunRegistry;
  onTerminal: (info: RunTerminalInfo) => void;
  /** Unix ms the execution record was opened. */
  startedAt: number;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The error a turn ends with when a transport failure hit after it ran a tool. It keeps the
 *  original message — auth classification and provider attribution read it. */
function notRetriedAfterTools(failure: Error): Error {
  return new Error(t('status.notRetriedAfterTools', { message: failure.message }));
}

function cancellationError(reason: string): Error {
  return Object.assign(new Error(`Run cancelled (${reason})`), { cancelled: true });
}

/** The `AgentRun`. One per `startRun`; owns all per-run mutable state. */
export class AgentRunImpl implements AgentRun {
  readonly id: string;
  readonly request: RunRequest;
  readonly executionId: string;
  readonly result: Promise<RunResult>;
  readonly settled: Promise<RunResult>;

  private attemptValue: { index: number; config: RunAttemptConfig };
  /** Reporting model of the latest assistant event, restamped onto the synthesized notices. */
  private lastAssistantModel: string | null = null;
  private backgroundTranscriptOwnedValue = false;
  private statusValue: RunStatus = 'running';
  private phaseValue: RunPhase = 'foreground';
  private numTurnsValue: number | null = null;
  private backendSessionIdValue: string | null;
  private foregroundResult: RunResult | null = null;
  /** Continuation results seen so far. The live tally and a run that ends before its attempt
   *  settles (Stop, failure) read them; a settled attempt reports its own merged result. */
  private readonly continuations: RunResult[] = [];

  private readonly observers: RunObserver[];
  private readonly registry: RunRegistry;
  private readonly onTerminal: (info: RunTerminalInfo) => void;
  private readonly startedAt: number;
  private readonly settleDeferred = deferred<RunResult>();
  private readonly resultDeferred = deferred<RunResult>();
  /** Everything this run is allowed to try, in order (fallback.ts). */
  private readonly plan: RunAttemptConfig[];
  /** Narrates the chain. It sits IN the event path because it can swallow a line. */
  private readonly notices: AttemptNoticeTracker;
  /** Mirrors the old dispatcher's `active`: once the foreground turn is over, the run stops
   *  synthesizing notices about itself — the background phase is not a new turn to announce. */
  private noticesActive = true;
  private pluginWarningsAnnounced = false;

  private current: RunAttempt | null = null;
  private started = false;
  private terminal = false;
  private observersClosed = false;
  private cancelRequested = false;

  constructor(args: CreateAgentRunArgs) {
    this.request = args.request;
    this.executionId = args.executionId;
    this.id = args.request.runId;
    this.plan = planAttempts(args.request.profile);
    this.attemptValue = { index: 0, config: this.plan[0] };
    this.notices = new AttemptNoticeTracker(
      {
        channel: args.request.context.channel,
        isUserInitiated: args.request.context.isUserInitiated,
        trigger: args.request.context.trigger,
      },
      (text, blockId, noticeLevel, noticeAction, subagent) => this.absorb({
        type: 'assistant_text', text, phase: this.phaseValue,
        ...(this.lastAssistantModel ? { model: this.lastAssistantModel } : {}),
        ...(blockId ? { blockId } : {}),
        ...(noticeLevel ? { noticeLevel } : {}),
        ...(noticeAction ? { noticeAction } : {}),
        ...(subagent ? { subagent } : {}),
      }),
    );
    this.backendSessionIdValue = args.request.session.backendSessionId;
    this.observers = [...args.observers];
    this.registry = args.registry;
    this.onTerminal = args.onTerminal;
    this.startedAt = args.startedAt;
    this.result = this.resultDeferred.promise;
    this.settled = this.settleDeferred.promise;
    // Both promises reject on a failed/cancelled run, and not every caller awaits both (a surface
    // that only awaits `result` still gets a rejected `settled`). Mark them handled here so an
    // unawaited one cannot take the process down with an unhandled rejection; a real awaiter still
    // observes the rejection normally.
    void this.result.catch(() => undefined);
    void this.settled.catch(() => undefined);
  }

  get attempt(): { index: number; config: RunAttemptConfig } { return this.attemptValue; }
  get status(): RunStatus { return this.statusValue; }
  get phase(): RunPhase { return this.phaseValue; }
  get numTurns(): number | null { return this.numTurnsValue; }
  get backendSessionId(): string | null { return this.backendSessionIdValue; }
  get capabilities(): ReadonlySet<Capability> { return CAPABILITIES_BY_BACKEND[this.attemptValue.config.backend]; }

  /** True while the running attempt is on the session's own backend, i.e. while its backend id
   *  may become the session's resume target (see `backendSessionId`). */
  private get onSessionBackend(): boolean {
    return this.attemptValue.config.backend === this.request.profile.backend;
  }

  /** Adopt `id` as the resume target, unless the running attempt is on another backend. */
  private adoptBackendSessionId(id: string | null | undefined): void {
    if (id && this.onSessionBackend) this.backendSessionIdValue = id;
  }
  get backgroundTranscriptOwned(): boolean { return this.backgroundTranscriptOwnedValue; }

  claimBackgroundTranscript(): void { this.backgroundTranscriptOwnedValue = true; }

  /** Begin the run. Called exactly once by `startRun`, synchronously. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.walkChain();
  }

  /**
   * Walk the attempt chain: try each engine selection in turn, and stop at the first one that
   * produces a non-retryable outcome. An attempt whose provider/mode is already known blocked is
   * skipped without spawning, unless a person is waiting on it.
   *
   * The whole chain is one run: the same runId, the same observers, one execution record. Only
   * `attempt.index` moves.
   */
  private async walkChain(): Promise<void> {
    let reason: FallbackReason = 'rate-limited';
    for (let index = 0; index < this.plan.length; index++) {
      if (this.terminal) return;
      const attempt = this.plan[index];
      const isLast = index === this.plan.length - 1;
      if (index > 0) this.advanceAttempt(index, attempt, reason);

      if (shouldSkipAttempt(attempt, { isUserInitiated: this.request.context.isUserInitiated })) {
        const blocked = rateLimitedResult(attempt.mode || 'api', attemptProvider(attempt));
        if (isLast) {
          this.notices.emitTerminalRateLimit(blocked);
          this.settleBlocked(blocked);
          return;
        }
        log.info(`${attemptLabel(attempt)} rate-limited, skipping to fallback[${index}]`);
        reason = 'rate-limited';
        this.notices.transitionToFallback(attempt, this.plan[index + 1], reason);
        continue;
      }

      const outcome = await this.runAttempt(attempt, index, isLast);
      if (outcome === 'settled') return;
      reason = outcome;
      this.notices.transitionToFallback(attempt, this.plan[index + 1], reason);
    }
    // Unreachable: the last attempt always settles or throws. Guard rather than hang.
    if (!this.terminal) this.finishForegroundError(new Error('All fallback configs exhausted without result'));
  }

  /**
   * One attempt. Returns 'settled' when the run is over, or why the chain should advance.
   *
   * A fallback re-runs the whole turn in a fresh backend conversation. That is safe for a rate
   * limit (the provider refused before doing anything) and for a transport failure that hit before
   * the turn ran any tool; after a tool ran, re-running would repeat its side effects, so the turn
   * ends with an error that says why it was not retried.
   */
  private async runAttempt(
    attempt: RunAttemptConfig, index: number, isLast: boolean,
  ): Promise<'settled' | FallbackReason> {
    // A retry starts a fresh backend conversation: the previous attempt's resume target belongs to
    // a provider that just failed us.
    const request = index === 0
      ? this.request
      : { ...this.request, session: { ...this.request.session, backendSessionId: null } };
    // Once the chain moves on, whatever this attempt still streams (a hold-mode background phase,
    // the close of its engine) belongs to no one: observers follow the attempt that replaced it.
    let abandoned = false;
    let toolStarted = false;
    let current: RunAttempt;
    try {
      current = startAttempt({
        request, attempt, executionId: this.executionId,
        route: this.routeFor(attempt),
        onEvent: (event) => {
          if (abandoned) return;
          if (event.type === 'tool_use') toolStarted = true;
          this.onRunEvent(event);
        },
      });
    } catch (error) {
      this.onForegroundError(error);
      return 'settled';
    }
    this.current = current;
    this.registerAttempt(current);
    this.announcePluginWarnings(current.spec);

    try {
      const result = await current.foreground;
      if (!isRetryableResult(result) || isLast) {
        this.settleAttemptResult(current, result);
        return 'settled';
      }
      log.info(`${attemptLabel(attempt)} rate limited, trying fallback[${index}]`);
      abandoned = true;
      return 'rate-limited';
    } catch (error) {
      const failure = asError(error);
      if (this.cancelRequested || !isRetryableError(failure) || isLast) {
        this.onAttemptError(current, attempt, error);
        return 'settled';
      }
      const reason = fallbackReasonOf(failure);
      if (reason === 'transport-error' && toolStarted) {
        log.info(`${attemptLabel(attempt)} transport error after a tool ran; not retrying on fallback[${index}]`);
        this.onAttemptError(current, attempt, notRetriedAfterTools(failure));
        return 'settled';
      }
      log.info(`${attemptLabel(attempt)} retryable error (${reason}), trying fallback[${index}]`);
      abandoned = true;
      return reason;
    }
  }

  /** The route (base URL + credentials) this attempt runs under. Per-attempt, because a fallback
   *  may be a different mode entirely. */
  private routeFor(attempt: RunAttemptConfig): ModeEnv {
    return requestRoute(this.request, attempt);
  }

  /** The chain moved on. Report it on the stream; the surface renders the notice. */
  private advanceAttempt(index: number, next: RunAttemptConfig, reason: FallbackReason): void {
    const previous = this.attemptValue.config;
    this.attemptValue = { index, config: next };
    this.absorb({
      type: 'run_fallback',
      from: attemptLabel(previous),
      to: attemptLabel(next),
      reason,
    });
  }

  /** Every attempt that reached a backend settles here: provider attribution and the auth
   *  lifecycle apply to the WHOLE attempt, background phase included, which is why they are done
   *  on the settled value rather than wrapped around the foreground promise. */
  private settleAttemptResult(current: RunAttempt, result: RunResult): void {
    const attributed = this.attribute(result);
    if (attributed.rateLimited) this.notices.emitTerminalRateLimit(attributed);
    else this.notices.settleSuccess();
    this.publishAuthOutcome(attributed, null);
    this.onForegroundResult(attributed);
    void current.settled.then(
      (settled) => this.onAttemptSettled(this.attribute(settled)),
      (error) => this.finishForegroundError(asError(this.attributeError(error))),
    );
  }

  /** A blocked pre-flight never reached a backend: there is no stream to wait for, so the run is
   *  over as soon as the refusal is reported. (A chain that ended here used to leave its execution
   *  record open forever, because nothing ever emitted the engine's terminal `phase`.) */
  private settleBlocked(result: RunResult): void {
    this.onForegroundResult(result);
    this.finishTerminal('rate-limited', result);
  }

  private onAttemptError(current: RunAttempt, attempt: RunAttemptConfig, error: unknown): void {
    const failure = this.attributeError(error);
    this.notices.emitTerminalError(failure);
    this.publishAuthOutcome(null, failure, attempt);
    void current.settled.catch(() => undefined);
    this.onForegroundError(failure);
  }

  /** Stamp the attempt's provider onto a result that did not name one. An attempt with no engine
   *  selection (an unknown profile name) names no provider: see `attemptProviderOrNull`. */
  private attribute(result: RunResult): RunResult {
    const provider = attemptProviderOrNull(this.attemptValue.config);
    if (!provider || result.rateLimitProvider) return result;
    return { ...result, rateLimitProvider: provider };
  }

  private attributeError(error: unknown): Error {
    const failure = asError(error);
    const provider = attemptProviderOrNull(this.attemptValue.config);
    if (provider && isRetryableError(failure)) {
      (failure as Error & { rateLimitProvider?: string }).rateLimitProvider ??= provider;
    }
    return failure;
  }

  /** Auth is a property of the provider, not of the turn: a run that came back without a rate
   *  limit proves the credentials still work, and a run that failed on auth must say which
   *  provider needs attention. */
  private publishAuthOutcome(
    result: RunResult | null, error: Error | null, attempt = this.attemptValue.config,
  ): void {
    const identity = { backend: attempt.backend, provider: attemptProvider(attempt) };
    if (result) {
      if (!result.rateLimited) publishAuthRecovered(identity);
      return;
    }
    const kind = classifyAuthError(error?.message ?? '');
    if (!kind) return;
    publishAuthRequired({
      ...identity, authType: null, kind,
      channel: this.request.context.channel,
      sessionId: this.request.session.sessionId
        ?? this.backendSessionIdValue
        ?? this.request.session.backendSessionId,
    });
  }

  /**
   * Deliver `msg` into the live turn without opening a new Cortex run. The engine session owns the
   * backend conversation and answers whether it can take the message; the run only decides what
   * that means for its own lifecycle.
   */
  steer(msg: UserMessage, injectionId?: string): Promise<'folded' | 'queued' | 'refused'> {
    if (this.terminal) return Promise.resolve('refused');
    if (!this.capabilities.has(Capability.MidTurnInject)) return Promise.resolve('refused');
    const engine = this.current?.engine;
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
    return this.current?.engine.respondToDialog(id, payload) ?? false;
  }

  /**
   * Push an event produced outside the run's own turn into its stream: a hosted child that keeps
   * producing rows after its parent turn closed. It lands on the same stream as everything else.
   */
  ingestExternal(event: RunEvent): boolean {
    if (this.terminal) return false;
    return this.current?.engine.ingestExternal(event) ?? false;
  }

  cancel(reason: 'user' | 'supersede' | 'shutdown'): void {
    if (this.terminal) return;
    this.cancelRequested = true;
    try { this.current?.kill(); } catch (error) { log.warn('run kill failed:', asError(error).message); }
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

  private registerAttempt(attempt: RunAttempt): void {
    this.registry.register({
      channel: this.request.context.channel,
      executionId: this.executionId,
      kind: this.request.context.executionKind,
      kill: () => attempt.kill(),
      backend: attempt.backend,
      run: this,
      trackSessionId: this.request.session.sessionId,
      backendSessionId: attempt.backendSessionId ?? this.request.session.backendSessionId,
      subagent: this.request.context.trigger === 'subagent',
    });
    // The engine's spawn-time backend id is authoritative even when it never emits a
    // `session_started` event (an interrupted first turn). Surfaces that persist the resume target
    // on settle read `run.backendSessionId`, so record it here.
    this.adoptBackendSessionId(attempt.backendSessionId);
  }

  // ── event flow ─────────────────────────────────────────────────────────

  /**
   * One event of the attempt's stream. The engine already decided what it means for the run's
   * lifetime (background phase, watchdog, the terminal `phase`); this keeps the run's own
   * bookkeeping, runs the notice stage, and fans the event out.
   *
   * The notice stage sits HERE rather than beside the stream because it can swallow a line: a
   * rate-limit card is held until the settle says whether it was a failure or a pause.
   */
  private onRunEvent(event: RunEvent): void {
    if (this.terminal) return;
    this.refreshBackendSessionId();
    switch (event.type) {
      case 'assistant_text':
        // Prose goes through the notice stage, which re-emits it (possibly later, possibly not at
        // all) as an `assistant_text` event of its own. Relaying the raw event too would double it.
        if (event.model) this.lastAssistantModel = event.model;
        this.notices.observe(
          event.text, event.blockId, assistantNoticeLevel(event.text), undefined, event.subagent,
        );
        return;
      case 'foreground_result':
        // The run emits its own, carrying the full AgentResult; the stream's copy is the engine's
        // own marker. After it, the run stops narrating itself — a background turn is not news.
        this.noticesActive = false;
        return;
      case 'phase':
        if (event.phase === 'done') return;
        break;
      case 'engine_started':
        this.announceBackendSessionReset(event.backendSessionId);
        break;
      case 'context_compacted':
        if (this.noticesActive && getSettings().notifyCompaction) {
          this.notices.observe(t('notify.contextCompacted'), undefined, 'info');
        }
        break;
      case 'model_fallback':
        // The BACKEND swapped models under us (not our fallback chain) — say so.
        if (this.noticesActive) {
          this.notices.observe(t('notify.agentFallback', {
            from: event.originalModel, to: event.fallbackModel,
          }), undefined, 'warning');
        }
        break;
      default:
        break;
    }
    this.absorb(event);
  }

  /**
   * Selected plugin skills or MCP servers that could not be materialized for this spawn. The turn
   * runs without them, which looks healthy unless someone says so. Once per run, web surfaces only
   * (Slack/Feishu have no notice lines), like the other synthesized notices.
   */
  private announcePluginWarnings(spec: EngineSpec): void {
    // Read defensively: this notice is advisory and must never be what breaks a run.
    const warnings = spec?.plugins?.warnings;
    if (!warnings?.length || this.pluginWarningsAnnounced || !this.noticesActive) return;
    if (!this.request.context.channel?.startsWith('web:')) return;
    this.pluginWarningsAnnounced = true;
    const shown = warnings.slice(0, PLUGIN_WARNINGS_SHOWN).join('\n');
    const more = warnings.length - PLUGIN_WARNINGS_SHOWN;
    this.notices.observe(t('notify.pluginsUnavailable', {
      detail: more > 0 ? `${shown}\n${t('notify.pluginsUnavailableMore', { n: more })}` : shown,
    }), undefined, 'warning');
  }

  /**
   * The backend came back with a different session than the one we asked it to resume: its
   * transcript is gone and this turn starts from nothing. A web surface is the only one told —
   * everywhere else the status message already renders the turn as restarted, and a second line
   * saying so is a duplicate (see `run-with-adapter.test.ts`, the `slack:C1` case).
   */
  private announceBackendSessionReset(backendSessionId: string): void {
    if (!this.noticesActive) return;
    if (!this.request.context.channel?.startsWith('web:')) return;
    const spec = this.current?.spec;
    if (!spec?.resume.resume || !spec.resume.backendSessionId) return;
    if (backendSessionId === spec.resume.backendSessionId) return;
    this.notices.observe(t('notify.backendSessionReset'), undefined, 'warning');
  }

  /**
   * The attempt's whole stream ended: the run is over. The terminal tally reads the ACCUMULATED
   * result (background phase folded in), not the last event and not the foreground turn — a run
   * with several continuations reports the whole run, and a chain reports its final attempt.
   */
  private onAttemptSettled(result: RunResult): void {
    if (this.terminal) return;
    this.absorbResultCounts(result);
    this.finishTerminal(result.rateLimited ? 'rate-limited' : 'completed', result);
  }

  /**
   * Take the live attempt's backend session id while the run still has none.
   *
   * The id is read once when the attempt registers, which is all Claude needs (it mints
   * `--session-id` at spawn). PI names itself when its runtime handle finishes starting — a tick
   * later — and normally says so with `engine_started`; a session that was already up when the turn
   * opened has no announcement left to make. Reading the attempt on each event closes that gap, so
   * a mid-turn reader (the resume-target sink) sees the id without waiting for the turn to settle.
   */
  private refreshBackendSessionId(): void {
    if (this.backendSessionIdValue) return;
    this.adoptBackendSessionId(this.current?.backendSessionId);
  }

  private absorb(event: RunEvent): void {
    if (this.terminal) return;
    switch (event.type) {
      case 'engine_started':
        this.adoptBackendSessionId(event.backendSessionId);
        break;
      case 'turn_progress':
        this.setNumTurns(event.numTurns);
        break;
      case 'background_result':
        this.absorbContinuation(event.result);
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
    this.adoptBackendSessionId(result.sessionId);
  }

  /** A continuation reports its own turns and cost, not the run's: add it to the tally the way the
   *  engine does (`mergeContinuation`). An interrupted continuation adds nothing, as there. */
  private absorbContinuation(result: RunResult): void {
    if (result.backgroundInterrupted) return;
    this.continuations.push(result);
    const tally = this.tally();
    if (tally) this.absorbResultCounts(tally);
  }

  /** The foreground turn plus every continuation so far; null before the foreground settled. A
   *  continuation can reach the stream before the foreground await resumes, so the fold is taken
   *  over the whole list rather than kept incrementally. */
  private tally(): RunResult | null {
    if (!this.foregroundResult) return null;
    return this.continuations.reduce(mergeContinuation, this.foregroundResult);
  }

  // ── terminal transitions ───────────────────────────────────────────────

  private onForegroundResult(result: RunResult): void {
    if (this.terminal) return;
    this.foregroundResult = result;
    this.absorbResultCounts(this.tally() ?? result);
    this.resultDeferred.resolve(result);
    this.fanOut({ type: 'foreground_result', result });
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
    // `cancelRequested` only covers a cancel that came through this object. A kill that did not
    // (the pool retiring the engine, a held session's Stop killing the pooled process) makes the
    // engine reject with a `cancelled` error; the run treats exactly that flag as a cancel —
    // otherwise a user pressing Stop gets an error card and a 'failed' execution.
    if (this.cancelRequested || (failure as { cancelled?: boolean }).cancelled === true) {
      this.finishTerminal('cancelled', null, failure);
      return;
    }
    this.fanOut({ type: 'error', message: failure.message, fatal: true });
    this.finishTerminal('failed', null, failure);
  }

  private finishTerminal(status: TerminalRunStatus, result: RunResult | null, error?: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.statusValue = status;
    this.phaseValue = 'done';
    this.fanOut({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
    const durationS = (Date.now() - this.startedAt) / 1000;
    const terminalResult = result ?? this.tally();
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
          void (pending as Promise<void>).catch((error) => this.onObserverError(error));
        }
      } catch (error) {
        this.onObserverError(error);
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
          void (pending as Promise<void>).catch((error) => this.onObserverError(error));
        }
      } catch (error) {
        this.onObserverError(error);
      }
    }
  }

  private onObserverError(error: unknown): void {
    log.warn('run observer failed:', asError(error).message);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
