// input:  busy-bracket track fn + grace/max-wait callbacks (+ injectable timers for tests)
// output: startBgWaitGuard / getBgGraceMs / getBgMaxWaitMs
// pos:    CC background-task waiting-window guard — F1 busy bracket, F5 grace watchdog, F6 max-wait cap
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Why this exists (2026-07-10 investigation, cortex-self ISSUES C(2)):
//   F1 — the turn's own trackPendingTask bracket closes when handle.promise resolves, so the
//        "background task running" waiting window used to leave the daemon busy count at 0 —
//        a deferred .restart then fired and killed the Claude child (and the bg task with it).
//        The guard holds +1 for the whole window.
//   F5 — CC does not always deliver task_notification (old-CLI same-turn completions never
//        notify; killed tasks never notify). For work-done-but-unnotified tasks we wait only
//        a grace period (default 90s > the observed 24s max updated→notification gap), then
//        give up and finalize instead of waiting forever.
//   F6 — legitimately never-ending background tasks (tunnels, monitors) must not hold the
//        busy gate for hours: after a max-wait cap (default 30min) the caller seals the
//        status as "still running" and the bracket is released (the sink stays registered,
//        so a very late continuation still merges into the same reply).

export interface BgWaitGuard {
  /** Re-arm timers after a chained continuation reported new remaining counts.
   *  rearm(0, 0) settles immediately. No-op once settled. */
  rearm(running: number, undelivered: number): void;
  /** The continuation turn opened: stop the wait watchdogs but keep the busy bracket. The turn's
   *  own result re-arms (rearm) or settles; process death seals through the sink. No-op once settled. */
  pause(): void;
  /** Idempotent: clears timers and releases the busy bracket exactly once. */
  settle(): void;
  readonly settled: boolean;
}

export interface BgWaitGuardOpts {
  running: number;
  undelivered: number;
  /** Busy bracket (trackPendingTask). +1 at start, -1 on settle. */
  track: (delta: number) => void;
  /** Fired when undelivered-only work produced no notification within the grace period. */
  onGraceTimeout: () => void;
  /** Fired when running work exceeded the max-wait cap. */
  onMaxWait: () => void;
  graceMs?: number;
  maxWaitMs?: number;
  /** Injectable timers for tests. Production timers are unref'd (never hold the loop). */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

// Shared env-tunable durations live in agent-adapter/bg-wait (also used by the thread
// inline wait); re-exported here for existing orchestration-side consumers/tests.
import { getBgGraceMs, getBgMaxWaitMs } from '../agent-adapter/bg-wait.js';
export { getBgGraceMs, getBgMaxWaitMs };

const realTimers = {
  set: (fn: () => void, ms: number): unknown => {
    const h = setTimeout(fn, ms);
    (h as any).unref?.();
    return h;
  },
  clear: (h: unknown): void => clearTimeout(h as NodeJS.Timeout),
};

export function startBgWaitGuard(opts: BgWaitGuardOpts): BgWaitGuard {
  const timers = opts.timers ?? realTimers;
  const graceMs = opts.graceMs ?? getBgGraceMs();
  const maxWaitMs = opts.maxWaitMs ?? getBgMaxWaitMs();
  let settled = false;
  let handle: unknown = null;

  opts.track(+1);

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (handle !== null) { timers.clear(handle); handle = null; }
    opts.track(-1);
  };

  const arm = (running: number, undelivered: number): void => {
    if (handle !== null) { timers.clear(handle); handle = null; }
    if (running > 0) {
      handle = timers.set(() => { settle(); opts.onMaxWait(); }, maxWaitMs);
    } else if (undelivered > 0) {
      handle = timers.set(() => { settle(); opts.onGraceTimeout(); }, graceMs);
    } else {
      settle();
    }
  };

  arm(opts.running, opts.undelivered);

  return {
    rearm(running: number, undelivered: number): void {
      if (settled) return;
      arm(running, undelivered);
    },
    pause(): void {
      if (settled || handle === null) return;
      timers.clear(handle);
      handle = null;
    },
    settle,
    get settled(): boolean { return settled; },
  };
}
