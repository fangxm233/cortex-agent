import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
    runListHint: 'tap a run → opens that session',
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
    runListHint: '点击任意一次运行 → 打开该次会话',
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
  if (loading) {
    return (
      <MScreen label="1a 会话列表">
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
      </MScreen>
    );
  }
  const scheduled = scheduleRows.length > 0
    ? { unread: unreadScheduleCount(scheduleRows), onOpen: () => setSheet('schedule') } : undefined;
  const project = { name: switcher.currentProjectId, switchLabel: switcher.copy.switchProject, onSwitch: () => setSheet('projects') };
  return (
    <>
      <MSessionListView rows={rows} stars={stars} copy={copy} presence={presence} project={project}
        newLabel={L.wbNewSession} scheduled={scheduled}
        onOpen={(id) => navigate(`/m/session/${id}`)} onNew={() => navigate('/m/session/new')} />
      <SessionListSheets sheet={sheet} setSheet={setSheet} scheduleRows={scheduleRows} switcher={switcher} />
    </>
  );
}
