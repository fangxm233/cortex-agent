/**
 * Compatibility facade over `turn/active-turns.ts`, which now owns the "this channel's agent was
 * superseded by a message edit" flag along with the rest of the per-channel turn state (§1.2).
 *
 * Usage pattern (unchanged):
 *   edit-handler: activeTurns.markSuperseded(channel, 'edit')  — before killing the agent
 *   turn/terminal: supersededEdits.check(channel)              — in the error handler
 *                  supersededEdits.clear(channel)              — after handling
 *
 * Kept only so `turn/terminal.ts` and its tests are untouched by T2.1; Phase 4 deletes it and
 * points both at `activeTurns` directly.
 */
import { activeTurns } from './turn/active-turns.js';

export const supersededEdits = {
  /** Mark a channel as superseded by an edit (called before killing the agent). */
  mark(channel: string): void {
    activeTurns.markSuperseded(channel, 'edit');
  },

  /** Returns true if the channel was marked as superseded. */
  check(channel: string): boolean {
    return activeTurns.isSuperseded(channel, 'edit');
  },

  /**
   * Unmark a channel after the supersede condition has been handled.
   * Returns true if the channel was previously marked, false if it was not.
   */
  clear(channel: string): boolean {
    return activeTurns.clearSuperseded(channel, 'edit');
  },
};
