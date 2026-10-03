// Pure view-model for the 1e 项目 screen (scheme-mobile.dc.html 1e L286-352). The 项目 tab shows the
// CURRENT project's info + a switcher to the other projects. `projects.list` (ProjectConduitInfo)
// carries no name/phase/cost — the id IS the display name and avatar (projectInitials). Real signals:
//   · per-project today $ from the GLOBAL cost.summary byProject bucket (PeriodBucket.today);
//   · online-machine count from machines.list (MachineInfo.online).
//   · per-project pending approvals from ApprovalInfo.projectId (the `Project` bullet); null
//     attribution = 全局 (legacy/system entries), bucketed by pendingApprovalCounts.
// GAP (never fabricated): phase/milestone (Phase 2 · M2.3) have no DTO source → omitted.
import type { ProjectConduitInfo, CostSummary } from '@cortex-agent/ui-contract';
import { projectInitials } from '@/features/session/list/session-groups';
import { sortProjectsByActivity } from '@/features/session/list/left-rail-projects';
import {
  emptyCounts,
  projectAttentionBadge,
  type ProjectAttentionBadgeTone,
} from '@/features/session/list/project-menu';

/** Online (`N 台正常`) machine count — real `MachineInfo.online` boolean, no multi-state guess. */
export function onlineMachineCount(machines: readonly { online: boolean }[]): number {
  return machines.reduce((n, m) => n + (m.online ? 1 : 0), 0);
}

export interface PendingApprovalCounts {
  /** Pending count per owning project (`ApprovalInfo.projectId`). */
  byProject: Record<string, number>;
  /** Pending entries with NO project attribution (legacy / system-level) — rendered as 全局. */
  global: number;
}

/**
 * Bucket pending approvals by their real `projectId` (the `- **Project**:` bullet). `null`
 * attribution → the `global` bucket — honest, never guessed onto the current project.
 */
export function pendingApprovalCounts(
  entries: readonly { status: string; projectId: string | null }[],
): PendingApprovalCounts {
  const counts: PendingApprovalCounts = { byProject: emptyCounts(), global: 0 };
  for (const e of entries) {
    if (e.status !== 'pending') continue;
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
  /** Real today $ from the global cost summary's byProject bucket; null when the project has no
   *  bucket (honest — never a fabricated $0). */
  todayCost: number | null;
  /** Unread direct-session count plus action items (sessions blocked on ask-user/plan input + this
   *  project's pending approvals), shown in the single switch-row badge. */
  badgeCount: number;
  /** Action takes the amber tone; unread-only stays run blue. */
  badgeTone: ProjectAttentionBadgeTone;
}

/**
 * The OTHER projects (projects.list minus the current one), each with today $ from the GLOBAL cost.summary byProject map. Rows are ordered by MOST RECENT ACTIVITY
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
  globalByProject: CostSummary['byProject'] | undefined,
  unreadCounts: Record<string, number> = {},
  lastActivity: Record<string, number> = {},
  actionCounts: Record<string, number> = {},
  approvalCounts: Record<string, number> = {},
): MProjectSwitchRow[] {
  const others = projects.filter((p) => p.id !== currentId);
  return sortProjectsByActivity(others, lastActivity).map((p) => {
    const bucket = globalByProject?.[p.id];
    const unread = unreadCounts[p.id] ?? 0;
    const actionRequired = (actionCounts[p.id] ?? 0) + (approvalCounts[p.id] ?? 0);
    const badge = projectAttentionBadge(unread, actionRequired);
    return {
      id: p.id,
      initials: projectInitials(p.id),
      todayCost: bucket ? bucket.today : null,
      badgeCount: badge.count,
      badgeTone: badge.tone,
    };
  });
}
