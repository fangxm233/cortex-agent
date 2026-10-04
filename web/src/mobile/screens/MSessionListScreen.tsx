import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang, useVocab } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { unreadScheduleCount, type ScheduleRow } from '@/features/session/list/schedule-rail';
import { useSessionsLiveSync } from '@/features/session/live/useSessionsLiveSync';
import { useTeamEnabled } from '@/features/team/useTeamEnabled';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';
import { MScheduleSheet, type MScheduleSheetCopy } from './MScheduleSheet';
import { buildProjectSessionList, type MSessionRow } from './m-session-list-vm';
import { useStarredGroups } from '@/features/session/list/useStarredGroups';
import { useProjectSessions } from '@/features/projects/useProjectSessions';
import { PROJECT_SWITCH_COPY } from './MProjectSwitchRows';
import { MProjectSwitchSheet } from './MProjectSwitchSheet';
import { MNewProjectSheet, useNewProjectSheet } from './useMNewProjectSheet';
import { MHomeDrawer } from './MHomeDrawer';
import { MProjectScreen } from './MProjectScreen';
import { mobileHomeView } from '@/mobile/mobile-route-manifest';
import { setProjectsPanel } from '@/mobile/mobile-navigation';

const COPY: { en: MSessionListCopy; zh: MSessionListCopy } = {
  en: { title: 'Sessions', empty: 'No sessions yet' },
  zh: { title: '会话', empty: '暂无会话' },
};

const SHEET_COPY: { en: MScheduleSheetCopy; zh: MScheduleSheetCopy } = {
  en: {
    title: 'Scheduled',
    countUnit: '{n}',
    once: 'once',
    paused: 'paused',
    nextIn: 'next in {d}',
    allRuns: 'all {n} runs',
    edit: 'Edit schedule',
    markAllRead: 'mark {n} read',
    colRun: 'RUN',
    colFired: 'FIRED',
    colCost: 'COST',
  },
  zh: {
    title: '定时任务',
    countUnit: '{n} 个',
    once: '单次',
    paused: '已暂停',
    nextIn: '{d}后运行',
    allRuns: '全部 {n} 次运行',
    edit: '编辑调度',
    markAllRead: '{n} 条标记已读',
    colRun: '运行',
    colFired: '触发',
    colCost: '费用',
  },
};

function useSessionListData(currentProjectId: string | null, lang: 'en' | 'zh') {
  const trpc = useTRPC();
  const team = useTeamEnabled();
  useSessionsLiveSync();
  const sessionsQuery = useProjectSessions(currentProjectId, 'direct');
  const scheduledQuery = useProjectSessions(currentProjectId, 'scheduled');
  const schedulesQuery = useQuery(
    trpc.schedules.list.queryOptions({ projectId: currentProjectId ?? undefined }),
  );
  const list = useMemo(
    () => buildProjectSessionList(currentProjectId, sessionsQuery.data ?? [],
      scheduledQuery.data ?? [], schedulesQuery.data ?? [], Date.now(), lang, team),
    [currentProjectId, sessionsQuery.data, scheduledQuery.data, schedulesQuery.data, lang, team],
  );
  return { loading: sessionsQuery.isLoading, ...list };
}

function useStarsProp(currentProjectId: string | null, starredRows: MSessionRow[]) {
  const stars = useStarredGroups();
  if (!currentProjectId) return undefined;
  return { projectId: currentProjectId, rows: starredRows,
    expanded: !stars.collapsed.has(currentProjectId), onToggle: () => stars.toggle(currentProjectId) };
}

type SessionSheet = 'schedule' | 'projects' | null;

function useProjectSwitcher(lang: 'en' | 'zh', setSheet: (sheet: SessionSheet) => void) {
  const navigate = useNavigate();
  const { currentProjectId, setCurrentProject } = useCurrentProject();
  const newProject = useNewProjectSheet(lang, navigate, setCurrentProject);
  const copy = pickCopy(lang, PROJECT_SWITCH_COPY);
  const close = () => setSheet(null);
  const pick = (id: string) => { setCurrentProject(id); close(); };
  const createNew = () => { close(); newProject.show(); };
  return { currentProjectId, newProject, copy, close, pick, createNew };
}

