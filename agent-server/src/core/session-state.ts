//
// The one answer to "is this session busy".
//
// Busy has exactly two sources: a live foreground execution (`run-registry.ts`) and a background
// hold (`session-holds.ts`). Neither knows about the other, so joining them anywhere else would
// mean two half-answers that can disagree — which is what `sessions.list`, the compact gate and
// the engine-busy gate used to do. Every reader comes here instead
// (plan/orchestration-turn-refactor.md §1.2).
//
// `core` is L0: this file may only read the two singletons beside it.

import { runRegistry } from './run-registry.js';
import { sessionHolds } from './session-holds.js';

/** One session's busy snapshot: the single answer to "is this session busy". */
export interface SessionState {
  /** True when a foreground turn is live OR a background task still holds the session. */
  running: boolean;
  /** True when the foreground turn is over but a background task still holds the session. */
  backgroundRunning: boolean;
  /** Live agent-turn count of the in-flight foreground run; null when absent / not yet reported. */
  numTurns: number | null;
  /** Execution id of the live foreground run; null when none. */
  executionId: string | null;
}

/**
 * The single answer to "is this session busy": the running execution snapshot (foreground) plus
 * the background-hold flag. `running` stays true while a background hold is active, matching
 * sessions.list's `running = inTurn || bgHeld`. Thread executions are excluded from the
 * foreground lookup (a thread step beside its parent does not make the session itself busy).
 */
export function sessionState(sessionId: string): SessionState {
  const exec = runRegistry.getForegroundBySessionId(sessionId);
  const backgroundRunning = sessionHolds.has(sessionId);
  return {
    running: !!exec || backgroundRunning,
    backgroundRunning,
    numTurns: exec?.numTurns ?? null,
    executionId: exec?.executionId ?? null,
  };
}

/**
 * True while a command aimed at this channel's pooled engine is unsafe: a live turn or a
 * background hold on `sessionId` (the engine serves that session), OR any other run registered on
 * the channel. The channel-wide half is not redundant — the conversation, edit-retry,
 * auto-compound and subagent paths all open with `engineKey === channel`, so a second run on the
 * same channel is a second user of the same pooled process.
 */
export function channelEngineBusy(channel: string, sessionId: string): boolean {
  return runRegistry.hasChannel(channel) || sessionState(sessionId).running;
}

/** The narrow shape `sessions.list` joins on, so the ui-service deps bag can be handed the answer
 *  rather than a whole registry (and tests can still inject a scripted one). */
export interface SessionStateReader {
  sessionState(sessionId: string): SessionState;
}

/** Production reader: the join over the two live singletons. */
export const sessionStates: SessionStateReader = { sessionState };
