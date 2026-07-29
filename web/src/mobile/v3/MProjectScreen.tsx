// input:  project, notes, connectivity and rate-limit queries
// output: mobile Projects screen with quick notes and actions
// pos:    Data owner for the Projects tab
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { useMobileProject } from '@/mobile/current-project';
import { MProjectView, type MProjectCopy, type MProjectViewProps } from './MProjectView';
import { threadCountsForProject, onlineMachineCount, buildProjectSwitchRows } from './m-project-vm';
import { MNewProjectView } from './MNewProjectView';
import { canCreate, type MNewProjectCopy } from './m-new-project-vm';
import { MobileRateLimitSheet, useRateLimitStatus } from '@/features/rate-limit';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { buildMNotesVm } from './m-notes-vm';

const COPY: { en: MProjectCopy; zh: MProjectCopy } = {
  en: {
    title: 'Projects',
    daemonConnected: 'daemon connected',
    daemonConnecting: 'daemon connecting',
    daemonReconnecting: 'daemon reconnecting',
    daemonDisconnected: 'daemon disconnected',
    current: 'Current',
    threadsRunning: 'running',
    needsYou: 'need you',
    perDay: 'day',
    week: 'Week',
    month: 'Month',
    forecastToday: 'Forecast',
    approvals: 'Approvals',
    pending: 'pending',
    threadsWaiting: 'threads paused',
    handle: 'Review',
    memory: 'Project memory',
    machines: 'Machines',
    machinesOk: 'online',
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
    daemonConnected: 'daemon 已连接',
    daemonConnecting: 'daemon 连接中',
    daemonReconnecting: 'daemon 正在重连',
    daemonDisconnected: 'daemon 已断开',
    current: '当前',
    threadsRunning: '线程运行中',
    needsYou: '需要你',
    perDay: '日',
    week: '本周',
    month: '本月',
    forecastToday: '预测今日',
    approvals: '审批',
    pending: '待处理',
    threadsWaiting: '线程暂停等待',
    handle: '处理',
    memory: '项目记忆',
    machines: '机器',
    machinesOk: '台正常',
    settings: '设置',
    switchProject: '切换项目',
    running: '运行中',
    today: '今日',
    idle: '空闲',
    newProject: '新建项目',
    issuesTitle: 'Issues',
  },
};

function useProjectNotes(projectId: string, lang: 'en' | 'zh') {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery({ ...trpc.notes.list.queryOptions({ projectId }), enabled: !!projectId });
  const add = useMutation(trpc.notes.add.mutationOptions({
    onSettled: () => queryClient.invalidateQueries(trpc.notes.list.queryFilter({ projectId })),
  }));
  return {
    vm: buildMNotesVm(query.data ?? [], Date.now(), lang),
    copy: NOTES_COPY[lang],
    busy: add.isPending,
    add: (text: string) => add.mutateAsync({ projectId, text }),
  };
}

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
    projects: useQuery(trpc.projects.list.queryOptions({})).data ?? [],
    sessions: useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' })).data ?? [],
    scopedCost: useQuery({ ...trpc.cost.summary.queryOptions({ projectId: projectId || undefined }), enabled: !!projectId }).data ?? null,
    globalCost: useQuery(trpc.cost.summary.queryOptions({})).data,
    threads: useQuery(trpc.threads.list.queryOptions({})).data ?? [],
    pendingApprovals: useQuery(trpc.approvals.list.queryOptions({ status: 'pending' })).data?.length ?? 0,
    machines: useQuery(trpc.machines.list.queryOptions({})).data ?? [],
    issues: useQuery({ ...trpc.issues.list.queryOptions({ projectId }), enabled: !!projectId }).data ?? [],
  };
}

function useCurrentCard(projectId: string, queries: ReturnType<typeof useProjectQueries>) {
  return useMemo(() => {
    if (!projectId) return null;
    const counts = threadCountsForProject(queries.threads, projectId);
    return { id: projectId, initials: projectInitials(projectId), runningThreads: counts.running, waitingThreads: counts.waiting, needsYou: queries.pendingApprovals, cost: queries.scopedCost };
  }, [projectId, queries.threads, queries.pendingApprovals, queries.scopedCost]);
}

function useProjectSwitchRows(projectId: string, queries: ReturnType<typeof useProjectQueries>) {
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
  ), [queries.projects, projectId, queries.threads, queries.globalCost, unread, activity, actions]);
}

function useNewProjectSheet(lang: 'en' | 'zh', navigate: ReturnType<typeof useNavigate>) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation(trpc.projects.create.mutationOptions({ onSuccess: () => {
    queryClient.invalidateQueries(trpc.projects.list.queryFilter());
    setOpen(false);
    navigate('/m/session/new');
  } }));
  const submit = () => {
    if (!canCreate(name) || create.isPending) return;
    create.mutate({ name: name.trim() });
  };
  return { open, name, setName, submit, close: () => setOpen(false), show: () => { setName(''); setOpen(true); }, copy: pickCopy(lang, NEW_PROJECT_COPY) };
}

function ProjectOverlays({ rate, rateOpen, closeRate, project }: { rate: ReturnType<typeof useRateLimitStatus>; rateOpen: boolean; closeRate: () => void; project: ReturnType<typeof useNewProjectSheet> }) {
  return (
    <>
      {rateOpen && rate && <MobileRateLimitSheet status={rate} onClose={closeRate} />}
      {project.open && <MNewProjectView name={project.name} onNameChange={project.setName} onCreate={project.submit} onClose={project.close} copy={project.copy} />}
    </>
  );
}

export function MProjectScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const { currentProjectId, setCurrentProject } = useMobileProject();
  const projectId = currentProjectId ?? '';
  useSessionsLiveSync(); useThreadsLiveSync();
  const queries = useProjectQueries(projectId);
  const notes = useProjectNotes(projectId, lang);
  const current = useCurrentCard(projectId, queries);
  const switchRows = useProjectSwitchRows(projectId, queries);
  const connStatus = useConnectionStatus();
  const rate = useRateLimitStatus();
  const [rateOpen, setRateOpen] = useState(false);
  useEffect(() => { if (!rate) setRateOpen(false); }, [rate]);
  const project = useNewProjectSheet(lang, navigate);
  const issues = useMemo(() => ({ count: queries.issues.length, previews: queries.issues.slice(0, 2).map((issue) => issue.title) }), [queries.issues]);
  const onSwitch = (id: string) => { setCurrentProject(id); navigate('/m/sessions'); };
  const viewProps: MProjectViewProps = {
    copy: pickCopy(lang, COPY), connStatus, current, pendingApprovals: queries.pendingApprovals, issues,
    notesVm: notes.vm, notesCopy: notes.copy, notesBusy: notes.busy, onlineMachines: onlineMachineCount(queries.machines), switchRows, rateLimitStatus: rate,
    onOpenRateLimit: () => setRateOpen(true), onIssues: () => navigate('/m/issues'), onNotes: () => navigate('/m/notes'), onAddNote: notes.add,
    onApprovals: () => navigate('/m/approvals'), onMemory: () => navigate('/m/memory'), onMachines: () => navigate('/m/machines'), onSettings: () => navigate('/m/settings'), onSwitch, onNewProject: project.show,
  };
  return <><MProjectView {...viewProps} /><ProjectOverlays rate={rate} rateOpen={rateOpen} closeRate={() => setRateOpen(false)} project={project} /></>;
}
