import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CostSummary, ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import {
  awaitingInputCountByProject,
  unreadCountByProject,
} from '@/features/session/list/project-menu';
import { lastActivityByProject } from '@/features/session/list/left-rail-projects';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { buildProjectSwitchRows, pendingApprovalCounts, type MProjectSwitchRow } from './m-project-vm';

const EMPTY: never[] = [];

export interface ProjectSwitchSources {
  projects: ProjectConduitInfo[];
  /** Unscoped direct sessions: unread, awaiting-input and last-activity signals per project. */
  sessions: SessionInfo[];
  globalByProject: CostSummary['byProject'] | undefined;
  approvalsByProject: Record<string, number>;
}

/** Switch rows for every project except `currentId` (pass null to keep them all). */
export function useProjectSwitchRows(currentId: string | null, sources: ProjectSwitchSources): MProjectSwitchRow[] {
  const { projects, sessions, globalByProject, approvalsByProject } = sources;
  const unread = useMemo(() => unreadCountByProject(sessions), [sessions]);
  const actions = useMemo(() => awaitingInputCountByProject(sessions), [sessions]);
  const activity = useMemo(() => lastActivityByProject(sessions), [sessions]);
  return useMemo(() => buildProjectSwitchRows(
    projects, currentId, globalByProject, unread, activity, actions, approvalsByProject,
  ), [projects, currentId, globalByProject, unread, activity, actions, approvalsByProject]);
}

/** Self-fetching rows for the project switcher sheet: the current project apart, the rest by activity. */
export function useProjectSwitchSheetRows(currentId: string | null): {
  current: MProjectSwitchRow | null;
  others: MProjectSwitchRow[];
} {
  const trpc = useTRPC();
  const projects = useQuery({ ...trpc.projects.list.queryOptions({}), refetchOnMount: false }).data;
  const sessions = useAllSessions('direct').data;
  const globalCost = useQuery(trpc.cost.summary.queryOptions({})).data;
  const approvals = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' })).data;
  const approvalsByProject = useMemo(() => pendingApprovalCounts(approvals ?? []).byProject, [approvals]);
  const rows = useProjectSwitchRows(null, {
    projects: projects ?? EMPTY, sessions: sessions ?? EMPTY,
    globalByProject: globalCost?.byProject, approvalsByProject,
  });
  return useMemo(() => ({
    current: rows.find((row) => row.id === currentId) ?? null,
    others: rows.filter((row) => row.id !== currentId),
  }), [rows, currentId]);
}
