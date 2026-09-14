// input:  —
// output: —
// pos:    orchestration — a transitional re-export shell. Both halves of what this module used to
//         be now live under `turn/`: the ledger turn-tracking state machine in
//         `turn/turn-tracking.ts` (T1.2) and the terminal success/error rendering in
//         `turn/terminal.ts` (T1.3, where the `Turn` object calls it). The exports are kept
//         resolving against this path so the existing importers — `tests/orch/lifecycle-*.test.ts`,
//         `routing/edit-handler.ts`, `session-rewind.ts`, `tests/orch/turn-*.test.ts` — need no
//         change. Phase 4 deletes this file and repoints them.
export {
  handleAgentSuccess,
  handleAgentError,
  persistErrorSession,
  handleDefaultAgentResult,
} from './turn/terminal.js';

export {
  initTurnTracking,
  finishTurnTracking,
  markPendingTurnSuperseded,
  consumePendingTurnSupersession,
  isTurnTrackingPending,
  waitForTurnTracking,
  type TurnTrackingToken,
  type TurnTrackingOptions,
} from './turn/turn-tracking.js';
