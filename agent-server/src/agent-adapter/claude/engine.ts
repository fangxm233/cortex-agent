import type { AgentResult } from '@core/types/agent-types.js';
import { CAPABILITIES_BY_BACKEND, type Capability } from '../capabilities.js';
import { ContinuationPhase, type AwaitBackground } from '../continuation-phase.js';
import { RunEventQueue, toRunEvent, type RunEvent } from '../run-events.js';
import type { EngineRunOptions } from '../types.js';
import { createEventStream } from '../normalize/event-stream.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import type {
  AgentCompactResult, AgentProcessSupervision, Backend, BackgroundTurnSink,
  EngineRun, EngineSession, EngineSpec, InjectionAckSink, UserMessage,
} from '../types.js';
import {
  claudeTurnCallbacks,
  pushDerivedTurnEvents,
  type ClaudeTurnAccountingSource,
  type ClaudeTurnCallbacks,
} from './event-translator.js';

/**
 * Hooks the owning pool injects when it opens a session. Optional so a bare `open()` used by
 * tests and other callers can construct an engine without an owner.
 */
export interface ClaudeEngineOpenHooks {
  /** Forwarded to `ClaudeSession`: the session terminated itself (child close, idle timeout).
   *  The owner evicts only while the key still points at the session that closed. */
  onSelfClose?: (sessionKey: string, session: unknown) => void;
  /** Forwarded to `ClaudeSession`: a fatal stdin write failure left the session unusable. The
   *  owner must evict unconditionally, even if the pool has already moved on to a replacement. */
  onEvict?: (sessionKey: string, session: unknown) => void;
}

/**
 * The subset of `ClaudeSession` this engine drives, declared structurally so `adapter.ts` does not
 * have to widen its public surface by exporting the class. `ClaudeSession` satisfies it exactly.
 */
export interface ClaudeEngineSessionHost extends ClaudeTurnAccountingSource {
  readonly sessionId: string;
  sendMessage(text: string, options: ClaudeTurnCallbacks): Promise<AgentResult>;
  injectUserMessage(message: UserMessage): boolean;
  setInjectionAckSink(sink: InjectionAckSink): void;
  setBackgroundTurnSink(sink: BackgroundTurnSink): void;
  getSupervision(): AgentProcessSupervision | undefined;
  compact(): Promise<AgentCompactResult>;
  /** `ClaudeSession.close()` is synchronous (stdin end + grace timer); the engine wraps it. */
  close(): void;
  kill(): boolean;
  isAlive(): boolean;
}

/** One injection Cortex accepted into the current run, awaiting Claude's delivery/refusal ack. */
interface PendingInjection {
  id: string;
  text: string;
}

/** The pending injection whose text matches, removed FIFO; undefined for an unmatched ack.
 *  Same pattern as `pi/engine.ts:takePending`. */
function takePending(pending: PendingInjection[], text: string): PendingInjection | undefined {
  const index = pending.findIndex((entry) => entry.text === text);
  if (index === -1) return undefined;
  return pending.splice(index, 1)[0];
}

/**
 * Claude's `EngineSession`. `run()` opens a RunEvent stream over a pooled `ClaudeSession`; the
 * turn's normalized events arrive through the callback bag
 * (`claudeTurnCallbacks`), the derived accounting through `pushDerivedTurnEvents`, and the run adds
 * only the `session_started` and terminating `phase` bookkeeping. `cancel()` ends a run's stream,
 * never the pooled session.
 */
export class ClaudeEngineSession implements EngineSession {
  readonly backend: Backend = 'claude';
  /** The pool's reuse key. Claude compares compatibility structurally; this string serializes that
   *  exact predicate (`claudeCompatibilityIdentity`) so SessionEngines can compare plain strings. */
  readonly identity: string;
  readonly capabilities: ReadonlySet<Capability>;
  private readonly session: ClaudeEngineSessionHost;
  private readonly spec: EngineSpec;
  /** The run currently owning the session's single injection-ack slot (Claude serves one turn at a
   *  time). `steer()` targets it for id correlation and immediate refusals. */
  private active: { queue: RunEventQueue; pending: PendingInjection[]; phase: ContinuationPhase | null } | null = null;
  private injectionSeq = 0;
  /** Only the first run of a session emits `session_started`, matching `spawn()`'s `started` flag. */
  private started = false;
  /** What this run asked for. The background phase it selects is carried by `ContinuationPhase`,
   *  which the engine installs the moment the run begins. */
  private lastAwaitBackground: AwaitBackground = 'none';

