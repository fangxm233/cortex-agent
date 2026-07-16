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
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { useMobileProject } from '@/mobile/current-project';
import { MProjectView, type MProjectCopy } from './MProjectView';
import { threadCountsForProject, onlineMachineCount, buildProjectSwitchRows } from './m-project-vm';

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
  },
};

export function MProjectScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const { currentProjectId, setCurrentProject } = useMobileProject();

  const projectsQuery = useQuery(trpc.projects.list.queryOptions({}));
  const scopedCostQuery = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: currentProjectId ?? undefined }),
    enabled: !!currentProjectId,
  });
  const globalCostQuery = useQuery(trpc.cost.summary.queryOptions({}));
  const threadsQuery = useQuery(trpc.threads.list.queryOptions({}));
  const approvalsQuery = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));

  const projects = projectsQuery.data ?? [];
  const threads = threadsQuery.data ?? [];
  const machines = machinesQuery.data ?? [];
  const pendingApprovals = approvalsQuery.data?.length ?? 0;
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

  const switchRows = useMemo(
    () => buildProjectSwitchRows(projects, currentProjectId, threads, globalCostQuery.data?.byProject),
    [projects, currentProjectId, threads, globalCostQuery.data],
  );

  return (
    <MProjectView
      copy={copy}
      connected={connected}
      current={current}
      pendingApprovals={pendingApprovals}
      onlineMachines={onlineMachines}
      switchRows={switchRows}
      onApprovals={() => navigate('/m/approvals')}
      onMemory={() => navigate('/m/memory')}
      onMachines={() => navigate('/m/machines')}
      onSettings={() => navigate('/m/settings')}
      onSwitch={(id) => {
        setCurrentProject(id);
        navigate('/m/sessions');
      }}
      onNewProject={() => navigate('/m/new-project')}
    />
  );
}
