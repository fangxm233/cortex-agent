// input:  TodoSnapshot values keyed by sessionId
// output: SessionTodos / sessionTodos singleton — queryable snapshot of each session's task list
// pos:    core/ zero-dependency state registry (sibling of bg-held-sessions.ts)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Why this exists, and why it is NOT persisted: the task list is live state of a run. Snapshot +
// delta, same shape as SessionInfo.running — `session.todos` is the delta, `sessions.list` serves
// this registry as the snapshot so a page reload or a session switch does not lose the list.
//
// It deliberately does not go into the session registry journal. That journal is replayed from
// disk and a `put` is written per update; TodoWrite fires roughly once per completed step, which
// would multiply the journal's write rate for state that is worthless after a restart — the run
// that owned the list died with the process. An empty registry after boot is the truth, exactly as
// it is for bg-held-sessions.

import type { TodoSnapshot } from './types/agent-types.js';

/** Bound on tracked sessions. There is no session-deleted event to key eviction off, so the
 *  registry evicts by recency instead. A few hundred live sessions is already far past any real
 *  workbench, and an evicted entry only means the rail re-appears on the next TodoWrite. */
const MAX_TRACKED_SESSIONS = 500;

export class SessionTodos {
  private bySession = new Map<string, TodoSnapshot>();

  /** Record the latest snapshot. TodoWrite is replace-all, so this overwrites rather than merges. */
  set(sessionId: string, snapshot: TodoSnapshot): void {
    if (!sessionId) return;
    // Delete first so re-setting moves the key to the end: Map preserves insertion order, and
    // without this an actively updated session would still be evicted as if it were the oldest.
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, snapshot);
    while (this.bySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.bySession.keys().next();
      if (oldest.done) break;
      this.bySession.delete(oldest.value);
    }
  }

  /** Latest snapshot for a session, or null when it has never written a task list. */
  get(sessionId: string): TodoSnapshot | null {
    return this.bySession.get(sessionId) ?? null;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Test seam. */
  reset(): void {
    this.bySession.clear();
  }
}

export const sessionTodos = new SessionTodos();
