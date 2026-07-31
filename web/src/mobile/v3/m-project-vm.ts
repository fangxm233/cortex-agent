// Pure view-model for the 1e 项目 screen (scheme-mobile.dc.html 1e L286-352). The 项目 tab shows the
// CURRENT project's info + a switcher to the other projects. `projects.list` (ProjectConduitInfo)
// carries no name/phase/cost — the id IS the display name and avatar (projectInitials). Real signals:
//   · per-project thread counts from an UNSCOPED threads.list (ThreadInfo has projectId + status);
//   · per-project today $ from the GLOBAL cost.summary byProject bucket (PeriodBucket.today);
//   · online-machine count from machines.list (MachineInfo.online).
//   · per-project pending approvals from ApprovalInfo.projectId (the `Project` bullet); null
//     attribution = 全局 (legacy/system entries), bucketed by pendingApprovalCounts.
// GAP (never fabricated): phase/milestone (Phase 2 · M2.3) have no DTO source → omitted.
import type { ThreadInfo, ProjectConduitInfo, CostSummary } from '@cortex-agent/ui-contract';
import { projectInitials } from '@/features/workbench/session-groups';
import { sortProjectsByActivity } from '@/features/workbench/left-rail-projects';
import {
  projectAttentionBadge,
  type ProjectAttentionBadgeTone,
} from '@/features/workbench/project-menu';

const ACTIVE_THREAD_STATUSES: ReadonlySet<ThreadInfo['status']> = new Set(['running', 'waiting']);

/**
 * Per-project active thread counts. `running` folds 'running' + 'waiting' (parity with the desktop
 * `runningCountByProject`). `waiting` is kept for the approval bar's "threads paused" label.
 */
export function threadCountsForProject(
  threads: ThreadInfo[],
  projectId: string | null,
): { running: number; waiting: number } {
  let running = 0;
  let waiting = 0;
  if (!projectId) return { running, waiting };
  for (const t of threads) {
    if (t.projectId !== projectId) continue;
    if (ACTIVE_THREAD_STATUSES.has(t.status)) running++;
    if (t.status === 'waiting') waiting++;
  }
  return { running, waiting };
}

/** Online (`N 台正常`) machine count — real `MachineInfo.online` boolean, no multi-state guess. */
export function onlineMachineCount(machines: readonly { online: boolean }[]): number {
  return machines.reduce((n, m) => n + (m.online ? 1 : 0), 0);
}

export interface PendingApprovalCounts {
  /** Pending count per owning project (`ApprovalInfo.projectId`). */
  byProject: Record<string, number>;
  /** Pending entries with NO project attribution (legacy / system-level) — rendered as 全局. */
  global: number;
  total: number;
}

/**
 * Bucket pending approvals by their real `projectId` (the `- **Project**:` bullet). `null`
 * attribution → the `global` bucket — honest, never guessed onto the current project.
 */
export function pendingApprovalCounts(
  entries: readonly { status: string; projectId: string | null }[],
): PendingApprovalCounts {
  const counts: PendingApprovalCounts = { byProject: {}, global: 0, total: 0 };
  for (const e of entries) {
    if (e.status !== 'pending') continue;
    counts.total++;
    if (e.projectId == null) counts.global++;
    else counts.byProject[e.projectId] = (counts.byProject[e.projectId] ?? 0) + 1;
  }
  return counts;
}

export interface MProjectSwitchRow {
  /** Project id == display name (ProjectConduitInfo carries no `name`). */
  id: string;
  /** Avatar initials from the id (`atlas` → `AT`). */
  initials: string;
  /** Active thread count for this project (status 'running' + 'waiting', parity with desktop). */
  running: number;
  /** Real today $ from the global cost summary's byProject bucket; null when the project has no
   *  bucket (honest — never a fabricated $0). */
  todayCost: number | null;
  /** Unread direct-session count for this project. */
  unread: number;
  /** Action items: sessions blocked on ask-user/plan input + this project's pending approvals. */
  actionRequired: number;
  /** Combined unread + action count shown in the single switch-row badge. */
  badgeCount: number;
  /** Action takes the amber tone; unread-only stays run blue. */
  badgeTone: ProjectAttentionBadgeTone;
}

/**
 * The OTHER projects (projects.list minus the current one), each with a real running-thread count
 * and today $ from the GLOBAL cost.summary byProject map. Rows are ordered by MOST RECENT ACTIVITY
 * (parity with the desktop LeftRail — sortProjectsByActivity over `lastActivity`), so the project you
 * touched last floats to the top; projects with no known activity sink to the bottom in stable order.
 * `lastActivity` comes from `lastActivityByProject` over an UNSCOPED direct sessions.list — the same
 * persistent session-registry signal the desktop rail uses, so the order survives server/app restarts.
 * `unreadCounts` still contributes to each row's attention badge but no longer drives ordering.
 * Session actions come from SessionInfo.awaitingInput; `approvalCounts` (pendingApprovalCounts
 * byProject — approvals are project-attributed now) folds into the same action side of the badge.
 */
export function buildProjectSwitchRows(
  projects: ProjectConduitInfo[],
  currentId: string | null,
  threads: ThreadInfo[],
  globalByProject: CostSummary['byProject'] | undefined,
  unreadCounts: Record<string, number> = {},
  lastActivity: Record<string, number> = {},
  actionCounts: Record<string, number> = {},
  approvalCounts: Record<string, number> = {},
): MProjectSwitchRow[] {
  const others = projects.filter((p) => p.id !== currentId);
  return sortProjectsByActivity(others, lastActivity).map((p) => {
    const running = threads.reduce(
      (n, t) => n + (t.projectId === p.id && ACTIVE_THREAD_STATUSES.has(t.status) ? 1 : 0),
      0,
    );
    const bucket = globalByProject?.[p.id];
    const unread = unreadCounts[p.id] ?? 0;
    const actionRequired = (actionCounts[p.id] ?? 0) + (approvalCounts[p.id] ?? 0);
    const badge = projectAttentionBadge(unread, actionRequired);
    return {
      id: p.id,
      initials: projectInitials(p.id),
      running,
      todayCost: bucket ? bucket.today : null,
      unread,
      actionRequired,
      badgeCount: badge.count,
      badgeTone: badge.tone,
    };
  });
}
