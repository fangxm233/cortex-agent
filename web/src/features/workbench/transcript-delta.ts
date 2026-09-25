import type { SessionTranscript, TranscriptMessage, TranscriptTurn } from '@cortex-agent/ui-contract';

// WHY THIS EXISTS: the transcript is the authority the live SSE tail converges onto, so every
// `session.message` / `session.turn` / decision event invalidates it and the query refetches. On a
// long session that meant re-sending — and re-rendering — the entire conversation many times a
// minute. With a cursor the server answers "here are the rows that changed", and this module turns
// that answer back into the same whole `SessionTranscript` the rest of the UI already consumes.
// Nothing downstream (transcript-vm, MessageStream) knows a delta happened.

/** One transcript row with the turn it belongs to — the flat form a delta addresses by index. */
export interface FlatTranscriptRow {
  turnIndex: number;
  message: TranscriptMessage;
}

export function flattenTurns(turns: readonly TranscriptTurn[]): FlatTranscriptRow[] {
  const rows: FlatTranscriptRow[] = [];
  for (const turn of turns) {
    for (const message of turn.messages) rows.push({ turnIndex: turn.turnIndex, message });
  }
  return rows;
}

/** Regroup flat rows into turns, preserving first-seen turn order (what the server emits). */
export function groupRows(rows: readonly FlatTranscriptRow[]): TranscriptTurn[] {
  const byTurn = new Map<number, TranscriptTurn>();
  const order: number[] = [];
  for (const row of rows) {
    let turn = byTurn.get(row.turnIndex);
    if (!turn) {
      turn = { turnIndex: row.turnIndex, messages: [] };
      byTurn.set(row.turnIndex, turn);
      order.push(row.turnIndex);
    }
    turn.messages.push(row.message);
  }
  return order.map((index) => byTurn.get(index)!);
}

/**
 * Fold a response onto the transcript already in cache.
 *
 * A response without `delta` is already whole — it is returned as is. A delta is applied by
 * position: changed rows overwrite or extend, then the list is cut to `total`, which is how a
 * rewind removes rows. Returns null when the delta cannot be applied (no cached transcript, or a
 * gap the delta does not cover); the caller must then re-read without a cursor.
 */
export function mergeTranscriptDelta(
  previous: SessionTranscript | undefined,
  response: SessionTranscript,
): SessionTranscript | null {
  const delta = response.delta;
  if (!delta) return response;
  if (!previous) return null;

  const rows = flattenTurns(previous.turns);
  for (const row of delta.changed) {
    if (row.index < 0 || row.index > rows.length) return null; // a hole we cannot fill
    rows[row.index] = { turnIndex: row.turnIndex, message: row.message };
  }
  if (delta.total > rows.length) return null; // rows we were never sent
  rows.length = delta.total;

  const { delta: _applied, ...rest } = response;
  return { ...rest, turns: groupRows(rows) };
}
