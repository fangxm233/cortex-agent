// input:  session and thread summaries grouped by project
// output: per-project running and attention counts
// pos:    shared project attention aggregation for desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SessionInfo, ThreadInfo } from '@cortex-agent/ui-contract';

const ACTIVE_THREAD_STATUSES: ReadonlySet<ThreadInfo['status']> = new Set(['running', 'waiting']);

export function runningCountByProject(threads: ThreadInfo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of threads) {
    if (ACTIVE_THREAD_STATUSES.has(t.status)) {
      counts[t.projectId] = (counts[t.projectId] ?? 0) + 1;
    }
  }
  return counts;
}

/** Unread session count per project — from an UNSCOPED sessions.list (origin='direct'), so the
 *  switcher can badge projects whose sessions got replies the user hasn't viewed. */
export function unreadCountByProject(sessions: SessionInfo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    if (s.unread) counts[s.projectId] = (counts[s.projectId] ?? 0) + 1;
  }
  return counts;
}

/** Sessions needing user action per project — pending ask-user questions or plan approvals. */
export function awaitingInputCountByProject(sessions: SessionInfo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    if (s.awaitingInput) counts[s.projectId] = (counts[s.projectId] ?? 0) + 1;
  }
  return counts;
}

export type ProjectAttentionBadgeTone = 'unread' | 'action' | null;

/** One project badge: unread + action, with action taking visual priority. */
export function projectAttentionBadge(
  unread: number,
  actionRequired: number,
): { count: number; tone: ProjectAttentionBadgeTone } {
  const count = unread + actionRequired;
  return { count, tone: actionRequired > 0 ? 'action' : count > 0 ? 'unread' : null };
}
