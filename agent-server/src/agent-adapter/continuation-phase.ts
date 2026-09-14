//
// A run's life does not end with its foreground result. Claude opens a *spontaneous* turn of its
// own when a background task finishes (or when an injected message is consumed after the result),
// and the engine has to keep the turn open, keep the stream open, and decide when the run is
// really over. This module is that decision, in one place, for both engines:
//
//   none             settle at the foreground result; no continuation is possible.
//   hold             settle at the foreground result, keep streaming the background phase until
//                    the backend reports nothing left (or the grace/max-wait watchdog fires).
//                    Interactive surfaces hold a status message for exactly this window.
//   inline           settle with the MERGED result once the background phase ends. Thread/dispatch
//                    steps have no status message to hold, so their step result must carry the
//                    continuation's work.
//   completion-only  inline, but the grace/max-wait caps are disabled: only the backend finishing
//                    or the caller's process-stop boundary ends the wait. Supervised one-shot runs
//                    use this so an ambient cap can never publish success while work remains.
//
// The watchdog bounds the WAIT for a continuation, never the continuation itself: a background
// turn that runs longer than the window must not be sealed mid-stream. `onTurnOpen` therefore
// pauses the timers and the turn's own result re-arms or finishes.

import { createLogger } from '@core/log.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { BackgroundTurnSink } from './types.js';
import { getBgGraceMs, getBgMaxWaitMs, remainingBg } from './bg-wait.js';
import type { RunEvent } from './run-events.js';

const log = createLogger('bg-wait');

/** What the caller asked the engine to do about a run's background work. */
export type AwaitBackground = 'none' | 'hold' | 'inline' | 'completion-only';

/** Timer seam. Production timers are unref'd so a waiting run never keeps the process alive. */
export interface RunTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: RunTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) { clearTimeout(handle as NodeJS.Timeout); },
};

export interface ContinuationPhasePort {
  /** Fan one event out to the run's observers. */
  push(event: RunEvent): void;
  /** Resolve the engine run's `result`: the value the caller's foreground await gets. Called at
   *  most once, and only for the policies whose foreground turn settles on its own. */
  settleForeground(result: AgentResult): void;
  /** Resolve the engine run's `settled`: the accumulated result of the whole run. Idempotent, and
   *  it also releases `result` (a run that only ever settles here — `inline` — still has a
   *  foreground await to satisfy). */
  settleRun(result: AgentResult): void;
  /** Reject both promises (the backend died mid-continuation). Called at most once. */
  reject(error: Error): void;
  /** Force-close the event stream (the run is over). */
  close(): void;
  timers?: RunTimers;
  graceMs?: number;
  maxWaitMs?: number;
  /** `completion-only` runs end at this boundary (the process stopping), not at a timer. */
  stopPromise?: Promise<unknown>;
}

/** Merge a continuation turn into the accumulated result: costs and turns summed, latest non-empty
 *  output wins, rate-limit and remaining counts taken from the continuation. The merged result is
 *  what an `inline`/`completion-only` caller awaits and what every terminal tally is derived from,
 *  so a multi-continuation run reports the whole run rather than whichever turn happened to be
 *  last. */
export function mergeContinuation(acc: AgentResult, cont: AgentResult): AgentResult {
  const bothCostNull = acc.total_cost_usd == null && cont.total_cost_usd == null;
  const bothTurnsNull = acc.num_turns == null && cont.num_turns == null;
  const costReported = acc.costReported === undefined && cont.costReported === undefined
    ? undefined
    : acc.costReported === true || cont.costReported === true;
  return {
    ...acc,
    costReported,
    total_cost_usd: bothCostNull ? null : (acc.total_cost_usd ?? 0) + (cont.total_cost_usd ?? 0),
    num_turns: bothTurnsNull ? null : (acc.num_turns ?? 0) + (cont.num_turns ?? 0),
    finalOutput: cont.finalOutput || acc.finalOutput,
    rateLimited: acc.rateLimited || cont.rateLimited,
    rateLimitMessage: cont.rateLimitMessage ?? acc.rateLimitMessage,
    pendingBackgroundTasks: cont.pendingBackgroundTasks ?? 0,
    undeliveredBackgroundTasks: cont.undeliveredBackgroundTasks ?? 0,
  };
}

