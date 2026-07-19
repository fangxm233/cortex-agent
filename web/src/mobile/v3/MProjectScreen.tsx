// 1e 项目 — the current project's info + the project switcher (scheme-mobile.dc.html 1e L286-352).
// The 项目 tab owns the global scope: switching a project re-points 会话/线程/任务 (via useMobileProject)
// and lands on the sessions tab. Real tRPC: projects.list, cost.summary (scoped + global), threads.list
// (unscoped → per-project counts), approvals.list (pending), machines.list.
//
// REAL-vs-GAP field map (honest):
//  · Header daemon status  → connected = projects.list did not error (a successful query implies the
//    daemon is reachable). GAP: no dedicated health probe surfaced here (system.daemonStatus exists but
//    isn't wired into this tab) — inferred, not measured.
//  · Current name/avatar   → REAL: project id (ProjectConduitInfo has no display name) + projectInitials.
//  · 线程运行中 / 线程暂停等待 → REAL: threads.list filtered by projectId + status (running / waiting).
//  · N 需要你 / 审批 · N 待处理 → GLOBAL pending-approval count. GAP: ApprovalInfo has no projectId, so
//    this cannot be scoped to the current project — it is the system-wide pending count.
//  · Phase 2 · M2.3         → OMITTED. GAP: no DTO source (not fabricated).
//  · Budget row today/week/month/dailyBudget/forecastToday → REAL cost.summary fields (scoped by
//    projectId). GAP caveat: dailyBudget is the global budget.json cap, not per-project (by contract).
//  · 机器 · N 台正常         → REAL: machines.list online count (MachineInfo.online).
//  · Switcher per-project running → REAL (threads.list); 今日 $ → REAL global cost.summary byProject
//    bucket; null-safe (omitted, never a fabricated $0). Per-project 需要你 → OMITTED (see approvals GAP).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { unreadCountByProject } from '@/features/workbench/project-menu';
import { lastActivityByProject } from '@/features/workbench/left-rail-projects';
import { useSessionsLiveSync } from '@/features/workbench/useSessionsLiveSync';
import { useMobileProject } from '@/mobile/current-project';
import { MProjectView, type MProjectCopy } from './MProjectView';
import { threadCountsForProject, onlineMachineCount, buildProjectSwitchRows } from './m-project-vm';
import { MNewProjectView } from './MNewProjectView';
import { canCreate, type MNewProjectCopy } from './m-new-project-vm';

const COPY: { en: MProjectCopy; zh: MProjectCopy } = {
  en: {
    title: 'Projects',
    daemonConnected: 'daemon connected',
    daemonDisconnected: 'daemon offline',
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
    newProjectHint: 'Just a name — init happens in chat',
    footer: 'Tap a row to switch: sessions / runs / tasks re-scope, chat lands on the latest.',
    issuesTitle: 'Issues',
  },
  zh: {
    title: '项目',
    daemonConnected: 'daemon 已连接',
    daemonDisconnected: 'daemon 未连接',
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
    newProjectHint: '只填名字，初始化在对话里做',
    footer: '点行即切换：会话 / 运行 / 任务同步换到该项目，会话落到最近一条',
    issuesTitle: 'Issues',
  },
};

const NEW_PROJECT_COPY: { en: MNewProjectCopy; zh: MNewProjectCopy } = {
  en: {
    title: 'New project',
    tag: 'projects/',
    placeholder: 'Project name, e.g. rl-locomotion',
    hintA: 'Only creates ',
    hintB: ' and an empty CORTEX.md — mission, templates, and budget are initialized by the agent via ',
    hintC: ' in the first conversation',
    create: 'Create and start a chat',
  },
  zh: {
    title: '新建项目',
    tag: 'projects/',
    placeholder: '项目名字，如 rl-locomotion',
    hintA: '只创建 ',
    hintB: ' 和空 CORTEX.md — mission、模板、预算在第一次对话里由 agent 通过 ',
    hintC: ' 初始化',
    create: '创建并开始对话',
  },
};

