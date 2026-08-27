// input:  project queries, shared notes resource, approvals, rate-limit and creation state
// output: mobile Projects screen with scoped note previews, approvals and settings
// pos:    Composition owner for the Projects tab
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import {
  awaitingInputCountByProject,
  unreadCountByProject,
} from '@/features/workbench/project-menu';
import { lastActivityByProject } from '@/features/workbench/left-rail-projects';
import { useSessionsLiveSync } from '@/features/workbench/useSessionsLiveSync';
import { useThreadsLiveSync } from '@/features/workbench/useThreadsLiveSync';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { MProjectView, type MProjectCopy, type MProjectViewProps } from './MProjectView';
import { threadCountsForProject, buildProjectSwitchRows, pendingApprovalCounts } from './m-project-vm';
import { MNewProjectView, type MNewProjectCopy } from './MNewProjectView';
import { useCreateProject } from '@/features/projects/useCreateProject';
import { finishMobileProjectCreation } from './m-new-project-flow';
import { MobileRateLimitSheet, useRateLimitStatus } from '@/features/rate-limit';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { useNotesResource } from '@/features/notes/useNotesResource';
import { buildMNotesVm } from './m-notes-vm';
import { useAllSessions } from '@/features/workbench/useProjectSessions';

const COPY: { en: MProjectCopy; zh: MProjectCopy } = {
  en: {
    title: 'Projects',
    current: 'Current',
    threadsRunning: 'running',
    needsYou: 'need you',
    perDay: 'day',
    week: 'Week',
    month: 'Month',
    forecastToday: 'Forecast',
    approvals: 'Approvals',
    pending: 'pending',
    globalPending: 'global',
    threadsWaiting: 'threads paused',
    handle: 'Review',
    memory: 'Project memory',
    settings: 'Settings',
    switchProject: 'SWITCH PROJECT',
    running: 'running',
    today: 'today',
    idle: 'idle',
    newProject: 'New project',
    issuesTitle: 'Issues',
  },
  zh: {
    title: '项目',
    current: '当前',
    threadsRunning: '线程运行中',
    needsYou: '需要你',
    perDay: '日',
    week: '本周',
    month: '本月',
    forecastToday: '预测今日',
    approvals: '审批',
    pending: '待处理',
    globalPending: '全局',
    threadsWaiting: '线程暂停等待',
    handle: '处理',
    memory: '项目记忆',
    settings: '设置',
    switchProject: '切换项目',
    running: '运行中',
    today: '今日',
    idle: '空闲',
    newProject: '新建项目',
    issuesTitle: 'Issues',
  },
};

const NEW_PROJECT_COPY: { en: MNewProjectCopy; zh: MNewProjectCopy } = {
  en: {
    title: 'New project',
    tag: 'projects/',
    placeholder: 'Project name, e.g. rl-locomotion',
    create: 'Create and start a chat',
  },
  zh: {
    title: '新建项目',
    tag: 'projects/',
    placeholder: '项目名字，如 rl-locomotion',
    create: '创建并开始对话',
  },
};

function useProjectQueries(projectId: string) {
  const trpc = useTRPC();
  return {
    projects: useQuery({ ...trpc.projects.list.queryOptions({}), refetchOnMount: false }).data ?? [],
    sessions: useAllSessions('direct').data ?? [],
    scopedCost: useQuery({ ...trpc.cost.summary.queryOptions({ projectId: projectId || undefined }), enabled: !!projectId }).data ?? null,
    globalCost: useQuery(trpc.cost.summary.queryOptions({})).data,
    threads: useQuery(trpc.threads.list.queryOptions({})).data ?? [],
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
    const counts = threadCountsForProject(queries.threads, projectId);
    return { id: projectId, initials: projectInitials(projectId), runningThreads: counts.running, waitingThreads: counts.waiting, needsYou: scopedApprovals, cost: queries.scopedCost };
  }, [projectId, queries.threads, scopedApprovals, queries.scopedCost]);
}