/** The `cost_record` a continuation turn reports, or null when it reported no accounting. */
function continuationCostRecord(result: AgentResult): RunEvent | null {
  const accounting = result.reportedAccounting;
  if (result.costReported !== true && accounting?.usageReported !== true) return null;
  return {
    type: 'cost_record', provider: 'anthropic', model: accounting?.model ?? 'unknown',
    tokens_in: accounting?.promptTokens ?? null,
    tokens_out: accounting?.outputTokens ?? null,
    prompt_tokens: accounting?.promptTokens ?? null,
    cached_tokens: accounting?.cachedTokens ?? null,
    input_tokens: accounting?.inputTokens ?? null,
    output_tokens: accounting?.outputTokens ?? null,
    cache_read_tokens: accounting?.cacheReadTokens ?? null,
    cache_creation_tokens: accounting?.cacheCreationTokens ?? null,
    provider_requests: Number.isSafeInteger(result.num_turns)
      && Number(result.num_turns) > 0 ? result.num_turns : null,
    cost_usd: result.costReported === false ? null : result.total_cost_usd,
  };
}

/**
 * Owns one run's background phase. The engine installs `sink()` on its transport (that is the
 * single slot a backend serves one run at a time with), calls `start()` with the foreground
 * result, and lets the phase decide when the run is over.
 */
export class ContinuationPhase {
  private readonly mode: AwaitBackground;
  private readonly port: ContinuationPhasePort;
  private readonly timers: RunTimers;
  private readonly graceMs: number;
  private readonly maxWaitMs: number;

  /** The merged result so far; null until the foreground turn has settled. */
  private acc: AgentResult | null = null;
  /** Mid-turn injections written into the live turn whose delivery ack has not arrived. Their
   *  reply is a continuation turn of this same run, so the phase must not end before it lands. */
  private outstandingInjections = 0;
  /** Continuation results that arrived before `start()` (a task that finished inside the
   *  foreground turn); replayed in order once the base is known. */
  private readonly queued: AgentResult[] = [];
  private started = false;
  private settled = false;
  private closed = false;
  /** A continuation turn is in flight. Its events are streaming; nothing may end the run before
   *  its result does. */
  private backgroundTurnOpen = false;
  private handle: unknown = null;
  /** A fired watchdog never re-arms: the cap means "stop holding anything open for this", not
   *  "restart the clock on the next report". */
  private waitExpired = false;

  constructor(mode: AwaitBackground, port: ContinuationPhasePort) {
    this.mode = mode;
    this.port = port;
    this.timers = port.timers ?? realTimers;
    const completionOnly = mode === 'completion-only';
    this.graceMs = completionOnly ? 0 : (port.graceMs ?? getBgGraceMs());
    this.maxWaitMs = completionOnly ? 0 : (port.maxWaitMs ?? getBgMaxWaitMs());
  }

  /** The background-turn sink the engine hands its transport for this run. The
   *  translation is `sinkToRunEvents`; the control flow (`onTurnOpen` / `onResult`) is this
   *  phase's, which is why the two are composed here rather than in the engine. */
  sink(): BackgroundTurnSink {
    const emit = sinkToRunEvents((event) => this.ingest(event));
    return {
      ...emit,
      onTurnOpen: () => this.onTurnOpen(),
      onResult: (result) => this.onResult(result),
    };
  }

  /**
   * The foreground turn settled. `none` — and any result with no background work — ends the run
   * here; everything else keeps the phase open and (for `inline`) defers `settle` to the merge.
   */
  start(base: AgentResult): void {
    if (this.started) return;
    this.started = true;
    this.acc = base;
    const queued = this.queued.splice(0);
    if (this.mode === 'none' || !this.owesWork(base)) {
      this.finish();
      for (const result of queued) this.onResult(result);
      return;
    }
    if (this.mode !== 'inline' && this.mode !== 'completion-only') this.port.settleForeground(this.acc);
    if (this.mode === 'completion-only') {
      if (!this.port.stopPromise) {
        // No stop boundary: nothing could ever end the wait, so wait for the backend instead of
        // leaving the run open forever.
        log.warn('completion-only background wait has no stop promise — waiting for the backend instead');
      } else {
        void this.port.stopPromise.then(
          () => this.rejectWith(new Error('Agent process stopped before background continuation completed')),
          (error) => this.rejectWith(error),
        );
      }
    }
    this.enterBackground();
    this.arm(
      Math.max(base.pendingBackgroundTasks ?? 0, this.outstandingInjections),
      base.undeliveredBackgroundTasks ?? 0,
    );
    for (const result of queued) this.onResult(result);
  }

