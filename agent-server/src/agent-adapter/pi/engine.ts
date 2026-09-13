// input:  PISession, resolved PiSessionRequest, PI normalized events
// output: PIEngineSession: EngineSession over one PISession plus its RunEvent queue
// pos:    PI backend's session surface: RunEvent runs plus the transitional legacy AgentProcess
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AgentResult } from '@core/types/agent-types.js';
import { CAPABILITIES_BY_BACKEND, type Capability } from '../capabilities.js';
import { ContinuationPhase, type AwaitBackground } from '../continuation-phase.js';
import type { EngineRunOptions } from '../types.js';
import { RunEventQueue, toRunEvent, type RunEvent } from '../run-events.js';
import type {
  AgentCompactResult, Backend, EngineRun, EngineSession, UserMessage,
} from '../types.js';
import { turnStreamIterable, type PISession } from './pi-session.js';
import { sessionIdentity, type PiSessionRequest } from './session-options.js';
import type { EventQueue, PIAgentProcess, SwitchResult } from './session-support.js';

/** Hooks the owning pool injects when it opens a session. Optional so a bare `open()` used by
 *  tests and other callers can construct an engine without an owner. */
export interface PIEngineOpenHooks {
  /** Forwarded to `PISession.onClose`: the session terminated itself (start failure, idle timeout). */
  onSelfClose?: (sessionKey: string, session: unknown) => void;
  /** The pool evicts this engine after a successful `kill()` (the legacy AgentProcess path). */
  onEvict?: (session: PIEngineSession) => void;
  /** Registry + disk lookup the legacy spawn path uses to resolve the transcript to send into. */
  resolveSessionPath?: (sessionId: string) => string | null;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One injection Cortex accepted into the current run, awaiting PI's delivery/refusal ack. */
interface PendingInjection {
  id: string;
  text: string;
}

/** The pending injection whose text matches, removed FIFO; undefined for an unmatched ack. */
function takePending(pending: PendingInjection[], text: string): PendingInjection | undefined {
  const index = pending.findIndex((entry) => entry.text === text);
  if (index === -1) return undefined;
  return pending.splice(index, 1)[0];
}

/**
 * PI's `EngineSession`. `run()` opens a RunEvent stream over the same `PISession`, while
 * `openLegacyProcess()` exposes the byte-identical `AgentProcess` surface the pool used
 * (`createAgentProcess` / `sendSpawnedTurn` moved here verbatim); `cancel()` ends a run through
 * `closeTurnStreamFor`, never the pooled session.
 */
export class PIEngineSession implements EngineSession {
  readonly backend: Backend = 'pi';
  /** The pool's reuse key. PI derives it from the fully resolved request (`sessionIdentity`), which
   *  is strictly more precise than `engineIdentity(spec)` because it covers the resolved env, MCP
   *  servers and gateway routing too. SessionEngines compares this exact string. */
  readonly identity: string;
  readonly capabilities: ReadonlySet<Capability>;
  private readonly session: PISession;
  private readonly onEvict: ((session: PIEngineSession) => void) | undefined;
  private readonly resolveSessionPath: ((sessionId: string) => string | null) | undefined;
  /** The run currently owning the session's single injection-ack slot (PI serves one turn at a
   *  time). `steer()` targets it for id correlation and immediate refusals. */
  private active: { queue: RunEventQueue; pending: PendingInjection[]; phase: ContinuationPhase | null } | null = null;
  private injectionSeq = 0;
  /** Recorded for diagnostics. PI has no spontaneous continuation turns, so every run takes the
   *  `none` path through `ContinuationPhase` and ends at its own foreground result. */
  private lastAwaitBackground: AwaitBackground = 'none';

  constructor(
    session: PISession,
    request: PiSessionRequest,
    hooks: Pick<PIEngineOpenHooks, 'onEvict' | 'resolveSessionPath'> = {},
  ) {
    this.session = session;
    this.identity = sessionIdentity(request);
    this.onEvict = hooks.onEvict;
    this.resolveSessionPath = hooks.resolveSessionPath;
    // D9 declares capabilities per EngineSession. PI's set happens to be backend-wide today (no
    // per-session narrowing exists), so this is a copy rather than a lookup: a future per-session
    // gate can mutate it without touching the shared matrix.
    this.capabilities = new Set(CAPABILITIES_BY_BACKEND.pi);
  }

  get backendSessionId(): string | null {
    return this.session.sessionId;
  }