export function MProjectScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const { currentProjectId, setCurrentProject } = useMobileProject();

  useSessionsLiveSync();
  const projectsQuery = useQuery(trpc.projects.list.queryOptions({}));
  // UNSCOPED direct sessions (all projects) → per-project unread counts for the switcher badge +
  // unread-first ordering. Kept fresh by useSessionsLiveSync (same as the desktop LeftRail).
  const allSessionsQuery = useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' }));
  const scopedCostQuery = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: currentProjectId ?? undefined }),
    enabled: !!currentProjectId,
  });
  const globalCostQuery = useQuery(trpc.cost.summary.queryOptions({}));
  const threadsQuery = useQuery(trpc.threads.list.queryOptions({}));
  const approvalsQuery = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));
  // Issues (design sec-24 24a): the current project's ISSUES.md entries — the card is hidden at 0.
  const issuesQuery = useQuery({
    ...trpc.issues.list.queryOptions({ projectId: currentProjectId ?? '' }),
    enabled: !!currentProjectId,
  });

  const projects = projectsQuery.data ?? [];
  const threads = threadsQuery.data ?? [];
  const machines = machinesQuery.data ?? [];
  const pendingApprovals = approvalsQuery.data?.length ?? 0;
  const issueEntries = issuesQuery.data ?? [];
  const issues = useMemo(
    () => ({ count: issueEntries.length, previews: issueEntries.slice(0, 2).map((i) => i.title) }),
    [issueEntries],
  );
  const onlineMachines = onlineMachineCount(machines);
  // Honest daemon signal: a successful projects query implies the daemon answered.
  const connected = !projectsQuery.isError;

  const current = useMemo(() => {
    if (!currentProjectId) return null;
    const counts = threadCountsForProject(threads, currentProjectId);
    return {
      id: currentProjectId,
      initials: projectInitials(currentProjectId),
      runningThreads: counts.running,
      waitingThreads: counts.waiting,
      needsYou: pendingApprovals,
      cost: scopedCostQuery.data ?? null,
    };
  }, [currentProjectId, threads, pendingApprovals, scopedCostQuery.data]);

  const unreadCounts = useMemo(
    () => unreadCountByProject(allSessionsQuery.data ?? []),
    [allSessionsQuery.data],
  );
  // Persistent recency signal (session-registry lastUsedAt) → most-recently-active projects first.
  const lastActivity = useMemo(
    () => lastActivityByProject(allSessionsQuery.data ?? []),
    [allSessionsQuery.data],
  );
  const switchRows = useMemo(
    () =>
      buildProjectSwitchRows(
        projects,
        currentProjectId,
        threads,
        globalCostQuery.data?.byProject,
        unreadCounts,
        lastActivity,
      ),
    [projects, currentProjectId, threads, globalCostQuery.data, unreadCounts, lastActivity],
  );

  // ── new-project bottom sheet (inline overlay, same pattern as profile picker in MChatScreen) ──
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const newProjectCopy = pickCopy(lang, NEW_PROJECT_COPY);

  const createProject = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.projects.list.queryFilter());
        setNewProjectOpen(false);
        navigate('/m/session/new');
      },
    }),
  );

  const submitNewProject = () => {
    if (!canCreate(newProjectName) || createProject.isPending) return;
    createProject.mutate({ name: newProjectName.trim() });
  };

  return (
    <>
      <MProjectView
        copy={copy}
        connected={connected}
        current={current}
        pendingApprovals={pendingApprovals}
        issues={issues}
        onlineMachines={onlineMachines}
        switchRows={switchRows}
        onIssues={() => navigate('/m/issues')}
        onApprovals={() => navigate('/m/approvals')}
        onMemory={() => navigate('/m/memory')}
        onMachines={() => navigate('/m/machines')}
        onSettings={() => navigate('/m/settings')}
        onSwitch={(id) => {
          setCurrentProject(id);
          navigate('/m/sessions');
        }}
        onNewProject={() => { setNewProjectName(''); setNewProjectOpen(true); }}
      />
      {newProjectOpen && (
        <MNewProjectView
          name={newProjectName}
          onNameChange={setNewProjectName}
          onCreate={submitNewProject}
          onClose={() => setNewProjectOpen(false)}
          copy={newProjectCopy}
        />
      )}
    </>
  );
}