  /** True while this run still owes the caller something: unstamped background work, or a reply to
   *  an injected message that has not been delivered yet. */
  private owesWork(base: AgentResult): boolean {
    return remainingBg(base) > 0 || this.outstandingInjections > 0;
  }

  /**
   * An injection Cortex accepted into the live turn. Its ack arrives as an event on this stream
   * (`injection_delivered` / `injection_rejected`) and is what releases the obligation: a message
   * folded into the running turn is already carried by that turn's result, whereas one consumed
   * after the result opens a spontaneous turn whose reply lands here.
   */
  noteInjectionAccepted(): void {
    this.outstandingInjections += 1;
  }

  /** A synthetic continuation turn opened. Its length is unbounded, so the ambient timers stop;
   *  the turn's own result re-arms them or ends the run.
   *
   *  This is also where an injected message's obligation ends. A message consumed with no turn in
   *  flight is exactly what makes the backend open a turn of its own, so the turn opening here IS
   *  that message's reply arriving: the run stops owing anything on its behalf and the turn's own
   *  result decides what happens next. Releasing it on the ack instead would close the stream
   *  before the reply it is owed could land; never releasing it (as was the case) left a run whose
   *  foreground turn ended with one injected message pending open forever — the max-wait watchdog
   *  bounds a WAIT, it does not finish a run. */
  onTurnOpen(): void {
    if (this.settled || !this.started) return;
    this.backgroundTurnOpen = true;
    this.outstandingInjections = 0;
    this.pause();
    this.enterBackground();
  }

  private enterBackground(): void {
    if (!this.acc) return;
    this.port.push({
      type: 'phase', phase: 'background',
      pendingBackground: this.acc.pendingBackgroundTasks ?? 0,
      undeliveredBackground: this.acc.undeliveredBackgroundTasks ?? 0,
    });
  }

  /** Everything that reaches this run's stream passes through here, so the phase can react to the
   *  couple of events that change what the run still owes (injection acks, a turn opening). */
  ingest(event: RunEvent): void {
    if (this.settled) return;
    if (event.type === 'injection_rejected'
        || (event.type === 'injection_delivered' && event.foldedIntoTurn)) {
      // Either the message never reached the backend, or it folded into the turn whose result is
      // already accounted for here. Both mean nothing more is owed on its behalf.
      if (this.outstandingInjections > 0) this.outstandingInjections -= 1;
      this.port.push(event);
      if (this.started && this.outstandingInjections === 0
          && remainingBg(this.acc) === 0 && this.backgroundTurnOpen === false) {
        this.finish();
      }
      return;
    }
    if (event.type === 'phase' && event.phase === 'background') this.backgroundTurnOpen = true;
    this.port.push(event);
  }

  /** A continuation turn's result. Everything the caller is still waiting on is decided here. */
  onResult(result: AgentResult): void {
    if (!this.started) { this.queued.push(result); return; }
    if (this.settled) return;
    if (result.backgroundInterrupted) {
      // The process died mid-continuation. `completion-only` runs treat that as a failure (they
      // have no cap to release them); everyone else finalizes the accumulated work normally.
      if (this.mode === 'completion-only') {
        this.rejectWith(new Error('Agent process stopped before background continuation completed'));
        return;
      }
      this.port.push({ type: 'background_result', result });
      this.acc = { ...(this.acc as AgentResult), backgroundInterrupted: true };
      this.finish();
      return;
    }
    const costRecord = continuationCostRecord(result);
    if (costRecord) this.port.push(costRecord);
    this.port.push({ type: 'background_result', result });
    this.acc = mergeContinuation(this.acc as AgentResult, result);
    this.backgroundTurnOpen = false;
    if (this.acc.rateLimited) { this.finish(); return; }
    const running = result.pendingBackgroundTasks ?? 0;
    const undelivered = result.undeliveredBackgroundTasks ?? 0;
    if (running + undelivered > 0 || this.outstandingInjections > 0) {
      this.arm(Math.max(running, this.outstandingInjections), undelivered);
    } else {
      this.finish();
    }
  }

