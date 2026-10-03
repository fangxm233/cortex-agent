import type { EventBus } from '@events/index.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';

/**
 * Run one thread on the platform surface `ThreadRun` owns, and report back what happened. Task
 * dispatch decides what to run and what its result means for the task; everything it used to draw —
 * status line, progress, seal, OutputStream, interactive callbacks — belongs to the orchestration
 * side of it.
 *
 * The input/output are `any` HERE, and only here. `domain/threads/runner` and
 * `domain/system/system-notice` both import this module for the shared bus, so naming
 * `ThreadRunInput` in this file — even `import type` — closes an import cycle through
 * `orchestration/thread-run`, and depcruise's `no-circular` rule (unlike the layer rules) does NOT
 * exempt type-only edges. Both ENDS of the seam are precisely typed: the job re-declares it as
 * `(input: Omit<ThreadRunInput, 'adapter'>) => Promise<ThreadRunOutcome>` where it builds the
 * input, and app.ts types the lambda it installs.
 */
export type RunThreadOnSurface = (input: any) => Promise<any>;

/** Say one thing on a destination. For the paths that fail BEFORE a run exists and therefore have
 *  no status line to write on: a schedule whose session could not be opened, a dispatch that never
 *  got a thread. Durable when an outbound queue exists, as those posts have always been. */
export type NotifyDestination = (destination: Destination, text: string) => Promise<void>;

/** Open a scheduled run: deliver the fired prompt into its freshly created session as that
 *  session's first turn. Resolves once the turn is admitted, not when it ends. */
export type DeliverScheduledTurn = (input: { channel: string; text: string }) => Promise<void>;

// Shared context set by runner.ts / app.ts after init
export const ctx: {
  /** Read only by auth-expiry-scan / sync-public; Phase 4 removes it. Task dispatch no longer
   *  touches the adapter at all — it renders through `runThreadOnSurface`. */
  adapter: PlatformAdapter | null;
  bus: EventBus | null;
  runThreadOnSurface: RunThreadOnSurface | null;
  notify: NotifyDestination | null;
  deliverScheduledTurn: DeliverScheduledTurn | null;
  /** DR-0014 §8: injected by app.ts (→ orchestration/thread-callback.reconcileWaitingTasks)
   *  so the dispatch path can close the suspension race window for manager threads
   *  without a domain → orchestration import. */
  onThreadSuspended: ((threadId: string) => Promise<void>) | null;
} = {
  adapter: null,
  bus: null,
  runThreadOnSurface: null,
  notify: null,
  deliverScheduledTurn: null,
  onThreadSuspended: null,
};

/** Read one injected collaborator, or say plainly which wiring is missing. A job that reaches
 *  orchestration through an un-injected seam is a composition-root bug, not a runtime condition —
 *  it must not degrade into a silently un-rendered run (plan §4). */
export function requireJobCtx<K extends 'runThreadOnSurface' | 'notify' | 'deliverScheduledTurn'>(name: K): NonNullable<typeof ctx[K]> {
  const value = ctx[name];
  if (!value) throw new Error(`job ctx: ${name} not injected`);
  return value as NonNullable<typeof ctx[K]>;
}
