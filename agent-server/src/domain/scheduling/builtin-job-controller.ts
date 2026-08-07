// input:  runtime settings callbacks and periodic job definitions
// output: settings-backed built-in job lifecycle controller
// pos:    Owns timers, serial execution, and graceful job shutdown
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

export type BuiltinJobMode = 'serial' | 'detached';

export interface BuiltinJobDefinition {
  name: string;
  enabledKey: string;
  intervalKey: string;
  mode: BuiltinJobMode;
  run: () => void | Promise<void>;
}

interface BuiltinJobState {
  enabled: boolean;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
}

export interface BuiltinJobControllerOptions {
  getSettings: () => Record<string, unknown>;
  onSettingsChange: (callback: (changedKeys: string[]) => void) => () => void;
  jobs: BuiltinJobDefinition[];
  onError?: (job: string, error: unknown) => void;
}

export interface BuiltinJobController {
  start: () => void;
  stop: () => Promise<void>;
}

function clearJobTimer(state: BuiltinJobState): void {
  if (!state.timer) return;
  clearTimeout(state.timer);
  state.timer = null;
}

class JobController implements BuiltinJobController {
  private states = new Map<string, BuiltinJobState>();
  private started = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private options: BuiltinJobControllerOptions) {
    for (const job of options.jobs) {
      this.states.set(job.name, { enabled: false, intervalMs: 0, timer: null, inFlight: null });
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.options.onSettingsChange(() => this.sync());
    this.sync();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const state of this.states.values()) clearJobTimer(state);
    const running = [...this.states.values()].flatMap((state) => state.inFlight ? [state.inFlight] : []);
    await Promise.allSettled(running);
  }

  private sync(): void {
    const settings = this.options.getSettings();
    for (const job of this.options.jobs) {
      const state = this.states.get(job.name)!;
      const wasEnabled = state.enabled;
      const nextEnabled = settings[job.enabledKey] === true;
      const nextInterval = settings[job.intervalKey] as number;
      const intervalChanged = nextInterval !== state.intervalMs;
      state.enabled = nextEnabled;
      state.intervalMs = nextInterval;
      if (!nextEnabled) clearJobTimer(state);
      else if (!state.inFlight && (!wasEnabled || intervalChanged)) {
        this.schedule(job, wasEnabled ? nextInterval : 0);
      }
    }
  }

  private schedule(job: BuiltinJobDefinition, delayMs: number): void {
    const state = this.states.get(job.name)!;
    clearJobTimer(state);
    if (!this.started || !state.enabled) return;
    state.timer = setTimeout(() => this.fire(job), delayMs);
  }

  private fire(job: BuiltinJobDefinition): void {
    const state = this.states.get(job.name)!;
    state.timer = null;
    const settings = this.options.getSettings();
    if (!this.started || settings[job.enabledKey] !== true) return;
    state.intervalMs = settings[job.intervalKey] as number;
    if (job.mode === 'serial') this.runSerial(job);
    else this.runDetached(job);
  }

  private runSerial(job: BuiltinJobDefinition): void {
    const state = this.states.get(job.name)!;
    if (state.inFlight) return;
    const running = Promise.resolve().then(() => job.run()).then(() => undefined);
    state.inFlight = running;
    void running.catch((error) => this.report(job, error)).finally(() => this.finishSerial(job));
  }

  private finishSerial(job: BuiltinJobDefinition): void {
    const state = this.states.get(job.name)!;
    state.inFlight = null;
    if (this.started && state.enabled) this.schedule(job, state.intervalMs);
  }

  private runDetached(job: BuiltinJobDefinition): void {
    try {
      void Promise.resolve(job.run()).catch((error) => this.report(job, error));
    } catch (error) {
      this.report(job, error);
    }
    const state = this.states.get(job.name)!;
    if (this.started && state.enabled) this.schedule(job, state.intervalMs);
  }

  private report(job: BuiltinJobDefinition, error: unknown): void {
    this.options.onError?.(job.name, error);
  }
}

export function createBuiltinJobController(options: BuiltinJobControllerOptions): BuiltinJobController {
  return new JobController(options);
}
