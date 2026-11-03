// Mid-turn injection ledger. A backend write only queues an injected message; its delivery ack may
// fold into the current turn or open an otherwise-unobserved spontaneous turn. The ledger owns the
// durable two-phase persistence (persist pending → publish a provisional row → commit history+ledger
// exactly once) and consumes the run's `injection_delivered` / `injection_rejected` events plus
// background-phase continuation events.
//
// `AgentRun` installs the backend `InjectionAckSink` and owns the process's single
// `BackgroundTurnSink`; the ledger never touches either. It is only fed RunEvents. Continuation rows
// are written through a `createTranscriptSink` instance, the same writer every other row uses.

import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import type { TranscriptPosition } from '@core/types/transcript-anchor.js';
import type { PendingInjectionRecord } from '@store/pending-injection-repo.js';
import type { RunEvent } from '../domain/runs/events.js';
import type { RunObserver } from '../domain/runs/request.js';
import type { AgentRun } from '../domain/runs/run.js';
import type { publishSessionMessage } from './session-events.js';
import { createTranscriptSink, isBackgroundRowEvent, type TranscriptSinkDeps } from './transcript-sink.js';

const log = createLogger('injection-ledger');

/** Side-effect seams for the injection ledger, bound by `buildInjectDeps` in production. */
export interface InjectionLedgerDeps {
  /** Captured while the running turn still owns it, before a spontaneous turn starts. */
  getStreamingCallback: (channel: string) => ((text: string) => void) | null;
  /** Session record a continuation's context usage is stored on; without one it is not stored. */
  /** Publishes the provisional (pending) user row. */
  publishMessage: typeof publishSessionMessage;
  publishDelivered: (ev: {
    sessionId: string; channel: string; pendingId: string; messageTs: string; committedTs: string;
  }) => void;
  publishStatus: (ev: { sessionId: string; channel: string; running: boolean }) => void;
  persistPending: (record: PendingInjectionRecord) => Promise<void>;
  /** `position`: where the backend wrote the message in its transcript, when its ack said. */
  commitPending: (record: PendingInjectionRecord, position?: TranscriptPosition) => Promise<{ committedTs: string }>;
  /** Keep a message the model never read as unsent, for the user to resend or edit. False when its
   *  durable record is gone, which leaves committing it as the only way to keep it. */
  setAsideUnsent: (record: PendingInjectionRecord) => Promise<boolean>;
  publishUnsent: (ev: { sessionId: string; channel: string; pendingId: string; messageTs: string }) => void;
  markPending?: (record: PendingInjectionRecord) => Promise<void>;
  unmarkPending?: (record: PendingInjectionRecord) => Promise<void>;
  track: (delta: number) => void;
  now: () => string;
  captureDebug?: boolean;
  maxWaitMs?: number;
  /** Test seam for the continuation's transcript sink; production omits it. */
  transcript?: Partial<TranscriptSinkDeps>;
}

/** Leak guard: a wedged process must not hold the daemon restart gate forever. */
function defaultMaxWaitMs(): number {
  return getSettings().injectWaitMaxS * 1000;
}

/** The run an injection was steered into; it is also the key its ledger subscription is kept under.
 *  Absent in tests that drive the ledger without one. */
type InjectRun = Partial<Pick<AgentRun, 'backgroundTranscriptOwned' | 'status'>>;

/** An injected message written to the backend but not yet read by the model. */
interface PendingInjection {
  record: PendingInjectionRecord;
  run?: InjectRun;
  /** Write-time ts — the key the pending row is showing under on every connected client. */
  ts: string;
  /** Persisted + published gate. Early backend acks wait here so event order stays pending→delivered. */
  activate: () => void;
  /** Move it into the conversation record (history + ledger turn + the delivered event). Single-fire. */
  commit: () => Promise<boolean>;
  /** Where the backend wrote the message, set by its delivery ack before the commit. */
  position?: TranscriptPosition;
  mark: () => void;
  release: () => Promise<void>;
  /** The model never read it and never will: keep it as an unsent row instead of committing it. */
  unsend: () => Promise<void>;
  isReleased: () => boolean;
}