  // ── watchdog ───────────────────────────────────────────────────────────
  //
  // Two bounds, and they are not interchangeable:
  //   grace     finished-but-unnotified work. The backend does not always deliver the
  //             notification (same-turn completions on old CLIs never do; killed tasks never do).
  //   max-wait  still-running work. A tunnel or a monitor legitimately never ends, so the cap
  //             stops the run holding anything open on its behalf — but it does NOT finish: a
  //             very late continuation still arrives and still lands on this stream.

  private arm(running: number, undelivered: number): void {
    this.clearTimer();
    if (this.settled || this.waitExpired) return;
    if (running > 0) {
      if (this.mode === 'completion-only') return;
      this.handle = this.timers.set(() => this.onTimeout('max-wait'), this.maxWaitMs);
      return;
    }
    if (undelivered > 0) {
      if (this.mode === 'completion-only') return;
      this.handle = this.timers.set(() => this.onTimeout('grace'), this.graceMs);
    }
  }

  private pause(): void {
    if (this.settled || this.handle === null) return;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  private onTimeout(reason: 'grace' | 'max-wait'): void {
    if (this.settled) return;
    this.handle = null;
    this.waitExpired = true;
    this.port.push({ type: 'background_timeout', reason });
    if (this.settled) return;
    if (reason === 'grace') this.finish();
  }

  // ── terminal ───────────────────────────────────────────────────────────

  /** The run is over: settle with the accumulated result, then close the stream. Idempotent. */
  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    if (this.acc) this.port.settleRun(this.acc);
    this.close();
  }

  private rejectWith(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    const failure = error instanceof Error ? error : new Error(String(error));
    this.port.push({ type: 'error', message: failure.message, fatal: true });
    this.port.reject(failure);
    this.close();
  }

  /** Push the terminating phase event and close the stream. Idempotent. */
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.push({ type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
    this.port.close();
  }
}

/**
 * The event-carrying half of a BackgroundTurnSink: everything a background turn emits, without the
 * two members that are control flow rather than stream content (`onTurnOpen` / `onResult`).
 * Whatever drives the wait composes those on top.
 */
export type BackgroundEventSink = Omit<BackgroundTurnSink, 'onTurnOpen' | 'onResult'>;

/**
 * Adapt a continuation turn's callbacks into the run's `RunEvent` stream, tagged
 * `phase: 'background'` — a continuation turn is the same run, later. This is the engine's own
 * translation (the adapter may not import the run layer), and it is the only place a background
 * turn's events are shaped.
 */
export function sinkToRunEvents(emit: (event: RunEvent) => void): BackgroundEventSink {
  return {
    onAssistantText: (text, model, subagent) => {
      emit({
        type: 'assistant_text', text, phase: 'background',
        ...(model !== undefined ? { model } : {}),
        ...(subagent !== undefined ? { subagent } : {}),
      });
    },
    onToolUse: (name, input, toolUseId, subagent) => {
      emit({
        type: 'tool_use', toolUseId: toolUseId ?? '', name, input, phase: 'background',
        ...(subagent !== undefined ? { subagent } : {}),
      });
    },
    onToolResult: (toolUseId, content, isError, subagent) => {
      emit({
        type: 'tool_result', toolUseId, ok: !isError, content, phase: 'background',
        ...(subagent !== undefined ? { subagent } : {}),
      });
    },
    onContextUsage: (usage) => emit({ type: 'context_usage', ...usage, phase: 'background' }),
    onSubagentEnd: (parentToolUseId, status) => {
      emit({ type: 'subagent_end', parentToolUseId, status, phase: 'background' });
    },
  };
}
