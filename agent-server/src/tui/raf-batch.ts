//
// Why: each mouse-wheel notch and each drag motion event currently triggers its own setState →
// full React reconciliation of the transcript (which re-flattens every message). Ink already
// throttles the PAINT to ~32ms, but the reconciliation work is not throttled, so a fast scroll or
// drag spends CPU re-flattening on every event and adds latency. Coalescing wheel notches into a
// single net scroll, and throttling drag-selection updates, cuts that reconciliation count.

/** Accumulates numeric deltas and applies their sum once per scheduled flush. */
export interface NumericBatcher {
  /** Add a signed delta; schedules a flush if one is not already pending. */
  add(delta: number): void;
  /** Apply the accumulated sum immediately (if non-zero) and clear any pending flush. */
  flushNow(): void;
  /** Drop any accumulated delta and pending flush without applying. */
  cancel(): void;
}

/**
 * Coalesce numeric deltas. Multiple `add()` calls within one event-loop turn (e.g. several wheel
 * notches in a single stdin chunk, or across chunks in the same tick) are summed and `apply`d once.
 * `schedule`/`cancelSchedule` are injectable for testing; default is setImmediate (flushes after
 * the current I/O callbacks, so a burst of stdin events collapses into one apply).
 */
export function createNumericBatcher(
  apply: (sum: number) => void,
  schedule: (cb: () => void) => unknown = (cb) => setImmediate(cb),
  cancelSchedule: (handle: unknown) => void = (h) => clearImmediate(h as NodeJS.Immediate),
): NumericBatcher {
  let sum = 0;
  let handle: unknown = null;

  const flush = () => {
    handle = null;
    if (sum !== 0) {
      const s = sum;
      sum = 0;
      apply(s);
    }
  };

  return {
    add(delta: number) {
      sum += delta;
      if (handle === null) handle = schedule(flush);
    },
    flushNow() {
      if (handle !== null) { cancelSchedule(handle); handle = null; }
      if (sum !== 0) { const s = sum; sum = 0; apply(s); }
    },
    cancel() {
      if (handle !== null) { cancelSchedule(handle); handle = null; }
      sum = 0;
    },
  };
}

/** A throttled function wrapper: leading call fires immediately, trailing call is deferred. */
export interface Throttled<A extends unknown[]> {
  call(...args: A): void;
  /** Cancel a pending trailing call. */
  cancel(): void;
}

/**
 * Leading + trailing throttle. The first call in an idle period runs immediately; subsequent calls
 * within `intervalMs` are coalesced into a single trailing call fired at the end of the window with
 * the latest arguments. Used to cap drag-selection re-renders at ~one per frame while still landing
 * the final cursor position. `now`/`schedule`/`cancelSchedule` are injectable for tests.
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  deps: {
    now?: () => number;
    schedule?: (cb: () => void, ms: number) => unknown;
    cancelSchedule?: (handle: unknown) => void;
  } = {},
): Throttled<A> {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((cb, ms) => setTimeout(cb, ms));
  const cancelSchedule = deps.cancelSchedule ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let lastRun = -Infinity;
  let handle: unknown = null;
  let pendingArgs: A | null = null;

  const runTrailing = () => {
    handle = null;
    lastRun = now();
    if (pendingArgs) { const a = pendingArgs; pendingArgs = null; fn(...a); }
  };

  return {
    call(...args: A) {
      const elapsed = now() - lastRun;
      if (elapsed >= intervalMs) {
        // Leading edge: run now, clear any stale trailing.
        if (handle !== null) { cancelSchedule(handle); handle = null; }
        pendingArgs = null;
        lastRun = now();
        fn(...args);
      } else {
        // Within the window: remember the latest args, schedule a single trailing run.
        pendingArgs = args;
        if (handle === null) handle = schedule(runTrailing, intervalMs - elapsed);
      }
    },
    cancel() {
      if (handle !== null) { cancelSchedule(handle); handle = null; }
      pendingArgs = null;
    },
  };
}
