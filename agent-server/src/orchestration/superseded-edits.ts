/**
 * Tracks channels whose current agent was superseded by a message edit.
 *
 * Usage pattern:
 *   edit-handler: supersededEdits.mark(channel)   — before killing the agent
 *   agent-lifecycle: supersededEdits.check(channel) — in the error handler
 *                    supersededEdits.clear(channel)  — after handling
 */
class SupersededEdits {
  private _set = new Set<string>();

  /** Mark a channel as superseded by an edit (called before killing the agent). */
  mark(channel: string): void {
    this._set.add(channel);
  }

  /** Returns true if the channel was marked as superseded. */
  check(channel: string): boolean {
    return this._set.has(channel);
  }

  /**
   * Unmark a channel after the supersede condition has been handled.
   * Returns true if the channel was previously marked, false if it was not.
   */
  clear(channel: string): boolean {
    return this._set.delete(channel);
  }
}

export const supersededEdits = new SupersededEdits();
