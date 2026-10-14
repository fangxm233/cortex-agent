import type { SessionInfo } from '@cortex-agent/ui-contract';

// Team mode: a lead's status rolls up its workers —
// live if any worker is running, amber if any is blocked on the user, a hollow ring if any is
// waiting on a machine (or on its lead), unread if any has news. The desktop rail and the mobile
// session list both read it from here.

/** The status a lead rolls up from its workers. Rows are typed by this structural slice rather than
 *  a list's own row type, so each list can use these helpers without an import cycle. */
export interface WorkerRollup {
  running: boolean;
  awaitingInput: boolean;
  waitingOn: boolean;
  unread: boolean;
}

/** One session's share of a roll-up, in the rail's dot language. A worker blocked on its lead is
 *  not progressing and not blocked on the user, so it counts as waiting, not running. */
export function sessionRollup(s: SessionInfo): WorkerRollup {
  const onLead = (s.waitingOnLead ?? 0) > 0;
  return {
    running: !!s.running && !onLead,
    awaitingInput: !!s.awaitingInput,
    waitingOn: (s.waitingOn ?? 0) > 0 || onLead,
    unread: !!s.unread,
  };
}

export function workerRollup(workers: WorkerRollup[]): WorkerRollup {
  return {
    running: workers.some((w) => w.running),
    awaitingInput: workers.some((w) => w.awaitingInput),
    waitingOn: workers.some((w) => w.waitingOn),
    unread: workers.some((w) => w.unread),
  };
}