function useProjectSwitchRows(
  projectId: string,
  queries: ReturnType<typeof useProjectQueries>,
  approvalsByProject: Record<string, number>,
) {
  const unread = useMemo(() => unreadCountByProject(queries.sessions), [queries.sessions]);
  const actions = useMemo(() => awaitingInputCountByProject(queries.sessions), [queries.sessions]);
  const activity = useMemo(() => lastActivityByProject(queries.sessions), [queries.sessions]);
  return useMemo(() => buildProjectSwitchRows(
    queries.projects,
    projectId,
    queries.threads,
    queries.globalCost?.byProject,
    unread,
    activity,
    actions,
    approvalsByProject,
  ), [queries.projects, projectId, queries.threads, queries.globalCost, unread, activity, actions, approvalsByProject]);
}

function useNewProjectSheet(
  lang: 'en' | 'zh',
  navigate: ReturnType<typeof useNavigate>,
  setCurrentProject: (id: string) => void,
) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const onCreated = useCallback((id: string) => {
    finishMobileProjectCreation(id, { setCurrentProject, close, navigate });
  }, [close, navigate, setCurrentProject]);
  const create = useCreateProject({ onCreated });
  const setProjectName = useCallback((value: string) => {
    setName(value);
    create.clearError();
  }, [create.clearError]);
  const submit = useCallback(() => {
    void create.createProject(name);
  }, [create.createProject, name]);
  const show = useCallback(() => {
    setName('');
    create.clearError();
    setOpen(true);
  }, [create.clearError]);
  return {
    open,
    name,
    setName: setProjectName,
    submit,
    close,
    show,
    copy: pickCopy(lang, NEW_PROJECT_COPY),
    error: create.error,
    pending: create.isPending,
  };
}

function ProjectOverlays({ rate, rateOpen, closeRate, project }: { rate: ReturnType<typeof useRateLimitStatus>; rateOpen: boolean; closeRate: () => void; project: ReturnType<typeof useNewProjectSheet> }) {
  return (
    <>
      {rateOpen && rate && <MobileRateLimitSheet status={rate} onClose={closeRate} />}
      {project.open && <MNewProjectView name={project.name} onNameChange={project.setName} onCreate={project.submit} onClose={project.close} copy={project.copy} error={project.error} pending={project.pending} />}
    </>
  );
}

export function MProjectScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const { currentProjectId, setCurrentProject } = useCurrentProject();
  const projectId = currentProjectId ?? '';
  useSessionsLiveSync(); useThreadsLiveSync();
  const queries = useProjectQueries(projectId);
  const { notes, busy: notesBusy, add: addNote } = useNotesResource(projectId);
  const notesVm = useMemo(() => buildMNotesVm(notes, Date.now(), lang), [notes, lang]);
  // Project-attributed approval buckets: current project + 全局 (null) drive the amber bar and the
  // current card's 需要你; other projects' counts ride their switch-row badges.
  const approvalCounts = useMemo(() => pendingApprovalCounts(queries.approvals), [queries.approvals]);
  const scopedApprovals = projectId ? approvalCounts.byProject[projectId] ?? 0 : 0;
  const current = useCurrentCard(projectId, queries, scopedApprovals);
  const switchRows = useProjectSwitchRows(projectId, queries, approvalCounts.byProject);
  const rate = useRateLimitStatus();
  const [rateOpen, setRateOpen] = useState(false);
  useEffect(() => { if (!rate) setRateOpen(false); }, [rate]);
  const project = useNewProjectSheet(lang, navigate, setCurrentProject);
  const issues = useMemo(() => ({ count: queries.issues.length, previews: queries.issues.slice(0, 2).map((issue) => issue.title) }), [queries.issues]);
  const onSwitch = (id: string) => { setCurrentProject(id); navigate('/m/sessions'); };
  const viewProps: MProjectViewProps = {
    copy: pickCopy(lang, COPY), current, pendingApprovals: scopedApprovals + approvalCounts.global, globalPendingApprovals: approvalCounts.global, issues,
    notesVm, notesCopy: NOTES_COPY[lang], notesBusy, switchRows, rateLimitStatus: rate,
    onOpenRateLimit: () => setRateOpen(true), onIssues: () => navigate('/m/issues'), onNotes: () => navigate('/m/notes'), onAddNote: addNote,
    onApprovals: () => navigate('/m/approvals'), onMemory: () => navigate('/m/memory'), onSettings: () => navigate('/m/settings'), onSwitch, onNewProject: project.show,
  };
  return <><MProjectView {...viewProps} /><ProjectOverlays rate={rate} rateOpen={rateOpen} closeRate={() => setRateOpen(false)} project={project} /></>;
}
