// input:  settings callback, timeout functions, and retention sweep runner
// output: createSessionRetentionController
// pos:    Serializes startup, periodic, and settings-driven retention sweeps
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SETTINGS_DEBOUNCE_MS = 300;

export interface SessionRetentionControllerDeps {
  getRetentionDays: () => number;
  onSettingsChange: (callback: (changedKeys: string[]) => void) => () => void;
  runSweep: (retentionDays: number) => Promise<void>;
  onError?: (error: Error) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface SessionRetentionController {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSessionRetentionController(deps: SessionRetentionControllerDeps): SessionRetentionController {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let busy = false;
  let latestDays: number | null = null;
  let stopped = false;

  function clearTimers(): void {
    if (timer) clearTimeoutFn(timer);
    if (debounce) clearTimeoutFn(debounce);
    timer = null;
    debounce = null;
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeoutFn(() => { void queueSweep(deps.getRetentionDays()); }, SIX_HOURS_MS);
    (timer as NodeJS.Timeout).unref?.();
  }

  async function runLoop(days: number): Promise<void> {
    let nextDays: number | null = days;
    try {
      while (nextDays !== null && !stopped) {
        const current = nextDays;
        latestDays = null;
        try {
          await deps.runSweep(current);
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
    if (debounce) clearTimeoutFn(debounce);
    debounce = setTimeoutFn(() => {
      debounce = null;
      void queueSweep(deps.getRetentionDays());
    }, SETTINGS_DEBOUNCE_MS);
    (debounce as NodeJS.Timeout).unref?.();
  }

  return {
    async start(): Promise<void> {
      if (unsubscribe) return running ?? Promise.resolve();
      stopped = false;
      unsubscribe = deps.onSettingsChange(onSettingsChanged);
      await queueSweep(deps.getRetentionDays());
    },
    async stop(): Promise<void> {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      clearTimers();
      await running;
    },
  };
}
