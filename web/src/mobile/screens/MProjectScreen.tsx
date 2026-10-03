import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/session/list/session-groups';
import { useSessionsLiveSync } from '@/features/session/live/useSessionsLiveSync';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { MProjectView, type MProjectCopy, type MProjectViewProps } from './MProjectView';
import type { UsageNavState } from './MUsageScreen';
import { pendingApprovalCounts } from './m-project-vm';
import { PROJECT_SWITCH_COPY } from './MProjectSwitchRows';
import { useProjectSwitchRows } from './useMProjectSwitch';
import { MNewProjectSheet, useNewProjectSheet, type NewProjectSheet } from './useMNewProjectSheet';
import { MobileRateLimitSheet, useRateLimitStatus } from '@/features/rate-limit';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { useNotesResource } from '@/features/notes/useNotesResource';
import { buildMNotesVm } from './m-notes-vm';
import { useAllSessions } from '@/features/projects/useProjectSessions';

const COPY: { en: MProjectCopy; zh: MProjectCopy } = {
  en: {
    ...PROJECT_SWITCH_COPY.en,
    title: 'Projects',
    current: 'Current',
    needsYou: 'need you',
    perDay: 'day',
    week: 'Week',
    month: 'Month',
    forecastToday: 'Forecast',
    approvals: 'Approvals',
    pending: 'pending',
    globalPending: 'global',
    handle: 'Review',
    memory: 'Project memory',
    usage: 'Usage',
    settings: 'Settings',
    issuesTitle: 'Issues',
  },
  zh: {
    ...PROJECT_SWITCH_COPY.zh,
    title: '项目',
    current: '当前',
    needsYou: '需要你',
    perDay: '日',
    week: '本周',
    month: '本月',
    forecastToday: '预测今日',
    approvals: '审批',
    pending: '待处理',
    globalPending: '全局',
    handle: '处理',
    memory: '项目记忆',
    usage: '用量',
    settings: '设置',
    issuesTitle: '问题',
  },
};

function useProjectQueries(projectId: string) {
  const trpc = useTRPC();
  return {
    projects: useQuery({ ...trpc.projects.list.queryOptions({}), refetchOnMount: false }).data ?? [],
    sessions: useAllSessions('direct').data ?? [],
    scopedCost: useQuery({ ...trpc.cost.summary.queryOptions({ projectId: projectId || undefined }), enabled: !!projectId }).data ?? null,
    globalCost: useQuery(trpc.cost.summary.queryOptions({})).data,
    approvals: useQuery(trpc.approvals.list.queryOptions({ status: 'pending' })).data ?? [],
    issues: useQuery({ ...trpc.issues.list.queryOptions({ projectId }), enabled: !!projectId }).data ?? [],
  };
}

function useCurrentCard(
  projectId: string,
  queries: ReturnType<typeof useProjectQueries>,
  scopedApprovals: number,
) {
  return useMemo(() => {
    if (!projectId) return null;
    return { id: projectId, initials: projectInitials(projectId), needsYou: scopedApprovals, cost: queries.scopedCost };
  }, [projectId, scopedApprovals, queries.scopedCost]);
}

function ProjectOverlays({ rate, rateOpen, closeRate, project }: { rate: ReturnType<typeof useRateLimitStatus>; rateOpen: boolean; closeRate: () => void; project: NewProjectSheet }) {
  return (
    <>
      {rateOpen && rate && <MobileRateLimitSheet status={rate} onClose={closeRate} />}
      <MNewProjectSheet project={project} />
    </>
  );
}

function useRateLimitSheet() {
  const rate = useRateLimitStatus();
  const [rateOpen, setRateOpen] = useState(false);
  useEffect(() => { if (!rate) setRateOpen(false); }, [rate]);
  return { rate, rateOpen, setRateOpen };
}

export function MProjectScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const { currentProjectId, setCurrentProject } = useCurrentProject();
  const projectId = currentProjectId ?? '';
  useSessionsLiveSync();
  const queries = useProjectQueries(projectId);
  const { notes, busy: notesBusy, add: addNote } = useNotesResource(projectId);
  const notesVm = useMemo(() => buildMNotesVm(notes, Date.now(), lang), [notes, lang]);
  // Project-attributed approval buckets: current project + 全局 (null) drive the amber bar and the
  // current card's 需要你; other projects' counts ride their switch-row badges.
  const approvalCounts = useMemo(() => pendingApprovalCounts(queries.approvals), [queries.approvals]);
  const scopedApprovals = projectId ? approvalCounts.byProject[projectId] ?? 0 : 0;
  const current = useCurrentCard(projectId, queries, scopedApprovals);
  const switchRows = useProjectSwitchRows(projectId, {
    projects: queries.projects, sessions: queries.sessions,
    globalByProject: queries.globalCost?.byProject, approvalsByProject: approvalCounts.byProject,
  });
  const { rate, rateOpen, setRateOpen } = useRateLimitSheet();
  const project = useNewProjectSheet(lang, navigate, setCurrentProject);
  const issues = useMemo(() => ({ count: queries.issues.length, previews: queries.issues.slice(0, 2).map((issue) => issue.title) }), [queries.issues]);
  const onSwitch = (id: string) => { setCurrentProject(id); navigate('/m/sessions'); };
  const viewProps: MProjectViewProps = {
    copy: pickCopy(lang, COPY), current, pendingApprovals: scopedApprovals + approvalCounts.global, globalPendingApprovals: approvalCounts.global, issues,
    notesVm, notesCopy: NOTES_COPY[lang], notesBusy, switchRows, rateLimitStatus: rate,
    onOpenRateLimit: () => setRateOpen(true), onIssues: () => navigate('/m/issues'), onNotes: () => navigate('/m/notes'), onAddNote: addNote,
    onApprovals: () => navigate('/m/approvals'), onMemory: () => navigate('/m/memory'),
    onUsage: () => navigate('/m/settings/usage', { state: { from: 'project' } satisfies UsageNavState }), onSettings: () => navigate('/m/settings'), onSwitch, onNewProject: project.show,
  };
  return <><MProjectView {...viewProps} /><ProjectOverlays rate={rate} rateOpen={rateOpen} closeRate={() => setRateOpen(false)} project={project} /></>;
}
