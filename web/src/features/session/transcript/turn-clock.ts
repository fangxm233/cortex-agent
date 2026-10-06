import type { SessionTranscript } from '@cortex-agent/ui-contract';
import type { LiveSessionMessage } from './live-message';

// The current turn's clock, and the snapshot + delta resolution of a session's live status facts.

export function turnCount(transcript: SessionTranscript | undefined | null): number {
  return transcript?.turns.length ?? 0;
}

/** Wall-clock bounds of the CURRENT turn: its opening message → its newest message. */
export interface TurnClock {
  startMs: number;
  lastMs: number;
}

/**
 * The current turn's clock, from the last transcript turn merged with the live tail.
 *
 * The tail matters because the transcript refetch lags the event stream: a turn that has just opened
 * exists only in the tail for a moment, and a running clock read from the transcript alone would
 * count from the PREVIOUS turn's start until the refetch lands. Every main-agent user message opens a
 * turn — the same rule the server cuts turns by — so the newest one in the tail wins over an older
 * transcript start. Subagent rows never open a turn.
 *
 * Measured as a span and NOT a sum of per-message `elapsedMs`: the backend's compact projection folds
 * every subagent row into a summary and drops that row's delta with it, so a sum silently loses all
 * the wall-clock the agent spent waiting on its children. A span cannot lose time.
 */
export function currentTurnClock(
  transcript: SessionTranscript | undefined | null,
  liveTail: readonly LiveSessionMessage[] = [],
): TurnClock | null {
  let startMs: number | null = null;
  let lastMs: number | null = null;
  const messages = transcript?.turns.at(-1)?.messages ?? [];
  if (messages.length > 0) {
    const first = Date.parse(messages[0].ts);
    const last = Date.parse(messages[messages.length - 1].ts);
    if (Number.isFinite(first) && Number.isFinite(last)) {
      startMs = first;
      lastMs = Math.max(first, last);
    }
  }
  for (const m of liveTail) {
    if (m.subagentId) continue;
    const t = Date.parse(m.ts);
    if (!Number.isFinite(t)) continue;
    if (m.role === 'user' && (startMs == null || t > startMs)) {
      startMs = t;
      lastMs = Math.max(lastMs ?? t, t);
    } else if (startMs != null && lastMs != null && t > lastMs) {
      lastMs = t;
    }
  }
  return startMs == null || lastMs == null ? null : { startMs, lastMs };
}

/**
 * Elapsed of the current turn. Pass `now` only while the turn runs: the clock then keeps counting
 * between messages instead of freezing at the newest one. A settled turn is its message span, and one
 * with no span (a lone opening message) is null so the caller renders an honest `—`.
 */
export function turnClockElapsedMs(clock: TurnClock | null, now: number | null): number | null {
  if (!clock) return null;
  if (now == null) return clock.lastMs > clock.startMs ? clock.lastMs - clock.startMs : null;
  return Math.max(clock.lastMs, now) - clock.startMs;
}

/**
 * Snapshot + delta running resolution. Precedence:
 *   1. `statusRunning` — the live `session.status` event (delta), authoritative once received;
 *   2. `snapshotRunning` — the sessions.list `running` snapshot, restores state on mount /
 *      session switch / page reload / SSE reconnect before any event arrives;
 *   3. `streaming` — the message-stream idle heuristic, last resort for servers whose
 *      sessions.list carries no `running` field yet.
 */
export function resolveRunning(
  statusRunning: boolean | null,
  snapshotRunning: boolean | undefined,
  streaming: boolean,
): boolean {
  return statusRunning ?? snapshotRunning ?? streaming;
}

/**
 * Snapshot + delta background-hold resolution (mirrors resolveRunning). Precedence:
 *   1. `statusBackground` — derived from the live `session.status` event (running &&
 *      backgroundRunning), authoritative once any status event was received (null before);
 *   2. `snapshotBackground` — the sessions.list `backgroundRunning` snapshot, restores the
 *      Background state on mount / session switch / reload / app restart;
 *   3. false — old servers whose sessions.list carries no `backgroundRunning` field.
 */
export function resolveBackgroundRunning(
  statusBackground: boolean | null,
  snapshotBackground: boolean | undefined,
): boolean {
  return statusBackground ?? snapshotBackground ?? false;
}

/**
 * Snapshot + delta resolution for the composer's REAL agent-turn count. Precedence:
 *   1. `liveTurns` — the live `session.turn` event (delta), authoritative once received (a real 0 wins);
 *   2. `snapshotTurns` — the sessions.list `numTurns` snapshot, restores the count on mount / session
 *      switch / reload before any event arrives;
 *   3. `null` — unknown (a running turn before its first progress event, or a session that never ran).
 */
export function resolveTurns(liveTurns: number | null, snapshotTurns: number | null | undefined): number | null {
  return liveTurns ?? snapshotTurns ?? null;
}