  run(prompt: UserMessage, opts: EngineRunOptions): EngineRun {
    const stream = this.session.openTurnStream();
    const queue = new RunEventQueue();
    const pending: PendingInjection[] = [];
    const active = { queue, pending, phase: null as ContinuationPhase | null };
    this.active = active;
    // The ack sink is session-scoped; PI serves one turn at a time, so the live run owns it.
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
    // Accepted and recorded, but changes nothing: PI has no spontaneous continuation turns, so
    // every run is foreground-only and ends after its `turn_complete` (D1).
    this.lastAwaitBackground = opts.awaitBackground;

    const result = this.sendTurn(prompt);
    // The caller observes rejection through `EngineRun.result`; this only prevents an unhandled
    // rejection when a consumer reads `events` without awaiting `result`.
    result.catch(() => undefined);

    const deferred = deferredResult();
    const settled = deferredResult();
    // PI has no spontaneous continuation turn, so the run's background phase is a formality: the
    // phase settles with the foreground result and closes the stream. It is still the phase that
    // decides, so both engines have ONE definition of when a run ends.
    const phase = new ContinuationPhase(opts.awaitBackground, {
      push: (event) => queue.push(event),
      settleForeground: (result_) => deferred.resolve(result_),
      settleRun: (result_) => { settled.resolve(result_); deferred.resolve(result_); },
      reject: (error) => { deferred.reject(error); settled.reject(error); },
      close: () => queue.close(),
    });
    active.phase = phase;
    // A failed foreground turn fails the WHOLE run: `settled` has to carry the same rejection, or a
    // terminal tally awaiting it hangs instead of reporting the failure.
    deferred.promise.catch((error) => settled.reject(error));
    // PI's turn events arrive on a stream of their own while the turn promise settles beside it,
    // so the two ends can land in either order. The run's stream may only be closed once the
    // turn's events have all been forwarded — otherwise a phase that seals early would drop the
    // tail of its own turn. Both completions therefore meet on this gate.
    let drained = false;
    let waiting: (() => void)[] = [];
    const whenDrained = (fn: () => void): void => { if (drained) fn(); else waiting.push(fn); };
    const markDrained = (): void => { drained = true; const fns = waiting; waiting = []; for (const fn of fns) fn(); };

    let turnSettled = false;
    void result.then(
      (base) => {
        turnSettled = true;
        whenDrained(() => {
          queue.push({ type: 'foreground_result', result: base });
          phase.start(base);
        });
      },
      (error) => {
        turnSettled = true;
        whenDrained(() => {
          queue.push({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
          queue.close();
        });
        deferred.reject(error);
      },
    );
    void (async () => {
      for await (const event of turnStreamIterable(stream)) {
        // `turn_complete` is the stream's terminal MARKER, not a result: `toRunEvent` would turn it
        // into a second, lossy `foreground_result` beside the authoritative one pushed below.
        opts.onNormalizedEvent?.(event);
        if (event.type === 'turn_complete') continue;
        queue.push(toRunEvent(event, 'foreground'));
      }
      markDrained();
      // The stream ended without a result yet: the caller cancelled this run. Give a result that
      // settles in the same turn one microtask to land, then seal; the pooled session lives on and
      // `result` stays with its awaiter.
      await Promise.resolve();
      if (!turnSettled) {
        queue.push({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
        queue.close();
      }
    })();
    deferred.promise.catch(() => undefined);

    return {
      events: {
        [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => ({ next: () => queue.next() }),
      },
      result: deferred.promise,
      settled: settled.promise,
      // Ends this run, not the session: the session stays pooled and serves the next run.
      cancel: () => { this.session.closeTurnStreamFor(stream); },
    };
  }

  /** The same promise shape `PIAdapter.sendSpawnedTurn` builds. A fresh/reused `PISession` serves
   *  its own transcript (`currentSessionId === sessionId`), so no resume switch is needed here. */
  private sendTurn(message: UserMessage): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      this.session.beginTurn(resolve, reject);
      this.session.sendTurn(this.session.sessionId, this.turnPath(), message)
        .catch((error) => this.session.beginTurnReject(errorValue(error)));
    });
  }

  /**
   * The transcript file this turn resumes, preferring the one that exists on disk.
   *
   * `PISession.sessionFile` is whatever the session was announced with — for a session whose
   * registry entry was synthesized (`<sessionId>.jsonl`) that file never appeared, and PI wrote a
   * timestamped one instead. A turn that comes back to it after an internal switch therefore has
   * to re-resolve the path, or it hands PI a switch target that does not exist. `sendSpawnedTurn`
   * did this per turn; the engine has to as well.
   */
  private turnPath(): string | null {
    const targetId = this.session.sessionId;
    if (targetId === null) return null;
    return this.resolveSessionPath?.(targetId) ?? this.session.sessionFile;
  }

  steer(msg: UserMessage, callerInjectionId?: string): { accepted: boolean; injectionId?: string } {
    const injectionId = callerInjectionId ?? this.nextInjectionId();
    const accepted = this.session.injectUserMessage(msg);
    if (accepted) this.active?.phase?.noteInjectionAccepted();
    if (!accepted) {
      // A refused injection never reaches PI's ack queue, so surface the rejection from here.
      this.active?.queue.push({ type: 'injection_rejected', injectionId, reason: 'refused' });
      return { accepted: false, injectionId };
    }
    this.active?.pending.push({ id: injectionId, text: msg.text });
    return { accepted: true, injectionId };
  }

  respondToDialog(dialogId: string, payload: Record<string, unknown>): boolean {
    return this.session.sendExtensionUiResponse(dialogId, payload);
  }

  /** Push an out-of-band event into the live run's stream. PI hosts its subagents in-process and
   *  never delivers rows for a turn that has already closed, so this is a formality for the
   *  contract's sake — it still must not pretend to have a consumer it does not have. */
  ingestExternal(event: RunEvent): boolean {
    const queue = this.active?.queue;
    if (!queue) return false;
    queue.push(event);
    return true;
  }

  compact(): Promise<AgentCompactResult> {
    return this.session.compact();
  }

  close(): Promise<void> {
    return this.session.close();
  }

  kill(): boolean {
    const killed = this.session.kill();
    if (killed) this.onEvict?.(this);
    return killed;
  }

  /** The pool's liveness test: a session that self-terminated must not be reused. */
  isAlive(): boolean {
    return this.session.isAlive();
  }

  /** Re-point the pooled runtime at another transcript (session rewind). Mutates the same
   *  `currentSessionId` the legacy send path reads, exactly as `PIAdapter.switchSession` did. */
  async switchSession(sessionId: string, targetPath: string): Promise<SwitchResult> {
    const result = await this.session.sendSwitchSession(targetPath);
    if (result.ok) this.session.currentSessionId = sessionId;
    return result;
  }

  /** The legacy AgentProcess surface over this same session, byte-identical to what
   *  PIAdapter.createAgentProcess built: the facade's take on the pooled session. */
  openLegacyProcess(engineKey: string): PIAgentProcess {
    return this.createLegacyProcess(engineKey, this.session.openTurnStream());
  }

  private sendSpawnedTurn(session: PISession, msg: UserMessage): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      session.beginTurn(resolve, reject);
      const targetId = session.sessionId;
      const targetPath = targetId === null ? null : this.resolveSessionPath?.(targetId) ?? null;
      session.sendTurn(targetId, targetPath, msg)
        .catch((error) => session.beginTurnReject(errorValue(error)));
    });
  }

