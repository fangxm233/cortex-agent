import type { SessionInfo } from '@cortex-agent/ui-contract';
import { teamRoster, workerState } from '@/features/team/worker-roster';

// What both live surfaces — the dock's strip and the chat's status bar — say about a board's bound
// sessions. One selector, so the two never disagree about who is waiting on the user.

/** Bound sessions in display order: leads first, then workers attention-first; inactive workers
 *  have nothing left to report and are left out. */
export function stripSessions(sessions: SessionInfo[]): SessionInfo[] {
  const leads = sessions.filter((s) => !s.teamLeadId);
  return [...teamRoster(leads).active, ...teamRoster(sessions.filter((s) => !!s.teamLeadId)).active];
}

export interface BoardSummary {
  /** Sessions worth showing, in order. */
  shown: SessionInfo[];
  /** Those waiting on the user — never a worker, whose questions go to its lead. */
  pending: SessionInfo[];
}

export function boardSummary(sessions: SessionInfo[]): BoardSummary {
  const shown = stripSessions(sessions);
  return {
    shown,
    pending: shown.filter((s) => workerState(s) === 'you'),
  };
}

export type BoardFlagTone = 'ask' | 'active';

/** The flag's tone: amber while anyone waits on the user, else accent. */
export function boardFlagTone(pendingCount: number): BoardFlagTone {
  return pendingCount > 0 ? 'ask' : 'active';
}

export const BOARD_FLAG_COLOR: Record<BoardFlagTone, string> = {
  ask: 'var(--proto-amber)',
  active: 'var(--proto-accent)',
};
