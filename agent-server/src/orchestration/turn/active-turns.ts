// input:  the Turn objects opening and closing on each conduit, the streaming callback a turn
//         registers, and the edit that supersedes one
// output: the per-channel answer to "is a turn live here, what does it stream through, and was it
//         taken over by an edit"
// pos:    orchestration/turn — the channel-keyed half of §1.2's busy-state consolidation, the
//         counterpart of core/session-holds.ts (which is session-keyed). Before T2.1 the same
//         three facts lived in three places: RunRegistry's streaming slot, `superseded-edits.ts`
//         and this ledger. Both of those are gone (T4.1): the edit flag and the streaming slot are
//         the ones kept here, and their readers — `turn/terminal.ts`, `routing/edit-handler.ts`,
//         `routing/hook-bridge-subscribers.ts`, `interactions/interaction-handlers.ts` — call this
//         class directly.
//
//         NOT merged: turn-tracking's three module Maps. The supersede-while-pending window they
//         guard is timing-sensitive (`consumePendingTurnSupersession` runs between ledger begin
//         and the busy bracket) and folding their keys into this map buys nothing the delegating
//         methods below do not. They stay in `turn-tracking.ts`; this class is their one door.

import {
  isTurnTrackingPending, markPendingTurnSuperseded, waitForTurnTracking,
} from './turn-tracking.js';

/** What a live turn exposes to the rest of orchestration. Deliberately structural (not the `Turn`
 *  class) so this module has no import edge back into `turn.ts`. */
export interface ActiveTurnHandle {
  readonly channel: string;
  /** The tracking id of the session this turn runs under, or null for a session-less turn. */
  readonly sessionId: string | null;
}

/** The per-channel `onAssistantMessage` callback the hook bridge forwards streaming text to.
 *  Carries an optional `.stream` handle (the durable output stream) that hook-bridge-subscribers
 *  reaches for, so the slot stores the callback object as given. */
export type StreamingCallback = (text: string) => void;

/** Why a channel's turn was taken over. Only edits mark one today: the edit path kills the run
 *  before its replacement starts, and the dying turn's error handler needs to know a cancellation
 *  was deliberate rather than a failure to report. */
export type SupersedeReason = 'edit';

class ActiveTurns {
  private readonly byChannel = new Map<string, ActiveTurnHandle>();
  /** channel → the streaming callback of the work currently writing to that channel. Deliberately
   *  NOT scoped to a registered turn: a background-continuation hold keeps streaming into the same
   *  reply after its turn has unregistered, and the hold's seal is what clears the slot. */
  private readonly streaming = new Map<string, StreamingCallback>();
  /** Channels whose current agent was superseded by a message edit. Channel-keyed, not turn-keyed,
   *  for the same reason: it is marked while the old turn is being killed and read by that turn's
   *  terminal handler, which may run after the replacement turn has claimed the channel. */
  private readonly superseded = new Map<string, SupersedeReason>();

  // ── the live turn ────────────────────────────────────────────────────────

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

  // ── the streaming slot ───────────────────────────────────────────────────

  /** Register the active onAssistantMessage callback for a channel (the Turn does this while
   *  building its agent callbacks). */
  setStreamingCallback(channel: string, cb: StreamingCallback): void {
    this.streaming.set(channel, cb);
  }

  /** The callback the channel's live text should be streamed through, if any. */
  streamingCallback(channel: string): StreamingCallback | null {
    return this.streaming.get(channel) ?? null;
  }

  /** Clear the channel's streaming callback unconditionally. Low-level: prefer
   *  `releaseStreamingCallback` from anything that registered a slot of its own. */
  clearStreamingCallback(channel: string): void {
    this.streaming.delete(channel);
  }

  /** Give up a slot the caller registered (turn end, or background-hold seal), scoped to the
   *  registered callback exactly as `unregister` is scoped to the registering turn. A hold's seal
   *  can land AFTER the next turn claimed the channel — supersede fires the old hold's seal from
   *  inside the new turn's `beginForegroundSession` — and an unscoped delete would then erase the
   *  successor's slot, silently cutting its streaming, mid-turn injection and interaction reads.
   *  Returns whether the slot was still the caller's. */
  releaseStreamingCallback(channel: string, cb: StreamingCallback): boolean {
    if (this.streaming.get(channel) !== cb) return false;
    this.streaming.delete(channel);
    return true;
  }

  // ── supersede by edit ────────────────────────────────────────────────────

  /** The edit path marks the channel before killing the agent, so the resulting cancellation is
   *  rendered as a supersede rather than an error. */
  markSuperseded(channel: string, reason: SupersedeReason): void {
    this.superseded.set(channel, reason);
  }

  /** True when this channel's current agent was superseded for `reason`. */
  isSuperseded(channel: string, reason: SupersedeReason): boolean {
    return this.superseded.get(channel) === reason;
  }

  /** Unmark the channel once the supersede has been handled. Returns whether it was marked. */
  clearSuperseded(channel: string, reason: SupersedeReason): boolean {
    if (this.superseded.get(channel) !== reason) return false;
    this.superseded.delete(channel);
    return true;
  }

  // ── ledger turn tracking (delegated to turn-tracking.ts) ─────────────────

  /** True while a turn on this channel is between "ledger begin" and "backend registered" — the
   *  window the edit and rewind paths must not rewrite the ledger under. */
  trackingPending(channel: string): boolean {
    return isTurnTrackingPending(channel);
  }

  /** Tell the turn currently opening on this channel that it has already been replaced; it stops
   *  at step 3 instead of starting a run. */
  markTrackingSuperseded(channel: string): void {
    markPendingTurnSuperseded(channel);
  }

  /** Resolve once the channel's in-flight tracking operation has settled. */
  waitForTracking(channel: string): Promise<void> {
    return waitForTurnTracking(channel);
  }

  /** Test seam — no production path clears the whole map. */
  _reset(): void {
    this.byChannel.clear();
    this.streaming.clear();
    this.superseded.clear();
  }
}

export const activeTurns = new ActiveTurns();
