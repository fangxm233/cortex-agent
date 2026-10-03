import type { SessionInfo } from '@cortex-agent/ui-contract';
import { isRetiredWorker } from '@/features/team/worker-groups';
import type { RailSessionRow } from './rail-tree';

// Team mode: a lead session's row expands in place to its workers, one indent deeper — the same
// shape as a commission folder, except the folder IS a session the user can open.
//
// The lead's status dot rolls up its workers the way a commission row rolls up its members: live if
// any worker is running, amber if any is blocked on the user, a hollow ring if any is waiting on a
// machine. Unread only rolls up while the lead is collapsed — open, each worker shows its own.

export interface WorkerRollup {
  running: boolean;
  awaitingInput: boolean;
  waitingOn: boolean;
  unread: boolean;
}

export function workerRollup(workers: RailSessionRow[]): WorkerRollup {
  return {
    running: workers.some((w) => w.running),
    awaitingInput: workers.some((w) => w.awaitingInput),
    waitingOn: workers.some((w) => w.waitingOn),
    unread: workers.some((w) => w.unread),
  };
}

/** A worker's rail row: the ordinary row, flagged when retired so the tree can dim it. */
export function workerRow(s: SessionInfo, toRow: (s: SessionInfo) => RailSessionRow): RailSessionRow {
  const row = toRow(s);
  return isRetiredWorker(s) ? { ...row, retired: true } : row;
}

/** The lead's row carrying its nested workers and their rolled-up state. State rolls up from ALL
 *  workers; `shown` is what nests (a filter narrows it to the hits, and with none the row carries no
 *  nesting at all). */
export function leadRow(
  lead: RailSessionRow, all: RailSessionRow[], shown: RailSessionRow[], expanded: boolean,
): RailSessionRow {
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
