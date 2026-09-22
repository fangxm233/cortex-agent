// 1a 会话列表 — the current project's direct sessions, day-grouped, newest first (scheme 1a L86-128).
// The FAB opens a new-session draft; a row drills into the chat page (1b). The header clock button
// (scheme-mobile 8a) opens the Scheduled sheet (8b/8c) — scheduled runs never mix into the day
// timeline. Real tRPC: sessions.list (direct + scheduled), schedules.list and the pending-approval
// count behind the banner, all project-scoped.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang, useVocab } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { buildScheduleRows, unreadScheduleCount } from '@/features/workbench/schedule-rail';
import { useSessionsLiveSync } from '@/features/workbench/useSessionsLiveSync';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';
import { MScheduleSheet, type MScheduleSheetCopy } from './MScheduleSheet';
import { buildSessionGroups } from './m-session-list-vm';
import { useProjectSessions } from '@/features/projects/useProjectSessions';

const COPY: { en: MSessionListCopy; zh: MSessionListCopy } = {
  en: {
    title: 'Sessions',
    today: 'Today',
    yesterday: 'Yesterday',
    earlier: 'Earlier',
    empty: 'No sessions yet',
    sessionCount: '{n} sessions',
    approvalsPending: '{n} approvals pending',
  },
  zh: {
    title: '会话',
    today: '今天',
    yesterday: '昨天',
    earlier: '更早',
    empty: '暂无会话',
    sessionCount: '{n} 个会话',
    approvalsPending: '{n} 个待审批',
  },
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
  },
  zh: {
    title: 'Scheduled',
    countUnit: '{n} 个',
    once: '单次',
    paused: '已暂停',
    nextIn: '{d} 后运行',
    allRuns: '全部 {n} runs',
    runListHint: '点击任意 run → 打开该次会话',
    edit: '编辑调度',
    markAllRead: '{n} 条标记已读',
  },
};

export function MSessionListScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const L = useVocab();
  const copy = pickCopy(lang, COPY);
  const sheetCopy = pickCopy(lang, SHEET_COPY);
  const { currentProjectId } = useCurrentProject();
  const presence = useConnectionStatus();

  useSessionsLiveSync();
  const sessionsQuery = useProjectSessions(currentProjectId, 'direct');
  const scheduledQuery = useProjectSessions(currentProjectId, 'scheduled');
  const schedulesQuery = useQuery(
    trpc.schedules.list.queryOptions({ projectId: currentProjectId ?? undefined }),
  );
  // Same query key MobileShell runs for the Tab badge → this shares its cache, not a second fetch.
  const approvalsQuery = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const sessions = sessionsQuery.data ?? [];
  const groups = useMemo(() => buildSessionGroups(sessions), [sessions]);
  const scheduleRows = useMemo(
    () => buildScheduleRows(schedulesQuery.data ?? [], scheduledQuery.data ?? [], Date.now()),
    [schedulesQuery.data, scheduledQuery.data],
  );
  const approvalCount = approvalsQuery.data?.length ?? 0;

  const [sheetOpen, setSheetOpen] = useState(false);

  if (sessionsQuery.isLoading) {
    return (
      <MScreen label="1a 会话列表">
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
      </MScreen>
    );
  }

  return (
    <>
      <MSessionListView
        groups={groups}
        copy={copy}
        presence={presence}
        newLabel={L.wbNewSession}
        scheduled={
          scheduleRows.length > 0
            ? { unread: unreadScheduleCount(scheduleRows), onOpen: () => setSheetOpen(true) }
            : undefined
        }
        approvals={
          approvalCount > 0
            ? { count: approvalCount, onOpen: () => navigate('/m/approvals') }
            : undefined
        }
        onOpen={(id) => navigate(`/m/session/${id}`)}
        onNew={() => navigate('/m/session/new')}
      />
      {sheetOpen && (
        <MScheduleSheet
          rows={scheduleRows}
          copy={sheetCopy}
          onOpenSession={(id) => {
            setSheetOpen(false);
            navigate(`/m/session/${id}`, { replace: true });
          }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  );
}
