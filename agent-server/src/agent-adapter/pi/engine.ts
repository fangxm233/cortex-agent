// input:  PISession, resolved PiSessionRequest, PI normalized events
// output: PIEngineSession: EngineSession over one PISession plus its RunEvent queue
// pos:    PI backend's run-oriented surface, additive beside the pooled PIAdapter.spawn() path
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AgentResult } from '@core/types/agent-types.js';
import { CAPABILITIES_BY_BACKEND, type Capability } from '../capabilities.js';
import { toRunEvent, type RunEvent } from '../run-events.js';
import type {
  AgentCompactResult, Backend, EngineRun, EngineSession, UserMessage,
} from '../types.js';
import { turnStreamIterable, type PISession } from './pi-session.js';
import { sessionIdentity, type PiSessionRequest } from './session-options.js';

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One injection Cortex accepted into the current run, awaiting PI's delivery/refusal ack. */
interface PendingInjection {
  id: string;
  text: string;
}

/**
 * A FIFO queue of `RunEvent`s. `PISession` hands its normalized events to the run through an
 * `EventQueue`; injection acks arrive out of band through `setInjectionAckSink`, so the engine
 * multiplexes both onto this one RunEvent stream. Mirrors `session-support.EventQueue` so a run's
 * consumer sees a normal async iterable that ends at `phase: done`.
 */
class RunEventQueue {
  private readonly pending: RunEvent[] = [];
  private readonly waiters: ((result: IteratorResult<RunEvent>) => void)[] = [];
  private closed = false;

  push(event: RunEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.pending.push(event);
  }

  next(): Promise<IteratorResult<RunEvent>> {
    const buffered = this.pending.shift();
    if (buffered) return Promise.resolve({ value: buffered, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

/** The pending injection whose text matches, removed FIFO; undefined for an unmatched ack. */
function takePending(pending: PendingInjection[], text: string): PendingInjection | undefined {
  const index = pending.findIndex((entry) => entry.text === text);
  if (index === -1) return undefined;
  return pending.splice(index, 1)[0];
}

/**
 * PI's `EngineSession`. It delegates to the same `PISession` the pooled `spawn()` path uses, so the
 * two surfaces observe identical turn behaviour: `run()` opens the turn stream and dispatches the
 * prompt exactly as `PIAdapter.createAgentProcess` / `sendSpawnedTurn` do, and `cancel()` ends the
 * run through `closeTurnStreamFor`, never the pooled session.
 */
export class PIEngineSession implements EngineSession {
  readonly backend: Backend = 'pi';
  /** The pool's reuse key. PI derives it from the fully resolved request (`sessionIdentity`), which
   *  is strictly more precise than `engineIdentity(spec)` because it covers the resolved env, MCP
   *  servers and gateway routing too. SessionEngines (P2.2c) compares this exact string. */
  readonly identity: string;
  readonly capabilities: ReadonlySet<Capability>;
  private readonly session: PISession;
  /** The run currently owning the session's single injection-ack slot (PI serves one turn at a
   *  time). `steer()` targets it for id correlation and immediate refusals. */
  private active: { queue: RunEventQueue; pending: PendingInjection[] } | null = null;
  private injectionSeq = 0;
  /** Recorded for diagnostics; PI has no background phase yet, so it never changes run behaviour. */
  private lastAwaitBackground: 'none' | 'inline' | 'hold' = 'none';

  constructor(session: PISession, request: PiSessionRequest) {
    this.session = session;
    this.identity = sessionIdentity(request);
    // D9 declares capabilities per EngineSession. PI's set happens to be backend-wide today (no
    // per-session narrowing exists), so this is a copy rather than a lookup: a future per-session
    // gate can mutate it without touching the shared matrix.
    this.capabilities = new Set(CAPABILITIES_BY_BACKEND.pi);
  }

  get backendSessionId(): string | null {
    return this.session.sessionId;
  }

  run(prompt: UserMessage, opts: { awaitBackground: 'none' | 'inline' | 'hold' }): EngineRun {
    const stream = this.session.openTurnStream();
    const queue = new RunEventQueue();
    const pending: PendingInjection[] = [];
    this.active = { queue, pending };
    // The ack sink is session-scoped; PI serves one turn at a time, so the live run owns it.
    this.session.setInjectionAckSink({
      onDelivered: ({ text, foldedIntoTurn }) => {
        const entry = takePending(pending, text);
        queue.push({
          type: 'injection_delivered',
          injectionId: entry?.id ?? this.nextInjectionId(),
          foldedIntoTurn,
        });
      },
      onUndelivered: ({ text }) => {
        const entry = takePending(pending, text);
        queue.push({
          type: 'injection_rejected',
          injectionId: entry?.id ?? this.nextInjectionId(),
          reason: 'undelivered',
        });
      },
    });
    // Accepted and recorded, but changes nothing: PI has no spontaneous continuation turns, so
    // every run is foreground-only and ends after its `turn_complete` (D1).
    this.lastAwaitBackground = opts.awaitBackground;

    const result = this.sendTurn(prompt);
    // The caller observes rejection through `EngineRun.result`; this only prevents an unhandled
    // rejection when a consumer reads `events` without awaiting `result`.
    result.catch(() => undefined);

    void (async () => {
      for await (const event of turnStreamIterable(stream)) {
        queue.push(toRunEvent(event, 'foreground'));
      }
      queue.push({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
      queue.close();
    })();

    return {
      events: {
        [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => ({ next: () => queue.next() }),
      },
      result,
      // Ends this run, not the session: the session stays pooled and serves the next run.
      cancel: () => { this.session.closeTurnStreamFor(stream); },
    };
  }

  /** The same promise shape `PIAdapter.sendSpawnedTurn` builds. A fresh/reused `PISession` serves
   *  its own transcript (`currentSessionId === sessionId`), so no resume switch is needed here. */
  private sendTurn(message: UserMessage): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      this.session.beginTurn(resolve, reject);
      this.session.sendTurn(this.session.sessionId, this.session.sessionFile, message)
        .catch((error) => this.session.beginTurnReject(errorValue(error)));
    });
  }

  steer(msg: UserMessage): { accepted: boolean; injectionId?: string } {
    const injectionId = this.nextInjectionId();
    const accepted = this.session.injectUserMessage(msg);
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

  compact(): Promise<AgentCompactResult> {
    return this.session.compact();
  }

  close(): Promise<void> {
    return this.session.close();
  }

  kill(): boolean {
    return this.session.kill();
  }

  private nextInjectionId(): string {
    return `pi-run-inj-${++this.injectionSeq}`;
  }
}
