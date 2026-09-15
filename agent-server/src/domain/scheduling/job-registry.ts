// input:  JobRunner callbacks registered at module load
// output: registerJob plus boolean dispatch(key, payload) behavior
// pos:    encapsulated scheduled-task dispatch table; no public key inventory

import type { EventBus } from '@events/index.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { Scheduler } from './scheduler.js';
import { createLogger } from '@core/log.js';

const log = createLogger('job-registry');

export type JobRunner = (payload: unknown) => Promise<void>;

const _registry = new Map<string, JobRunner>();

/**
 * Run one thread on the platform surface `ThreadRun` owns, and report back what happened. This is
 * the ONE seam between `domain/scheduling` and `orchestration` (plan §1.3): the thread jobs decide
 * what to run and what its result means for the task; everything they used to draw — status line,
 * progress, seal, OutputStream, interactive callbacks — belongs to the orchestration side of it.
 *
 * The input/output are `any` HERE, and only here. `domain/threads/runner` and
 * `domain/system/system-notice` both import this module for the shared bus, so naming
 * `ThreadRunInput` in this file — even `import type` — closes an import cycle through
 * `orchestration/thread-run`, and depcruise's `no-circular` rule (unlike the layer rules) does NOT
 * exempt type-only edges. Both ENDS of the seam are precisely typed: the two jobs re-declare it as
 * `(input: Omit<ThreadRunInput, 'adapter'>) => Promise<ThreadRunOutcome>` where they build the
 * input, and app.ts types the lambda it installs.
 */
export type RunThreadOnSurface = (input: any) => Promise<any>;

/** Say one thing on a destination. For the paths that fail BEFORE a run exists and therefore have
 *  no status line to write on: a skipped schedule, a plan that would not resolve, a dispatch that
 *  never got a thread. Durable when an outbound queue exists, as those posts have always been. */
export type NotifyDestination = (destination: Destination, text: string) => Promise<void>;

// Shared context set by runner.ts / app.ts after init
export const ctx: {
  /** Read only by auth-expiry-scan / sync-public; Phase 4 removes it. The two thread jobs no
   *  longer touch the adapter at all — they render through `runThreadOnSurface`. */
  adapter: PlatformAdapter | null;
  schedulerRef: Scheduler | null;
  bus: EventBus | null;
  runThreadOnSurface: RunThreadOnSurface | null;
  notify: NotifyDestination | null;
  /** DR-0014 §8: injected by app.ts (→ orchestration/thread-callback.reconcileWaitingTasks)
   *  so the dispatch path can close the suspension race window for manager threads
   *  without a domain → orchestration import. */
  onThreadSuspended: ((threadId: string) => Promise<void>) | null;
} = {
  adapter: null,
  schedulerRef: null,
  bus: null,
  runThreadOnSurface: null,
  notify: null,
  onThreadSuspended: null,
};

/** Read one injected collaborator, or say plainly which wiring is missing. A job that reaches
 *  orchestration through an un-injected seam is a composition-root bug, not a runtime condition —
 *  it must not degrade into a silently un-rendered run (plan §4). */
export function requireJobCtx<K extends 'runThreadOnSurface' | 'notify'>(name: K): NonNullable<typeof ctx[K]> {
  const value = ctx[name];
  if (!value) throw new Error(`job ctx: ${name} not injected`);
  return value as NonNullable<typeof ctx[K]>;
}

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