/** Per-channel bookkeeping for messages injected into the live turn but not yet replied to. */
interface ChannelInjectState {
  /** Injections the backend has not acked yet. */
  pending: PendingInjection[];
  /** Every injection still holding its busy gate on this channel, acked or not. */
  live: Set<PendingInjection>;
  /** True once the spontaneous turn has been marked running, so we publish that edge only once. */
  continuationRunning: boolean;
  /** One run-event subscription per run injected into, driving phase two while this channel has
   *  live injections. Keyed by run: a later turn on the channel runs on a new run whose acks an
   *  earlier run's subscription never sees. */
  subscriptions: Map<object, () => void>;
}

const channelStates = new Map<string, ChannelInjectState>();

function stateFor(channel: string): ChannelInjectState {
  let s = channelStates.get(channel);
  if (!s) {
    s = { pending: [], live: new Set(), continuationRunning: false, subscriptions: new Map() };
    channelStates.set(channel, s);
  }
  return s;
}

function disposeIfIdle(channel: string): void {
  const s = channelStates.get(channel);
  if (s && s.pending.length === 0 && s.live.size === 0) {
    for (const unsubscribe of s.subscriptions.values()) unsubscribe();
    channelStates.delete(channel);
  }
}

class PendingLifecycle implements PendingInjection {
  readonly ts: string;
  position?: TranscriptPosition;
  private activeResolve!: () => void;
  private readonly active: Promise<void>;
  private commitPromise: Promise<boolean> | null = null;
  private releasePromise: Promise<void> | null = null;
  private markerPromise: Promise<void> = Promise.resolve();
  private markerStarted = false;
  private markerCleared = false;

  constructor(
    readonly record: PendingInjectionRecord,
    private readonly deps: InjectionLedgerDeps,
    private readonly state: ChannelInjectState,
    readonly run?: InjectRun,
  ) {
    this.ts = record.createdAt;
    this.active = new Promise<void>((resolve) => { this.activeResolve = resolve; });
  }

  activate = (): void => { this.activeResolve(); };
  isReleased = (): boolean => this.releasePromise !== null;

  mark = (): void => {
    if (this.markerStarted || !this.deps.markPending) return;
    this.markerStarted = true;
    try {
      this.markerPromise = this.deps.markPending(this.record).catch(() => {});
    } catch {
      this.markerPromise = Promise.resolve();
    }
  };

  private clearMarker(): void {
    if (!this.markerStarted || this.markerCleared || !this.deps.unmarkPending) return;
    this.markerCleared = true;
    this.markerPromise = this.markerPromise
      .then(() => this.deps.unmarkPending!(this.record))
      .catch(() => {});
  }

  commit = (): Promise<boolean> => {
    if (!this.commitPromise) {
      const attempt = this.commitOnce();
      this.commitPromise = attempt;
      void attempt.then((committed) => {
        if (!committed && this.commitPromise === attempt) this.commitPromise = null;
      });
    }
    return this.commitPromise;
  };

  private async commitOnce(): Promise<boolean> {
    await this.active;
    try {
      const { committedTs } = await this.deps.commitPending(this.record, this.position);
      this.clearMarker();
      this.deps.publishDelivered({
        sessionId: this.record.sessionId, channel: this.record.channel,
        pendingId: this.record.id, messageTs: this.ts, committedTs,
      });
      return true;
    } catch (error) {
      log.error(`Failed to commit pending injection ${this.record.id}: ${(error as Error).message}`);
      return false;
    }
  }

  release = (): Promise<void> => {
    if (!this.releasePromise) this.releasePromise = this.releaseOnce();
    return this.releasePromise;
  };

  private async releaseOnce(): Promise<void> {
    this.detach();
    await this.commit();
    this.deps.track(-1);
    disposeIfIdle(this.record.channel);
  }

  /** Shares the release's single-fire slot: an entry ends either committed or unsent, never both. */
  unsend = (): Promise<void> => {
    if (!this.releasePromise) this.releasePromise = this.unsendOnce();
    return this.releasePromise;
  };

  private async unsendOnce(): Promise<void> {
    this.detach();
    await this.active;
    const setAside = !this.commitPromise && await this.setAside();
    if (!setAside) await this.commit();
    this.deps.track(-1);
    disposeIfIdle(this.record.channel);
  }

