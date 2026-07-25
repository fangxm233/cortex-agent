// input:  session.status event payloads ({ sessionId, channel, running, backgroundRunning? })
// output: BgHeldSessions / bgHeldSessions singleton — queryable snapshot of web bg-held sessions
//         (+ their channel and abort handle, so the channel-keyed Stop path can reach them)
// pos:    core/ zero-dependency state registry (sibling of running-executions.ts)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Why this exists: the web bg-hold (orch/web-bg-hold.ts) keeps a session logically running
// (running:true, backgroundRunning:true) AFTER its foreground execution has completed and left
// runningExecutions. That state used to live only in the `session.status` event stream (delta),
// so any client that wasn't subscribed at publish time — a session switch, a page reload, an app
// restart — lost it, and sessions.list reported the session idle. This registry mirrors the event
// stream in memory (entry/app.ts subscribes it to the bus) so sessions.list can serve it as the
// queryable snapshot (snapshot + delta, same pattern as SessionInfo.running). In-memory is the
// correct persistence level: the held background task lives inside the server's agent process and
// dies with a server restart, so an empty registry after boot is the truth.

/** Mirrors the `session.status` delta: a session is held while its last status event said
 *  running:true AND backgroundRunning:true; any other status event clears it.
 *
 *  Also carries the hold's CHANNEL and its abort handle, because the Stop path needs both. Stop
 *  (`sessions.cancel` → cancelChannelRuns) is channel-keyed and used to look only at
 *  `runningExecutions` — but a bg-held session has already left that registry (the execution is
 *  torn down BEFORE the hold is installed), so Stop found nothing and silently did nothing while
 *  the UI still showed the button. The channel index gives the channel-keyed cancel path a way to
 *  find the hold, and the abort handle lets it seal the hold immediately. */
export class BgHeldSessions {
  private held = new Map<string, string>();      // sessionId → channel
  private aborts = new Map<string, () => void>(); // sessionId → seal the hold (Stop)

  /** Feed every `session.status` event through this (wired to the bus in entry/app.ts). */
  onSessionStatus(e: { sessionId: string; channel?: string; running: boolean; backgroundRunning?: boolean }): void {
    if (!e.sessionId) return;
    if (e.running && e.backgroundRunning === true) {
      this.held.set(e.sessionId, e.channel ?? this.held.get(e.sessionId) ?? '');
    } else {
      this.held.delete(e.sessionId);
      this.aborts.delete(e.sessionId);
    }
  }

  /** True while the session's foreground turn is over but a background task still holds it. */
  has(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** Sessions currently bg-held on a channel — the reverse lookup the channel-keyed Stop path
   *  needs (`cancelChannelRuns`). Empty for an unheld/unknown channel. */
  sessionsOnChannel(channel: string): string[] {
    if (!channel) return [];
    const out: string[] = [];
    for (const [sessionId, held] of this.held) if (held === channel) out.push(sessionId);
    return out;
  }

  /** Register the hold's abort (seal) handle — called by the hold itself via agent-runner. */
  setAbort(sessionId: string, abort: () => void): void {
    if (!sessionId) return;
    this.aborts.set(sessionId, abort);
  }

  /** Fire the registered abort once (Stop during a bg hold). Returns false when the session has
   *  no live hold. Single-fire: the handle is dropped before invoking, and the seal's own
   *  `running:false` publish clears the rest of the entry through `onSessionStatus`. */
  abort(sessionId: string): boolean {
    const fn = this.aborts.get(sessionId);
    if (!fn) return false;
    this.aborts.delete(sessionId);
    fn();
    return true;
  }

  /** Empty the registry (tests). */
  clear(): void {
    this.held.clear();
    this.aborts.clear();
  }
}

/** Singleton instance (one server process = one registry). */
export const bgHeldSessions = new BgHeldSessions();
