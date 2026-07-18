// input:  session.status event payloads ({ sessionId, running, backgroundRunning? })
// output: BgHeldSessions / bgHeldSessions singleton — queryable snapshot of web bg-held sessions
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
 *  running:true AND backgroundRunning:true; any other status event clears it. */
export class BgHeldSessions {
  private held = new Set<string>();

  /** Feed every `session.status` event through this (wired to the bus in entry/app.ts). */
  onSessionStatus(e: { sessionId: string; running: boolean; backgroundRunning?: boolean }): void {
    if (!e.sessionId) return;
    if (e.running && e.backgroundRunning === true) this.held.add(e.sessionId);
    else this.held.delete(e.sessionId);
  }

  /** True while the session's foreground turn is over but a background task still holds it. */
  has(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** Empty the registry (tests). */
  clear(): void {
    this.held.clear();
  }
}

/** Singleton instance (one server process = one registry). */
export const bgHeldSessions = new BgHeldSessions();
