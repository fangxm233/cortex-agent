import type { SessionInfo } from '@cortex-agent/ui-contract';
import { isRetiredWorker } from '@/features/team/worker-groups';
import { workerRollup, type WorkerRollup } from '@/features/team/worker-rollup';

// Team mode: a lead session's row expands in place to its workers, one indent deeper — the same
// shape as a commission folder, except the folder IS a session the user can open.
//
// The lead's status dot rolls up its workers (features/team/worker-rollup). Unread only rolls up
// while the lead is collapsed — open, each worker shows its own.

/** A worker's rail row: the ordinary row, flagged when retired so the tree can dim it. */
export function workerRow<R extends WorkerRollup>(s: SessionInfo, toRow: (s: SessionInfo) => R): R & { retired?: boolean } {
  const row = toRow(s);
  return isRetiredWorker(s) ? { ...row, retired: true } : row;
}

/** The lead's row carrying its nested workers and their rolled-up state. State rolls up from ALL
 *  workers; `shown` is what nests (a filter narrows it to the hits, and with none the row carries no
 *  nesting at all). */
export function leadRow<R extends WorkerRollup>(
  lead: R, all: R[], shown: R[], expanded: boolean,
): R & { workers?: R[]; workersExpanded?: boolean } {
  const up = workerRollup(all);
  const open = expanded && shown.length > 0;
  return {
    ...lead,
    running: lead.running || up.running,
    awaitingInput: lead.awaitingInput || up.awaitingInput,
    waitingOn: lead.waitingOn || up.waitingOn,
    unread: lead.unread || (!open && up.unread),
    ...(shown.length > 0 ? { workers: shown, workersExpanded: open } : {}),
  };
}
