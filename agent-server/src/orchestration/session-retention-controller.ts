const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SETTINGS_DEBOUNCE_MS = 300;

export interface SessionRetentionControllerDeps {
  getRetentionDays: () => number;
  onSettingsChange: (callback: (changedKeys: string[]) => void) => () => void;
  /** `signal` aborts when the controller stops; the sweep should return at its next checkpoint. */
  runSweep: (retentionDays: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: Error) => void;
}

export interface SessionRetentionController {
  /** Subscribe and start the first sweep in the background — never waits for it. */
  start(): void;
  /** Abort the running sweep and wait for it to reach its next checkpoint. */
  stop(): Promise<void>;
}

export function createSessionRetentionController(deps: SessionRetentionControllerDeps): SessionRetentionController {
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let busy = false;
  let latestDays: number | null = null;
  let stopped = false;
  let abort = new AbortController();

  function clearTimers(): void {
    if (timer) clearTimeout(timer);
    if (debounce) clearTimeout(debounce);
    timer = null;
    debounce = null;
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => { void queueSweep(deps.getRetentionDays()); }, SIX_HOURS_MS);
    (timer as NodeJS.Timeout).unref?.();
  }

  async function runLoop(days: number): Promise<void> {
    let nextDays: number | null = days;
    try {
      while (nextDays !== null && !stopped) {
        const current = nextDays;
        latestDays = null;
        try {
          await deps.runSweep(current, abort.signal);
        } catch (error) {
          deps.onError?.(error as Error);
        }
        nextDays = latestDays;
      }
      busy = false;
    } finally {
      const queued = latestDays;
      running = null;
      if (queued !== null && !stopped) void queueSweep(queued);
      else if (!stopped) scheduleNext();
    }
  }

  function queueSweep(days: number): Promise<void> {
    latestDays = days;
    if (busy) return running ?? Promise.resolve();
    busy = true;
    running = runLoop(days);
    return running;
  }

  function onSettingsChanged(changedKeys: string[]): void {
    if (!changedKeys.includes('sessionRetentionDays') || stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void queueSweep(deps.getRetentionDays());
    }, SETTINGS_DEBOUNCE_MS);
    (debounce as NodeJS.Timeout).unref?.();
  }

  return {
    start(): void {
      if (unsubscribe) return;
      stopped = false;
      abort = new AbortController();
      unsubscribe = deps.onSettingsChange(onSettingsChanged);
      void queueSweep(deps.getRetentionDays());
    },
    async stop(): Promise<void> {
      stopped = true;
      abort.abort();
      unsubscribe?.();
      unsubscribe = null;
      clearTimers();
      await running;
    },
  };
}