  private createLegacyProcess(engineKey: string, turnStream: EventQueue): PIAgentProcess {
    const session = this.session;
    return {
      sessionKey: engineKey,
      get sessionId(): string | null { return session.sessionId; },
      send: (msg) => this.sendSpawnedTurn(session, msg),
      compact: () => session.compact(),
      sendExtensionUiResponse: (id, payload) => session.sendExtensionUiResponse(id, payload),
      injectUserMessage: (msg) => session.injectUserMessage(msg),
      setInjectionAckSink: (sink) => session.setInjectionAckSink(sink),
      events: turnStreamIterable(turnStream),
      // Out-of-band attribution (see AgentProcess.pushTurnEvent). Bound to THIS run's queue, so a
      // late push from an abandoned run cannot leak into the turn that replaced it.
      pushTurnEvent: (event) => {
        if (turnStream.isClosed) return false;
        turnStream.push(event);
        return true;
      },
      // Ends this run, not the session: the session is pooled per engineKey and serves the next
      // turn. Session teardown goes through SessionEngines.close(key) / kill(key).
      close: async () => { session.closeTurnStreamFor(turnStream); },
      kill: () => this.kill(),
    };
  }

  private nextInjectionId(): string {
    return `pi-run-inj-${++this.injectionSeq}`;
  }
}

function deferredResult(): { promise: Promise<AgentResult>; resolve: (r: AgentResult) => void; reject: (e: unknown) => void } {
  let resolve!: (r: AgentResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<AgentResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
