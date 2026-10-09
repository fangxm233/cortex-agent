import type { AgentResult } from '@core/types/agent-types.js';
import type { ContinuationPhase } from './continuation-phase.js';
import type { RunEvent, RunEventQueue } from './run-events.js';
import type { InjectionAckSink, UserMessage } from './types.js';

// Mid-run injection, shared by the Claude and PI engines. Both backend sessions serve one run at a
// time and expose one session-level ack slot, so the run that starts last owns it: `steer()` and
// out-of-band rows target that run, and the backend's delivery acks are correlated back to the ids
// Cortex handed out.

/** What a backend session offers for injecting into its live run. */
export interface InjectableSession {
  injectUserMessage(message: UserMessage): boolean;
  setInjectionAckSink(sink: InjectionAckSink): void;
}

/** One injection Cortex accepted into the current run, awaiting the backend's delivery/refusal ack. */
interface PendingInjection {
  id: string;
  text: string;
}

/** The live run: where its events go, the injections awaiting an ack, and its background phase
 *  once the run has built one. */
interface ActiveRun {
  queue: RunEventQueue;
  pending: PendingInjection[];
  phase: ContinuationPhase | null;
}

/** The handle `beginRun` gives the engine for the run it just started. */
export interface InjectionRun {
  /** Route this run's acks through its phase from now on. Acks release the obligation an accepted
   *  injection creates (see `ContinuationPhase.noteInjectionAccepted`), so once the phase exists it
   *  must see them; before that they go straight to the run's queue. */
  attachPhase(phase: ContinuationPhase): void;
}

/** The pending injection whose text matches, removed FIFO; undefined for an unmatched ack. */
function takePending(pending: PendingInjection[], text: string): PendingInjection | undefined {
  const index = pending.findIndex((entry) => entry.text === text);
  if (index === -1) return undefined;
  return pending.splice(index, 1)[0];
}

export class EngineInjections {
  private active: ActiveRun | null = null;
  private seq = 0;

  /** `idPrefix` names the injection ids this engine mints, e.g. `claude-run-inj`. */
  constructor(private readonly session: InjectableSession, private readonly idPrefix: string) {}

  /** Make `queue` the live run's and install the session's ack sink for it. The previous run's
   *  background phase is handed off first: once its sinks belong to the new run it can never be
   *  fed again, and left open it would keep its execution registered (and its session busy). */
  beginRun(queue: RunEventQueue): InjectionRun {
    this.active?.phase?.handOff();
    const run: ActiveRun = { queue, pending: [], phase: null };
    this.active = run;
    this.session.setInjectionAckSink(this.ackSink(run));
    return { attachPhase: (phase) => { run.phase = phase; } };
  }

  /** Inject `msg` into the live run. A refusal never reaches the backend's ack queue, so it is
   *  surfaced on the run's stream from here. */
  steer(msg: UserMessage, callerInjectionId?: string): { accepted: boolean; injectionId?: string } {
    const injectionId = callerInjectionId ?? this.nextId();
    const accepted = this.session.injectUserMessage(msg);
    if (accepted) this.active?.phase?.noteInjectionAccepted();
    if (!accepted) {
      this.active?.queue.push({ type: 'injection_rejected', injectionId, reason: 'refused' });
      return { accepted: false, injectionId };
    }
    this.active?.pending.push({ id: injectionId, text: msg.text });
    return { accepted: true, injectionId };
  }

  /** Push an out-of-band event into the live run's stream. False when no run is consuming events. */
  pushOutOfBand(event: RunEvent): boolean {
    const queue = this.active?.queue;
    if (!queue) return false;
    queue.push(event);
    return true;
  }

  private ackSink(run: ActiveRun): InjectionAckSink {
    const deliver = (event: RunEvent): void => {
      if (run.phase) run.phase.ingest(event);
      else run.queue.push(event);
    };
    return {
      onDelivered: ({ text, foldedIntoTurn }) => deliver({
        type: 'injection_delivered', injectionId: this.ackedId(run, text), foldedIntoTurn,
      }),
      onUndelivered: ({ text }) => deliver({
        type: 'injection_rejected', injectionId: this.ackedId(run, text), reason: 'undelivered',
      }),
    };
  }

  /** The id an ack belongs to; an ack for text Cortex never injected gets a fresh one. */
  private ackedId(run: ActiveRun, text: string): string {
    return takePending(run.pending, text)?.id ?? this.nextId();
  }

  private nextId(): string {
    return `${this.idPrefix}-${++this.seq}`;
  }
}

export interface DeferredResult {
  promise: Promise<AgentResult>;
  resolve: (r: AgentResult) => void;
  reject: (e: unknown) => void;
}

/** A result promise with its settle functions handed out, for runs that settle from callbacks. */
export function deferredResult(): DeferredResult {
  let resolve!: (r: AgentResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<AgentResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