  private async setAside(): Promise<boolean> {
    try {
      if (!(await this.deps.setAsideUnsent(this.record))) return false;
    } catch (error) {
      log.error(`Failed to keep unsent injection ${this.record.id}: ${(error as Error).message}`);
      return false;
    }
    this.clearMarker();
    this.deps.publishUnsent({
      sessionId: this.record.sessionId, channel: this.record.channel,
      pendingId: this.record.id, messageTs: this.ts,
    });
    return true;
  }

  private detach(): void {
    this.state.live.delete(this);
    const index = this.state.pending.indexOf(this);
    if (index !== -1) this.state.pending.splice(index, 1);
  }
}

function armReleaseCap(deps: InjectionLedgerDeps, entry: PendingInjection): void {
  const capMs = deps.maxWaitMs ?? defaultMaxWaitMs();
  if (capMs <= 0) return;
  const timer = setTimeout(() => {
    if (!entry.isReleased()) {
      log.warn(`Injected message on ${entry.record.channel} got no reply within the cap — releasing the busy gate`);
    }
    void entry.release();
  }, capMs);
  timer.unref?.();
}

async function persistAndSurface(
  deps: InjectionLedgerDeps,
  entry: PendingInjection,
): Promise<void> {
  try {
    await deps.persistPending(entry.record);
  } catch (error) {
    // The backend already accepted the message, so falling through to the normal queue would send
    // it twice. Degrade to phase two instead: commit it to the transcript and let the delivered
    // event trigger refetch. Never advertise a provisional row that cannot survive a restart.
    log.error(`Failed to persist pending injection ${entry.record.id}: ${(error as Error).message}`);
    entry.activate();
    await entry.commit();
    return;
  }
  entry.mark();
  deps.publishMessage({
    sessionId: entry.record.sessionId, channel: entry.record.channel, role: 'user',
    text: entry.record.text, ts: entry.ts, attachments: entry.record.attachments,
    pending: true, pendingId: entry.record.id,
    // Carried onto the provisional row too: without it a backgrounded agent's result would flash
    // as a full user bubble for as long as the model takes to read it, then collapse to a hint.
    ...(entry.record.systemOrigin ? { systemOrigin: entry.record.systemOrigin } : {}),
  });
  entry.activate();
}

/**
 * Register one accepted injection with the ledger (phase one). The caller must already have passed
 * `record.id` to `run.steer()`; the run's `injection_delivered` / `injection_rejected` event will
 * carry it back here to run phase two.
 */
export async function beginInjection(
  deps: InjectionLedgerDeps,
  record: PendingInjectionRecord,
  run?: InjectRun,
): Promise<void> {
  const state = stateFor(record.channel);
  const entry = new PendingLifecycle(record, deps, state, run);
  deps.track(+1);
  state.pending.push(entry);
  state.live.add(entry);
  await persistAndSurface(deps, entry);
  armReleaseCap(deps, entry);
}

async function handleDelivered(
  channel: string,
  event: Extract<RunEvent, { type: 'injection_delivered' }>,
): Promise<void> {
  const state = channelStates.get(channel);
  if (!state) return;
  const index = state.pending.findIndex((entry) => entry.record.id === event.injectionId);
  if (index === -1) return;
  const [entry] = state.pending.splice(index, 1);
  entry.position = event.position;
  await entry.commit();
  if (event.foldedIntoTurn) await entry.release();
  else disposeIfIdle(channel);
}

async function handleUndelivered(channel: string, injectionId: string): Promise<void> {
  const state = channelStates.get(channel);
  if (!state) return;
  await state.pending.find((entry) => entry.record.id === injectionId)?.unsend();
}

async function handleContinuationResult(
  deps: InjectionLedgerDeps,
  state: ChannelInjectState,
  sessionId: string,
  channel: string,
  run: InjectRun | undefined,
): Promise<void> {
  state.continuationRunning = false;
  deps.publishStatus({ sessionId, channel, running: false });
  const ended = [...state.live].filter((entry) => entry.run === run);
  await Promise.all(ended.map((entry) => entry.release()));
  disposeIfIdle(channel);
}

/**
 * The run is over. A cancelled run took its backend process with it — Stop, an edit's rewind and
 * shutdown all kill it — so whatever that process had not read yet is lost to the model and becomes
 * an unsent row. A run that ended any other way may leave a live process that still reads it later,
 * so those stay pending under the wait cap. Read messages need nothing more from the run.
 */