  /** `identity` is passed in rather than computed here: it is derived from `adapter.ts`'s private
   *  `compatibilityFromOptions`, and importing that back would make `adapter.ts` ↔ `engine.ts` a
   *  runtime cycle. `ClaudeAdapter.open()` is the only constructor caller and supplies it. */
  constructor(session: ClaudeEngineSessionHost, spec: EngineSpec, identity: string) {
    this.session = session;
    this.spec = spec;
    this.identity = identity;
    // D9 declares capabilities per EngineSession. Claude's set happens to be backend-wide today (no
    // per-session narrowing exists), so this is a copy rather than a lookup: a future per-session
    // gate can mutate it without touching the shared matrix.
    this.capabilities = new Set(CAPABILITIES_BY_BACKEND.claude);
  }

  get backendSessionId(): string | null {
    return this.session.sessionId;
  }

  run(prompt: UserMessage, opts: EngineRunOptions): EngineRun {
    const queue = new RunEventQueue();
    const pending: PendingInjection[] = [];
    const active = { queue, pending, phase: null as ContinuationPhase | null };
    this.active = active;
    // The ack sink is a single session-level slot. The engine is pooled, but the underlying
    // ClaudeSession still serves one run at a time, so the run that installs the sink owns it.
    // Acks travel through the phase rather than straight to the queue: they release the obligation
    // an accepted injection creates (see ContinuationPhase.noteInjectionAccepted).
    this.session.setInjectionAckSink({
      onDelivered: ({ text, foldedIntoTurn }) => {
        const entry = takePending(pending, text);
        const event = {
          type: 'injection_delivered', injectionId: entry?.id ?? this.nextInjectionId(), foldedIntoTurn,
        } as const;
        if (active.phase) active.phase.ingest(event);
        else queue.push(event);
      },
      onUndelivered: ({ text }) => {
        const entry = takePending(pending, text);
        const event = {
          type: 'injection_rejected', injectionId: entry?.id ?? this.nextInjectionId(), reason: 'undelivered',
        } as const;
        if (active.phase) active.phase.ingest(event);
        else queue.push(event);
      },
    });
    this.lastAwaitBackground = opts.awaitBackground;
    if (!this.started) {
      // Claude has no turn-stream `session_started`; synthesize it exactly as `spawn().send()` does.
      queue.push(toRunEvent({ type: 'session_started', sessionId: this.session.sessionId }, 'foreground'));
      this.started = true;
    }

    const deferred = deferredResult();
    const settled = deferredResult();
    // The run's background phase. The sink goes in BEFORE the foreground result can land: Claude
    // fires a background task's continuation the moment that result does, and a sink installed any
    // later would drop it. The phase also decides when the run is over — see continuation-phase.ts.
    const phase = new ContinuationPhase(opts.awaitBackground, {
      push: (event) => queue.push(event),
      settleForeground: (result) => deferred.resolve(result),
      settleRun: (result) => { settled.resolve(result); deferred.resolve(result); },
      reject: (error) => { deferred.reject(error); settled.reject(error); },
      close: () => queue.close(),
    });
    active.phase = phase;
    this.session.setBackgroundTurnSink(phase.sink());

    // `turn_complete` is the callback stream's terminal marker, not a result: the engine pushes the
    // authoritative `foreground_result` itself once the turn resolves, and translating the marker
    // too would emit a second, lossy result event for the same turn.
    const push = (event: NormalizedEvent) => {
      opts.onNormalizedEvent?.(event);
      if (event.type !== 'turn_complete') queue.push(toRunEvent(event, 'foreground'));
    };
    void this.driveRun(prompt, push, queue, phase, deferred);
    // A failed foreground turn fails the WHOLE run: `settled` has to carry the same rejection, or a
    // terminal tally awaiting it hangs instead of reporting the failure.
    deferred.promise.catch((error) => settled.reject(error));
    // The caller observes rejection through `EngineRun.result`; this only prevents an unhandled
    // rejection when a consumer reads `events` without awaiting `result`. `settled` needs the same
    // guard for the same reason: a caller that only awaits the foreground turn (or abandons a
    // retried attempt) must not turn a failure into an unhandled rejection.
    deferred.promise.catch(() => undefined);
    settled.promise.catch(() => undefined);

    return {
      events: {
        [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => ({ next: () => queue.next() }),
      },
      result: deferred.promise,
      settled: settled.promise,
      // Ends this run, not the session: a run's cancel closes its stream and deliberately not the
      // pooled session, which serves the next run. Session teardown goes through
      // SessionEngines.close(key) / kill(key).
      cancel: () => queue.close(),
    };
  }

  /** One run: the foreground turn, then the background phase it leaves behind. */
  private async driveRun(
    prompt: UserMessage,
    push: (event: NormalizedEvent) => void,
    queue: RunEventQueue,
    phase: ContinuationPhase,
    deferred: { resolve: (r: AgentResult) => void; reject: (e: unknown) => void },
  ): Promise<void> {
    let base: AgentResult;
    try {
      base = await this.session.sendMessage(prompt.text, {
        attachments: prompt.attachments,
        ...claudeTurnCallbacks(push),
      });
      pushDerivedTurnEvents(
        push, base, this.session, this.spec.flags.preserveUnreportedAccounting === true,
      );
    } catch (err: any) {
      // Same suppression as `spawn().send()`: a cancelled turn is not an error worth surfacing.
      if (!err?.cancelled) {
        push({ type: 'error', message: String(err?.message ?? err), fatal: true });
      }
      queue.push({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
      queue.close();
      deferred.reject(err);
      return;
    }
    // The authoritative result, pushed once — `turn_complete` was filtered out of `push` above, so
    // this is the only result event a consumer sees for this turn.
    queue.push({ type: 'foreground_result', result: base });
    phase.start(base);
  }

  steer(msg: UserMessage, callerInjectionId?: string): { accepted: boolean; injectionId?: string } {
    const injectionId = callerInjectionId ?? this.nextInjectionId();
    const accepted = this.session.injectUserMessage(msg);
    if (accepted) this.active?.phase?.noteInjectionAccepted();
    if (!accepted) {
      // A refused injection never reaches Claude's ack queue, so surface the rejection from here.
      this.active?.queue.push({ type: 'injection_rejected', injectionId, reason: 'refused' });
      return { accepted: false, injectionId };
    }
    this.active?.pending.push({ id: injectionId, text: msg.text });
    return { accepted: true, injectionId };
  }

  /** Push an out-of-band event into the live run's stream (a native subagent's rows, which keep
   *  arriving after the parent turn closed). False when no run is consuming events. */
  ingestExternal(event: RunEvent): boolean {
    const queue = this.active?.queue;
    if (!queue) return false;
    queue.push(event);
    return true;
  }

  /** Claude exposes no extension-UI response channel (`AgentRun.respondToDialog` returns false for
   *  the same reason); do not invent one. */
  respondToDialog(_dialogId: string, _payload: Record<string, unknown>): boolean {
    return false;
  }

  compact(): Promise<AgentCompactResult> {
    return this.session.compact();
  }

  async close(): Promise<void> {
    this.session.close();
  }

  kill(): boolean {
    return this.session.kill();
  }

  /** The pool's liveness test: a session that self-terminated must not be reused. */
  isAlive(): boolean {
    return this.session.isAlive();
  }

  private nextInjectionId(): string {
    return `claude-run-inj-${++this.injectionSeq}`;
  }
}

function deferredResult(): { promise: Promise<AgentResult>; resolve: (r: AgentResult) => void; reject: (e: unknown) => void } {
  let resolve!: (r: AgentResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<AgentResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
