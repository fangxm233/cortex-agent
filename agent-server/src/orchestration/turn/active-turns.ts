// input:  the Turn objects opening and closing on each conduit
// output: the per-channel answer to "is a turn live here, and which one"
// pos:    orchestration/turn — the registry half of §1.2's busy-state consolidation. Today it is
//         only a ledger of live Turns: the streaming-callback slot, `supersededEdits` and the
//         turn-tracking Maps still live where they were, and `edit-handler` / `session-rewind` /
//         `mid-turn-inject` still read them. T2.1 moves those readers onto this map; keeping the
//         registration separate from the move means a bug in either half is attributable.

/** What a live turn exposes to the rest of orchestration. Deliberately structural (not the `Turn`
 *  class) so this module has no import edge back into `turn.ts`. */
export interface ActiveTurnHandle {
  readonly channel: string;
  /** The tracking id of the session this turn runs under, or null for a session-less turn. */
  readonly sessionId: string | null;
}

class ActiveTurns {
  private readonly byChannel = new Map<string, ActiveTurnHandle>();

  /** Called by the Turn at step 2 (once its ledger tracking is open). A second turn on the same
   *  channel replaces the first: the channel queue admits one turn at a time, and a supersede
   *  hands the channel over rather than sharing it. */
  register(channel: string, turn: ActiveTurnHandle): void {
    this.byChannel.set(channel, turn);
  }

  /** Called by the Turn at step 12. Scoped to the registering turn so a turn that outlives its
   *  successor's registration cannot erase it on the way out. */
  unregister(channel: string, turn: ActiveTurnHandle): void {
    if (this.byChannel.get(channel) === turn) this.byChannel.delete(channel);
  }

  get(channel: string): ActiveTurnHandle | null {
    return this.byChannel.get(channel) ?? null;
  }

  has(channel: string): boolean {
    return this.byChannel.has(channel);
  }

  /** Test seam — no production path clears the whole map. */
  _reset(): void {
    this.byChannel.clear();
  }
}

export const activeTurns = new ActiveTurns();
