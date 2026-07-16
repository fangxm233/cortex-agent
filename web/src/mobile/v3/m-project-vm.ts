// Pure view-model for the 1e 项目 screen (scheme-mobile.dc.html 1e L286-352). The 项目 tab shows the
// CURRENT project's info + a switcher to the other projects. `projects.list` (ProjectConduitInfo)
// carries no name/phase/cost — the id IS the display name and avatar (projectInitials). Real signals:
//   · per-project thread counts from an UNSCOPED threads.list (ThreadInfo has projectId + status);
//   · per-project today $ from the GLOBAL cost.summary byProject bucket (PeriodBucket.today);
//   · online-machine count from machines.list (MachineInfo.online).
// GAPs (never fabricated): approvals have NO projectId (ApprovalInfo) → the "需要你" / 待处理 count is
// GLOBAL, not project-scoped; phase/milestone (Phase 2 · M2.3) have no DTO source → omitted.
import type { ThreadInfo, ProjectConduitInfo, CostSummary } from '@cortex-agent/ui-contract';
import { projectInitials } from '@/features/workbench/session-groups';

/**
 * Strict per-project thread counts scoped to the current project. `线程运行中` = status 'running';
 * `线程暂停等待` = status 'waiting'. Kept separate (the scheme distinguishes them) rather than the
 * desktop `runningCountByProject`, which folds running+waiting into one number.
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
    if (t.status === 'running') running++;
    else if (t.status === 'waiting') waiting++;
  }
  return { running, waiting };
}

/** Online (`N 台正常`) machine count — real `MachineInfo.online` boolean, no multi-state guess. */
export function onlineMachineCount(machines: readonly { online: boolean }[]): number {
  return machines.reduce((n, m) => n + (m.online ? 1 : 0), 0);
}

export interface MProjectSwitchRow {
  /** Project id == display name (ProjectConduitInfo carries no `name`). */
  id: string;
  /** Avatar initials from the id (`atlas` → `AT`). */
  initials: string;
  /** Real running-thread count for this project (status 'running'). */
  running: number;
  /** Real today $ from the global cost summary's byProject bucket; null when the project has no
   *  bucket (honest — never a fabricated $0). */
  todayCost: number | null;
  /** Unread direct-session count for this project (0 = none). Drives the switcher badge + ordering
   *  — mirrors the desktop ProjectMenu (buildSwitchList). */
  unread: number;
}

/**
 * The OTHER projects (projects.list minus the current one), each with a real running-thread count
 * and today $ from the GLOBAL cost.summary byProject map. Projects with UNREAD sessions sort first
 * (stable — projects.list order preserved within each half), mirroring the desktop `buildSwitchList`.
 * `unreadCounts` comes from `unreadCountByProject` over an UNSCOPED direct sessions.list. Per-project
 * approval / needs-you counts are NOT derivable (ApprovalInfo has no projectId) → deliberately absent.
 */
export function buildProjectSwitchRows(
  projects: ProjectConduitInfo[],
  currentId: string | null,
  threads: ThreadInfo[],
  globalByProject: CostSummary['byProject'] | undefined,
  unreadCounts: Record<string, number> = {},
): MProjectSwitchRow[] {
  return projects
    .filter((p) => p.id !== currentId)
    .map((p) => {
      const running = threads.reduce(
        (n, t) => n + (t.projectId === p.id && t.status === 'running' ? 1 : 0),
        0,
      );
      const bucket = globalByProject?.[p.id];
      return {
        id: p.id,
        initials: projectInitials(p.id),
        running,
        todayCost: bucket ? bucket.today : null,
        unread: unreadCounts[p.id] ?? 0,
      };
    })
    .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0));
}
