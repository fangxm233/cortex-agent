// input:  session/schedule queries, project scope, mobile navigation
// output: data-bound Sessions tab with the Scheduled sheet
// pos:    Mobile session-list data container
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
// 1a 会话列表 — the current project's direct sessions, day-grouped, newest first (scheme 1a L86-128).
// ＋ opens a new-session draft; a row drills into the chat page (1b). The header clock button
// (scheme-mobile 8a) opens the Scheduled sheet (8b/8c) — scheduled runs never mix into the day
// timeline. Real tRPC: sessions.list (direct + scheduled) and schedules.list, all project-scoped.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { buildScheduleRows, unreadScheduleCount } from '@/features/workbench/schedule-rail';
import { useSessionsLiveSync } from '@/features/workbench/useSessionsLiveSync';
import { useMobileProject } from '@/mobile/current-project';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';
import { MScheduleSheet, type MScheduleSheetCopy } from './MScheduleSheet';
import { buildSessionGroups } from './m-session-list-vm';

const COPY: { en: MSessionListCopy; zh: MSessionListCopy } = {
  en: { title: 'Sessions', today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier', empty: 'No sessions yet' },
  zh: { title: '会话', today: '今天', yesterday: '昨天', earlier: '更早', empty: '暂无会话' },
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
  },
  zh: {
    title: 'Scheduled',
    countUnit: '{n} 个',
    once: '单次',
    paused: '已暂停',
    nextIn: '{d} 后运行',
    allRuns: '全部 {n} runs',
    runListHint: '点击任意 run → 打开该次会话',
  },
};

export function MSessionListScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const sheetCopy = pickCopy(lang, SHEET_COPY);
  const { currentProjectId } = useMobileProject();

  useSessionsLiveSync();
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );
  const scheduledQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'scheduled', projectId: currentProjectId ?? undefined }),
  );
  const schedulesQuery = useQuery(
    trpc.schedules.list.queryOptions({ projectId: currentProjectId ?? undefined }),
  );
  const sessions = sessionsQuery.data ?? [];
  const groups = useMemo(() => buildSessionGroups(sessions), [sessions]);
  const scheduleRows = useMemo(
    () => buildScheduleRows(schedulesQuery.data ?? [], scheduledQuery.data ?? [], Date.now()),
    [schedulesQuery.data, scheduledQuery.data],
  );
  const scope = currentProjectId ? projectInitials(currentProjectId) : undefined;

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
        sessions={sessions}
        scope={scope}
        copy={copy}
        scheduled={
          scheduleRows.length > 0
            ? { unread: unreadScheduleCount(scheduleRows), onOpen: () => setSheetOpen(true) }
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
            navigate(`/m/session/${id}`);
          }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  );
}
