import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { teamRoster } from '@/features/team/worker-roster';

// What both live surfaces — the dock's strip and the chat's status bar — say about a board's bound
// sessions. One selector, so the two never disagree about who is waiting on the user.

/** Bound sessions in display order: leads first, then workers attention-first; retired workers
 *  have nothing left to report and are left out. */
export function stripSessions(sessions: SessionInfo[]): SessionInfo[] {
  const leads = sessions.filter((s) => !s.teamLeadId);
  return [...teamRoster(leads).active, ...teamRoster(sessions.filter((s) => !!s.teamLeadId)).active];
}

export interface BoardSummary {
  /** Sessions worth showing, in order. */
  shown: SessionInfo[];
  /** Those waiting on the user. */
  pending: SessionInfo[];
  /** Sessions still running or waiting (they keep going after the board closes). */
  live: number;
}

export function boardSummary(sessions: SessionInfo[]): BoardSummary {
  const shown = stripSessions(sessions);
  return {
    shown,
    pending: shown.filter((s) => s.awaitingInput),
    live: sessions.filter((s) => s.running || s.awaitingInput).length,
  };
}

export type BoardFlagTone = 'ask' | 'active' | 'closed';

/** The flag's tone: amber while anyone waits on the user, else accent while open, muted once closed. */
export function boardFlagTone(status: BoardInfo['status'], pendingCount: number): BoardFlagTone {
  if (pendingCount > 0) return 'ask';
  return status === 'active' ? 'active' : 'closed';
}

export const BOARD_FLAG_COLOR: Record<BoardFlagTone, string> = {
  ask: 'var(--proto-amber)',
  active: 'var(--proto-accent)',
  closed: 'var(--proto-muted)',
};
