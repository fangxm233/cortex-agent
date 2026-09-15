// input:  the store's `touchSessionUse` storage primitive (patch lastUsedAt iff live && !pending)
// output: the runtime use-count lease that keeps retention off a session while a turn holds it
// pos:    domain/sessions — the use-count bookkeeping that used to live inside
//         `store/session-registry-repo.ts`. The store now owns only storage; this owns policy.

import { sessionStore } from '@store/session-registry-repo.js';

/** The one storage call this tracker needs: patch `lastUsedAt=now` iff the session is live and not
 *  pending deletion, returning whether the touch landed. Narrowed so tests can inject a fake. */
export interface UseCountStore {
  touchSessionUse(sessionId: string): Promise<boolean>;
}

/**
 * In-memory use counter for live sessions. `acquireSessionUse` asks the store to touch the session
 * (which fails for unknown / pending-deletion ids); on success it bumps a per-session count and
 * returns an idempotent `release()` that decrements it. While a session's count is > 0 it appears in
 * {@link activeSessionUseIds}, which the retention sweep unions into its protected set so a session
 * cannot be deleted out from under a turn that is still opening.
 */
export class SessionUseTracker {
  private readonly activeUses = new Map<string, number>();

  constructor(private readonly store: UseCountStore) {}

  /** Take a use lease, or null when the record is gone / pending deletion. Nested acquires stack;
   *  each returns its own idempotent release. */
  async acquireSessionUse(sessionId: string): Promise<(() => void) | null> {
    if (!(await this.store.touchSessionUse(sessionId))) return null;
    this.activeUses.set(sessionId, (this.activeUses.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.activeUses.get(sessionId) ?? 1) - 1;
      if (next <= 0) this.activeUses.delete(sessionId);
      else this.activeUses.set(sessionId, next);
    };
  }

  /** Run `fn` while holding a use lease; returns null (without running `fn`) when the lease is
   *  refused. The lease is always released, even if `fn` throws. */
  async withSessionUse<T>(sessionId: string, fn: () => Promise<T>): Promise<T | null> {
    const release = await this.acquireSessionUse(sessionId);
    if (!release) return null;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The sessionIds with at least one live use lease — a snapshot the caller may keep. */
  activeSessionUseIds(): ReadonlySet<string> {
    return new Set(this.activeUses.keys());
  }

  /** Drop all counts. Tests only — production leases are balanced by their releases. */
  _resetForTests(): void {
    this.activeUses.clear();
  }
}

/** Process-wide tracker bound to the real registry singleton. */
export const sessionUse = new SessionUseTracker(sessionStore);

export const acquireSessionUse = (sessionId: string): Promise<(() => void) | null> =>
  sessionUse.acquireSessionUse(sessionId);

export const withSessionUse = <T>(sessionId: string, fn: () => Promise<T>): Promise<T | null> =>
  sessionUse.withSessionUse(sessionId, fn);

export const activeSessionUseIds = (): ReadonlySet<string> => sessionUse.activeSessionUseIds();
