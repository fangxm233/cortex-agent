// Pacing math for the smooth reveal of streamed assistant text (desktop center chat).
//
// The backend hands the browser token-level deltas, but the CLI upstream of it batches them: measured
// against a real 4689-character reply, 51 deltas of ~92 characters (median 90, max 131) arrived every
// ~350ms (median 361, p90 412) — an effective 2.9 updates per second, each landing about a line at a
// time. Appending each delta whole therefore reads as a staircase rather than as writing. Every
// character is already in the browser when it is drawn; this module only decides HOW MUCH of the
// received buffer to show on a given frame.
//
// The rule, in one line: reveal at `backlog / one source interval`, so the reveal runs about one
// interval behind arrival and never drifts further behind as the reply grows.
//
//   • below the catch-up knee (two chunks) the rate is proportional to the backlog — a self-correcting
//     control whose steady state settles just under the knee at the measured cadence;
//   • above the knee the drain window shrinks in proportion to the overshoot, making the rate grow
//     with the SQUARE of the backlog, so a burst is worked off in a few frames instead of decaying
//     slowly. The faster the source runs, the tighter the lag in wall-clock terms;
//   • a floor keeps the last characters of a block from crawling out on the exponential tail;
//   • beyond the hard bound nothing is paced at all — the whole buffer is shown in one step. That is
//     the case a session switch, a rewind or a backgrounded tab (no rAF, so no frames) lands in.
//
// The revealed string is ALWAYS a prefix of what has arrived: this is pacing, never prediction.
// Pure and frame-agnostic — the caller supplies the elapsed time, so it is unit-testable without a
// DOM (the vitest env here is `node`).

/** Mean characters per text delta, measured against the real CLI. */
export const SOURCE_CHUNK_CHARS = 92;
/** Mean gap between text deltas, measured against the real CLI (2.9 updates/second). */
export const SOURCE_INTERVAL_MS = 350;

/** Backlog above which the reveal is falling behind and accelerates to catch up (two chunks). */
export const CATCHUP_BACKLOG_CHARS = 2 * SOURCE_CHUNK_CHARS;

/**
 * Hard lag bound. A backlog this large is not pacing, it is a queue — it is revealed in one step.
 * Normal streaming settles near the catch-up knee, so this is ~5x above the steady state and is only
 * reached discontinuously: switching into a session whose reply is already long, returning to a
 * backgrounded tab, or a reconnect delivering a whole block at once.
 */
export const SNAP_BACKLOG_CHARS = 8 * SOURCE_CHUNK_CHARS;

/**
 * Rate floor. Proportional pacing alone decays exponentially, so the last handful of characters
 * would trickle out ever more slowly; below this rate the reveal is lifted back onto the floor.
 */
export const MIN_CHARS_PER_SEC = 120;

/**
 * How many characters may be shown after `dtMs` more milliseconds, given `revealed` already shown of
 * `total` received. Fractional by design — flooring per frame would systematically lose the
 * remainder and drag the reveal slower than the rule says; `revealedText` floors once, at the slice.
 *
 * The result is never greater than `total`, so the caller can never display a character that has not
 * arrived, and never less than a clamped `revealed`, so the text cannot visibly un-write itself.
 */
export function stepReveal(revealed: number, total: number, dtMs: number): number {
  // A buffer that shrank (a new block, a rewind) clamps down to what actually exists.
  if (!(dtMs > 0) || revealed >= total) return Math.min(revealed, total);

  const backlog = total - revealed;
  if (backlog >= SNAP_BACKLOG_CHARS) return total;

  // One source interval to drain what is waiting; shorter, in proportion to the overshoot, once the
  // backlog passes the knee. Continuous at the knee — the reveal accelerates, it does not jump.
  const drainMs = backlog <= CATCHUP_BACKLOG_CHARS
    ? SOURCE_INTERVAL_MS
    : (SOURCE_INTERVAL_MS * CATCHUP_BACKLOG_CHARS) / backlog;

  const charsPerMs = Math.max(backlog / drainMs, MIN_CHARS_PER_SEC / 1000);
  return Math.min(revealed + charsPerMs * dtMs, total);
}

/**
 * How much of the revealed prefix survives when the buffer is replaced. A buffer that EXTENDS the
 * previous one keeps its progress (the ordinary case: another delta landed). Anything else — a new
 * block, a rewind, a different session's preview — restarts at zero, because the characters already
 * on screen are not a prefix of the new buffer and showing them would be prediction, not pacing.
 */
export function carryReveal(prevText: string, nextText: string, revealed: number): number {
  if (!nextText.startsWith(prevText)) return 0;
  return Math.min(Math.max(0, revealed), nextText.length);
}

/**
 * The revealed count to adopt when the row re-renders against a possibly different buffer.
 *
 * Within one stream this is just `carryReveal`. A change of stream IDENTITY — the reader switched
 * sessions — settles instead: whatever has accumulated is shown at once, because it is not new to
 * whoever just switched in, and because pacing it onward from the previous session's progress would
 * be that session's reveal state bleeding into this one. Comparing identity rather than content
 * makes that impossible even when two replies happen to start with the same words.
 */
export function rebaseReveal(
  prev: { streamKey?: string; text: string; revealed: number },
  next: { streamKey?: string; text: string },
): number {
  if (prev.streamKey !== next.streamKey) return next.text.length;
  return carryReveal(prev.text, next.text, prev.revealed);
}

/** The string to draw: the first `revealed` (floored) characters of the buffer, never more. */
export function revealedText(text: string, revealed: number): string {
  const n = Math.floor(revealed);
  if (!(n > 0)) return '';
  return n >= text.length ? text : text.slice(0, n);
}
