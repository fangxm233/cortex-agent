// input:  ClaudeSession, resolved EngineSpec, Claude turn callbacks
// output: ClaudeEngineSession: EngineSession over one ClaudeSession plus its RunEvent queue
// pos:    Claude backend's session surface: RunEvent runs over one ClaudeSession
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { AgentResult } from '@core/types/agent-types.js';
import { CAPABILITIES_BY_BACKEND, type Capability } from '../capabilities.js';
import { ContinuationPhase, type AwaitBackground } from '../continuation-phase.js';
import { RunEventQueue, toRunEvent, type RunEvent } from '../run-events.js';
import type { EngineRunOptions } from '../types.js';
import { createEventStream } from '../normalize/event-stream.js';
import type { NormalizedEvent } from '../normalize/event-types.js';
import type {
  AgentCompactResult, AgentProcess, AgentProcessSupervision, Backend, ContinuationSink,
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
  setContinuationSink(sink: ContinuationSink): void;
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
 * Claude's `EngineSession`. `run()` opens a RunEvent stream over the same `ClaudeSession` the
 * legacy `spawn()` path drives; the turn's normalized events arrive through the callback bag
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
    this.session.setContinuationSink(phase.sink());

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
    // rejection when a consumer reads `events` without awaiting `result`.
    deferred.promise.catch(() => undefined);

    return {
      events: {
        [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => ({ next: () => queue.next() }),
      },
      result: deferred.promise,
      settled: settled.promise,
      // Ends this run, not the session: `spawn()`'s `AgentProcess.close()` does `stream.close()`
      // and deliberately not `session.close()`, so the pooled session serves the next run. Session
      // teardown goes through SessionEngines.close(key) / kill(key).
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

  /** The legacy AgentProcess surface over this same session, byte-identical to what
   *  ClaudeAdapter.spawn built: the facade's take on the pooled session. */
  openLegacyProcess(engineKey: string): AgentProcess {
    const session = this.session;
    const spec = this.spec;
    const stream = createEventStream<NormalizedEvent>();
    let started = false;

    return {
      sessionKey: engineKey,
      get sessionId(): string | null { return session.sessionId; },
      get supervision(): AgentProcessSupervision | undefined { return session.getSupervision(); },
      async send(message: UserMessage): Promise<AgentResult> {
        if (!started) {
          stream.push({ type: 'session_started', sessionId: session.sessionId });
          started = true;
        }
        try {
          const result = await session.sendMessage(message.text, {
            attachments: message.attachments,
            ...claudeTurnCallbacks(stream.push),
          });
          pushDerivedTurnEvents(stream.push, result, session, spec.flags.preserveUnreportedAccounting === true);
          stream.close();
          return result;
        } catch (err: any) {
          if (!err?.cancelled) {
            stream.push({ type: 'error', message: String(err?.message ?? err), fatal: true });
          }
          stream.close();                         // unblock any for-await consumer
          throw err;
        }
      },
      events: stream.iterable,
      compact: (): Promise<AgentCompactResult> => session.compact(),
      setContinuationSink(sink: ContinuationSink): void { session.setContinuationSink(sink); },
      injectUserMessage(message: UserMessage): boolean { return session.injectUserMessage(message); },
      setInjectionAckSink(sink: InjectionAckSink): void { session.setInjectionAckSink(sink); },
      // Out-of-band attribution (see AgentProcess.pushTurnEvent). The stream is closed the moment
      // send() settles, so "still open" is exactly "the turn is still running".
      pushTurnEvent(event: NormalizedEvent): boolean {
        if (stream.isClosed()) return false;
        stream.push(event);
        return true;
      },
      // Intentionally does NOT call session.close(): sessions are pooled per sessionKey and
      // reused across runAgentOnce turns. Pool-level cleanup goes through SessionEngines.close(key)
      // / kill(key).
      async close(): Promise<void> { stream.close(); },
      kill(): boolean { return session.kill(); },
    };
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
