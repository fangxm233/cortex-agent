//
// Background holds: the half of "is this session busy" that no live execution accounts for.
//
// A session is HELD when its foreground turn is over but something keeps it logically running —
// a Claude background-task continuation, a backgrounded `agent` run, a web status hold. The
// executions index (`run-registry.ts`) cannot answer that: by then there is nothing running to
// index. The two are joined in `session-state.ts`, which is the only place that answers the
// question; this file owns only the holds themselves.
//
// Split out of `run-registry.ts` unchanged (plan/orchestration-turn-refactor.md §1.2).

/** Owner key for handles passed straight to `markBackgroundHeld`. */
const HOLD_OWNER_INLINE = 'inline';

/**
 * What ends a session's background hold. TWO verbs, because a hold can be ended for two different
 * reasons and the right response is not the same one:
 *
 * - `onSuperseded` — a new FOREGROUND turn took over the session. The hold's passive part (its
 *   "running in the background" status, its busy bracket) is now the new turn's business. Work that
 *   is genuinely still running must NOT be touched: a user typing a second message is not asking to
 *   kill the first message's delegated agents.
 * - `onStop` — the user pressed Stop. End the work too.
 *
 * A hold that owns only status (the Claude background-task continuation hold) points both at the
 * same seal. A hold that owns live work (a backgrounded `agent` run) sets ONLY `onStop`, and its
 * busy bracket deliberately survives preemption so a deferred daemon restart cannot fire while the
 * child is mid-work.
 *
 * This used to be one `() => void` slot per session. Two callers wrote handles with incompatible
 * meanings into it, and `beginForegroundSession` — which fires on every incoming message — read the
 * slot expecting "release". When the slot happened to hold "stop the child", a second user message
 * executed the running agent instead of yielding to it (observed 2026-09-12).
 */
export interface SessionHoldHandles {
  onSuperseded?: () => void;
  onStop?: () => void;
}

/** A `session.status` event payload, mirrored into the background-hold state. */
export interface SessionStatusEvent {
  sessionId: string;
  channel?: string;
  running: boolean;
  backgroundRunning?: boolean;
}

export class SessionHolds {
  /** sessionId → channel of a held (foreground-over, background-still-live) session. */
  private held = new Map<string, string>();
  /** sessionId → owner key → that owner's hold handles. Keyed per OWNER because one session can be
   *  held by more than one thing at once (a Claude background-task continuation AND a backgrounded
   *  `agent` run); a single slot meant whichever registered second silently erased the first, so
   *  Stop could only ever reach one of them. */
  private holds = new Map<string, Map<string, SessionHoldHandles>>();

  /**
   * Mark a session background-held: its foreground turn is over but a background task keeps it
   * logically running. Optionally records the Stop (seal) handle in one call. Session id is the
   * key; an absent channel preserves the previously recorded one (status deltas may omit it).
   */
  markBackgroundHeld(sessionId: string, channel: string | null = null, handles?: SessionHoldHandles): void {
    if (!sessionId) return;
    this.held.set(sessionId, channel ?? this.held.get(sessionId) ?? '');
    if (handles) this.setHoldHandles(sessionId, HOLD_OWNER_INLINE, handles);
  }

  /** Clear a session's background hold. No-op for an unheld session.
   *
   *  Only STATUS-owning holds end here. A hold that declares `onSuperseded` is saying "my claim on
   *  this session is its busy status, and a foreground turn may take it from me" — so when the
   *  status goes, it goes. A hold that declares only `onStop` owns live WORK; its lifetime is its
   *  work's lifetime and it drops itself through `dropHoldHandles` when that settles. Erasing those
   *  here is what left Stop with nothing to call for the whole length of a foreground turn. */
  clearBackgroundHeld(sessionId: string): void {
    if (!sessionId) return;
    this.held.delete(sessionId);
    const byOwner = this.holds.get(sessionId);
    if (!byOwner) return;
    for (const [owner, handles] of [...byOwner]) {
      if (handles.onSuperseded) byOwner.delete(owner);
    }
    if (byOwner.size === 0) this.holds.delete(sessionId);
  }

  /**
   * Feed every `session.status` event through this (wired to the bus in entry/app.ts).
   * Held = running:true AND backgroundRunning:true; any other status clears the hold.
   */
  onSessionStatus(e: SessionStatusEvent): void {
    if (!e.sessionId) return;
    if (e.running && e.backgroundRunning === true) {
      this.markBackgroundHeld(e.sessionId, e.channel ?? null);
    } else {
      this.clearBackgroundHeld(e.sessionId);
    }
  }

  /** True while the session's foreground turn is over but a background task still holds it. */
  has(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** Sessions currently held anywhere. */
  listIds(): string[] {
    return [...this.held.keys()];
  }

  /** Sessions currently bg-held on a channel — the reverse lookup the channel-keyed Stop path
   * needs (`cancelChannelRuns`). Empty for an unheld/unknown channel. */
  sessionsOnChannel(channel: string): string[] {
    if (!channel) return [];
    const out: string[] = [];
    for (const [sessionId, held] of this.held) if (held === channel) out.push(sessionId);
    return out;
  }

  /** Register one owner's hold handles. Re-registering the same owner replaces its own entry and
   *  leaves every other owner's alone. */
  setHoldHandles(sessionId: string, owner: string, handles: SessionHoldHandles): void {
    if (!sessionId || !owner) return;
    let byOwner = this.holds.get(sessionId);
    if (!byOwner) this.holds.set(sessionId, byOwner = new Map());
    byOwner.set(owner, handles);
  }

  /** Drop one owner's handles (its work settled). Leaves the other owners holding the session. */
  dropHoldHandles(sessionId: string, owner: string): void {
    const byOwner = this.holds.get(sessionId);
    if (!byOwner?.delete(owner)) return;
    if (byOwner.size === 0) this.holds.delete(sessionId);
  }

  /** A new foreground turn took the session over: fire every owner's `onSuperseded`, once.
   *  `onStop` is deliberately KEPT — the work is still running and Stop must still reach it.
   *  Returns false when nothing was waiting to be superseded. */
  supersedeHolds(sessionId: string): boolean {
    const byOwner = this.holds.get(sessionId);
    if (!byOwner) return false;
    let fired = false;
    for (const [owner, handles] of [...byOwner]) {
      if (!handles.onSuperseded) continue;
      // Single-fire: drop the callback before invoking, so a seal that publishes its way back
      // through onSessionStatus cannot re-enter this loop.
      const fn = handles.onSuperseded;
      if (handles.onStop) byOwner.set(owner, { onStop: handles.onStop });
      else byOwner.delete(owner);
      fired = true;
      fn();
    }
    if (byOwner.size === 0) this.holds.delete(sessionId);
    return fired;
  }

  /** The user pressed Stop: fire every owner's `onStop` once and forget the session's handles.
   *  Returns false when the session has no live hold. */
  stopHolds(sessionId: string): boolean {
    const byOwner = this.holds.get(sessionId);
    if (!byOwner) return false;
    this.holds.delete(sessionId);
    let fired = false;
    for (const handles of byOwner.values()) {
      const fn = handles.onStop ?? handles.onSuperseded;
      if (!fn) continue;
      fired = true;
      fn();
    }
    return fired;
  }

  /** Empty the background-hold registry (tests). Does not touch running executions. */
  clear(): void {
    this.held.clear();
    this.holds.clear();
  }
}

/** Singleton instance: one server process = one hold registry. */
export const sessionHolds = new SessionHolds();