function SessionListSheets({ sheet, setSheet, scheduleRows, switcher }: {
  sheet: SessionSheet;
  setSheet: (sheet: SessionSheet) => void;
  scheduleRows: ScheduleRow[];
  switcher: ReturnType<typeof useProjectSwitcher>;
}) {
  const navigate = useNavigate();
  const sheetCopy = pickCopy(useLang(), SHEET_COPY);
  const openRun = (id: string) => { setSheet(null); navigate(`/m/session/${id}`, { replace: true }); };
  return (
    <>
      {sheet === 'schedule' && <MScheduleSheet rows={scheduleRows} copy={sheetCopy}
        onOpenSession={openRun} onClose={() => setSheet(null)} />}
      {sheet === 'projects' && <MProjectSwitchSheet currentProjectId={switcher.currentProjectId}
        copy={switcher.copy} onPick={switcher.pick} onNewProject={switcher.createNew} onClose={switcher.close} />}
      <MNewProjectSheet project={switcher.newProject} />
    </>
  );
}

// The home stays mounted under the screens opened from it, so it keeps the panel state of the last
// home route it showed rather than closing the panel behind a drill-in.
function useProjectsPanel() {
  const navigate = useNavigate();
  const view = mobileHomeView(useLocation().pathname);
  const lastOpen = useRef(view === 'projects');
  if (view !== null) lastOpen.current = view === 'projects';
  const setOpen = useCallback((open: boolean) => setProjectsPanel(open, navigate), [navigate]);
  return { open: lastOpen.current, setOpen };
}

// The panel's content is built shortly after the list, so the first swipe drags a ready panel.
function usePanelMounted(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (mounted) return;
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(true), 300);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);
  return mounted || open;
}

function usePendingApprovals(): number {
  const trpc = useTRPC();
  return useQuery(trpc.approvals.list.queryOptions({ status: 'pending' })).data?.length ?? 0;
}

function ProjectsDrawer({ panel, children }: { panel: ReturnType<typeof useProjectsPanel>; children: ReactNode }) {
  const label = pickCopy(useLang(), PANEL_LABEL);
  const mounted = usePanelMounted(panel.open);
  return (
    <MHomeDrawer open={panel.open} onOpenChange={panel.setOpen} panelLabel={label}
      panel={mounted ? <MProjectScreen /> : null}>
      {children}
    </MHomeDrawer>
  );
}

const PANEL_LABEL = { en: 'Projects', zh: '项目' };

export function MSessionListScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const L = useVocab();
  const copy = pickCopy(lang, COPY);
  const presence = useConnectionStatus();
  const [sheet, setSheet] = useState<SessionSheet>(null);
  const switcher = useProjectSwitcher(lang, setSheet);
  const { loading, rows, starredRows, scheduleRows } = useSessionListData(switcher.currentProjectId, lang);
  const stars = useStarsProp(switcher.currentProjectId, starredRows);
  const panel = useProjectsPanel();
  const needsYou = usePendingApprovals();
  if (loading) {
    return (
      <ProjectsDrawer panel={panel}>
        <MScreen label="1a 会话列表">
          <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
        </MScreen>
      </ProjectsDrawer>
    );
  }
  const scheduled = scheduleRows.length > 0
    ? { unread: unreadScheduleCount(scheduleRows), onOpen: () => setSheet('schedule') } : undefined;
  const project = { name: switcher.currentProjectId, switchLabel: switcher.copy.switchProject, onSwitch: () => setSheet('projects') };
  return (
    <ProjectsDrawer panel={panel}>
      <MSessionListView rows={rows} stars={stars} copy={copy} presence={presence} project={project}
        projects={{ needsYou, onOpen: () => panel.setOpen(true) }} newLabel={L.wbNewSession} scheduled={scheduled}
        onOpen={(id) => navigate(`/m/session/${id}`)} onNew={() => navigate('/m/session/new')} />
      <SessionListSheets sheet={sheet} setSheet={setSheet} scheduleRows={scheduleRows} switcher={switcher} />
    </ProjectsDrawer>
  );
}