async function handleRunClosed(channel: string, run: InjectRun | undefined): Promise<void> {
  const state = channelStates.get(channel);
  if (!state) return;
  const cancelled = run?.status === 'cancelled';
  const ended = [...state.live].filter((entry) => entry.run === run);
  const settle = (entry: PendingInjection): Promise<void> | undefined => {
    if (!state.pending.includes(entry)) return entry.release();
    return cancelled ? entry.unsend() : undefined;
  };
  await Promise.all(ended.map(settle));
}

interface ContinuationWriter {
  deps: InjectionLedgerDeps;
  sessionId: string;
  channel: string;
  stream: ((text: string) => void) | null;
  transcript: RunObserver;
}

/** The spontaneous turn's prose: marks the session running on its first words and streams it to the
 *  channel. Its row is the transcript sink's job. */
function streamContinuationText(w: ContinuationWriter, text: string, fromSubagent: boolean): void {
  const state = stateFor(w.channel);
  if (!state.continuationRunning) {
    state.continuationRunning = true;
    w.deps.publishStatus({ sessionId: w.sessionId, channel: w.channel, running: true });
  }
  // Streamed text is the reply the user reads, so a subagent's working notes stay out of it; the
  // sink still records them, tagged, so the transcript folds them into that subagent's block.
  if (fromSubagent) return;
  try { w.stream?.(text); }
  catch (error) { log.warn('injection stream callback threw:', (error as Error).message); }
}

function writeContinuationRow(w: ContinuationWriter, event: RunEvent): void | Promise<void> {
  if (event.type === 'assistant_text') {
    if (!event.text) return;
    streamContinuationText(w, event.text, !!event.subagent);
  }
  if (event.type === 'context_usage' && !w.sessionId) return;
  return w.transcript.onEvent(event);
}

/**
 * Adapt a run's `RunEvent` fan-out onto the ledger: injection acks drive phase two, background
 * continuation events become transcript rows for the injected turn. Foreground events are ignored —
 * they belong to the surface's own sink.
 */
export function createInjectionObserver(
  deps: InjectionLedgerDeps,
  channel: string,
  sessionId: string,
  /** The run whose background rows a hold may already own — see `AgentRun.backgroundTranscriptOwned`.
   *  Absent (tests, or an injection with no live run) means the ledger is the only writer. */
  run?: InjectRun,
): RunObserver {
  const writer: ContinuationWriter = {
    deps, sessionId, channel,
    stream: deps.getStreamingCallback(channel),
    transcript: createTranscriptSink({
      sessionId, channel, debug: deps.captureDebug ?? false,
      ...(deps.transcript ? { deps: deps.transcript } : {}),
    }),
  };
  /** Exactly one observer persists the background turn. When a background hold has claimed it, the
   *  ledger still commits its injections but writes no transcript rows — otherwise a session that is
   *  both held and injected into would append every continuation row twice. */
  const ownsRows = (): boolean => run?.backgroundTranscriptOwned !== true;
  return {
    onEvent(event: RunEvent): void | Promise<void> {
      switch (event.type) {
        case 'injection_delivered':
          return handleDelivered(channel, event);
        case 'injection_rejected':
          return handleUndelivered(channel, event.injectionId);
        case 'background_result':
          return handleContinuationResult(deps, stateFor(channel), sessionId, channel, run);
        default:
          if (!isBackgroundRowEvent(event) || !ownsRows()) return;
          return writeContinuationRow(writer, event);
      }
    },
    onClose: () => handleRunClosed(channel, run),
  };
}

/** Subscribe the ledger to `run` once per run; the subscriptions are released when the channel idles. */
export function ensureInjectionObserver(
  deps: InjectionLedgerDeps,
  channel: string,
  sessionId: string,
  run: AgentRun,
): void {
  const state = stateFor(channel);
  if (state.subscriptions.has(run)) return;
  state.subscriptions.set(run, run.subscribe(createInjectionObserver(deps, channel, sessionId, run)));
}

/** Test hook: drop all per-channel injection state. */
export function resetInjectionLedger(): void {
  channelStates.clear();
}
