// input:  JobRunner callbacks registered at module load
// output: registerJob plus boolean dispatch(key, payload) behavior
// pos:    encapsulated scheduled-task dispatch table; no public key inventory

import type { EventBus } from '@events/index.js';
import type { PlatformAdapter } from '@platform/index.js';
import type { Scheduler } from './scheduler.js';
import { createLogger } from '@core/log.js';

const log = createLogger('job-registry');

export type JobRunner = (payload: unknown) => Promise<void>;

const _registry = new Map<string, JobRunner>();

/** Interactive callbacks factory for plan_written / ask_user_question events. */
export type InteractiveCallbacksFactory = (channel: string, sessionId: string | null) => {
  onToolUse: ((name: string, input: any) => void);
  onPlanWritten: ((event: { path: string; content: string; toolUseId: string }) => void);
  onAskUserQuestion: ((event: { toolUseId: string; questions: Array<{ question: string; options?: string[]; multi?: boolean }> }) => void);
};

// Shared context set by runner.ts after init
export const ctx: {
  adapter: PlatformAdapter | null;
  schedulerRef: Scheduler | null;
  bus: EventBus | null;
  buildInteractiveCallbacks: InteractiveCallbacksFactory | null;
  /** DR-0014 §8: injected by app.ts (→ orchestration/thread-callback.reconcileWaitingTasks)
   *  so the dispatch path can close the suspension race window for manager threads
   *  without a domain → orchestration import. */
  onThreadSuspended: ((threadId: string) => Promise<void>) | null;
} = {
  adapter: null,
  schedulerRef: null,
  bus: null,
  buildInteractiveCallbacks: null,
  onThreadSuspended: null,
};

export function register(key: string, runner: JobRunner): void {
  if (_registry.has(key)) {
    log.warn(`Overwriting existing runner for key "${key}"`);
  }
  _registry.set(key, runner);
}

export function dispatch(key: string, payload: unknown): boolean {
  const runner = _registry.get(key);
  if (!runner) {
    log.warn(`No runner registered for key "${key}"`);
    return false;
  }
  runner(payload).catch((err) => {
    log.error(`Runner "${key}" failed:`, err);
  });
  return true;
}
