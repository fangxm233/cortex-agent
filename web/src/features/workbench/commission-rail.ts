// input:  CommissionInfo/SessionInfo DTOs
// output: one rail row per commission, carrying its member sessions and rolled-up signal
// pos:    COMMISSION rail-section view model (project → commission → session, DR-0037)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { CommissionInfo, SessionInfo } from '@cortex-agent/ui-contract';

// DR-0037: a commission groups the sessions of one long-horizon task. Unlike a schedule row (one
// row per schedule, runs hidden behind a modal), a commission row EXPANDS in place — its sessions
// are the user's actual work and belong in the tree, one indent deeper.
//
// Membership is by SessionInfo.commissionId, and only for ids that resolve to a known commission.
// An unresolved id (registry pruned, list scoped to another project) must leave its session in the
// project's flat list rather than divert it into a row that does not exist — a session that belongs
// to nothing visible would otherwise disappear from the rail entirely.

export interface CommissionRow {
  commissionId: string;
  projectId: string;
  commission: CommissionInfo;
  title: string;
  status: 'active' | 'done' | 'abandoned';
  /** Member sessions, latest-first. */
  sessions: SessionInfo[];
  latest: SessionInfo | null;
  unread: boolean;
  /** Any member session blocked on the user — the row's amber gate marker. */
  awaitingInput: boolean;
  running: boolean;
}

function effectiveMs(s: SessionInfo): number {
  const t = Date.parse(s.lastUsedAt || s.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Row activity for ordering: latest member session, else the registry's own updatedAt (a
 *  just-approved commission has no session activity yet but must not sink to the bottom). */
function rowMs(row: CommissionRow): number {
  if (row.latest) return effectiveMs(row.latest);
  const t = Date.parse(row.commission.updatedAt || row.commission.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Open work outranks finished work regardless of recency — a commission closed an hour ago must
 *  not sit above the one still running. */
function statusRank(status: CommissionRow['status']): number {
  return status === 'active' ? 0 : 1;
}

export function buildCommissionRows(
  commissions: CommissionInfo[],
  sessions: SessionInfo[],
): CommissionRow[] {
  const byCommission = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.commissionId) continue;
    const list = byCommission.get(s.commissionId) ?? [];
    list.push(s);
    byCommission.set(s.commissionId, list);
  }
  for (const list of byCommission.values()) list.sort((a, b) => effectiveMs(b) - effectiveMs(a));

  const rows = commissions.map((commission) => {
    const members = byCommission.get(commission.id) ?? [];
    return {
      commissionId: commission.id,
      projectId: commission.projectId,
      commission,
      title: commission.title.trim() || commission.slug,
      status: commission.status,
      sessions: members,
      latest: members[0] ?? null,
      unread: members.some((s) => !!s.unread),
      awaitingInput: members.some((s) => !!s.awaitingInput),
      running: members.some((s) => !!s.running),
    };
  });

  return rows.sort((a, b) => statusRank(a.status) - statusRank(b.status) || rowMs(b) - rowMs(a));
}

/** The set of session ids the rail has diverted into commission rows — the caller drops these from
 *  the project's flat session list so a session never renders twice. */
export function commissionSessionIds(rows: CommissionRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) for (const s of row.sessions) ids.add(s.sessionId);
  return ids;
}

/** Collapsed-header「m 未读」badge: unread ROWS (commissions), not unread sessions. */
export function unreadCommissionCount(rows: CommissionRow[]): number {
  return rows.filter((r) => r.unread).length;
}
