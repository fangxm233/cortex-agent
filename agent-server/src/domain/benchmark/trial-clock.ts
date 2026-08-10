// input:  a frozen trial deadline and the time sources the coordinator pins
// output: DeterministicClock — wall time, monotonic elapsed, deadline remainder, cancellable sleep
// pos:    §7.2 P17. Zero-dependency time port for the composite path
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// Zero-dependency by construction: this factory cannot explicitly compose an ambient home or
// daemon singleton. The injection shape follows the shipped trajectory-layer precedent
// `openJournal({..., now?})`
// (agent-run/journal.ts:278-282) rather than inventing one. Everything else on the composite path
// calls `Date.now()` / `new Date()` directly — acceptance-ledger.ts:68,86-93, task-lock.ts:81-98,
// thread-callback.ts:309-316 — and each of those is a site the extraction reroutes through here.

/** §7.2 P17. `remainingMs() <= 0` is the D5 deadline (§4.4); the caller owns that comparison. */
export interface DeterministicClock {
  nowMs(): number;
  nowDate(): Date;
  monotonicNs(): bigint;
  remainingMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface TrialClockInput {
  /** Absolute epoch millisecond the trial's deadline falls on, frozen with the policy (§1.4). */
  deadlineEpochMs: number;
  /** Wall-clock source. The production default is `Date.now`; a trial pins its own. */
  now?: () => number;
  /** Monotonic nanosecond source. The production default is `process.hrtime.bigint`. */
  monotonic?: () => bigint;
}

export function createTrialClock(input: TrialClockInput): DeterministicClock {
  const { deadlineEpochMs } = input;
  const now = input.now ?? Date.now;
  const monotonic = input.monotonic ?? process.hrtime.bigint;
  const origin = monotonic();

  return {
    nowMs: () => now(),
    nowDate: () => new Date(now()),
    monotonicNs: () => monotonic() - origin,
    remainingMs: () => deadlineEpochMs - now(),
    sleep: (ms, signal) => sleepUntil(ms, signal),
  };
}

function sleepUntil(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
