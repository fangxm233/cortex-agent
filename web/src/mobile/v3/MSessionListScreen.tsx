// 1a 会话列表 — the current project's direct sessions, day-grouped, newest first (scheme 1a L86-128).
// ＋ opens a new-session draft (lazy-create on first send, mirroring the desktop draft flow); a row
// drills into the chat page (1b). Real tRPC: sessions.list(origin='direct', scoped to the current
// project). The shell owns the bottom Tab bar.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { useSessionsLiveSync } from '@/features/workbench/useSessionsLiveSync';
import { useMobileProject } from '@/mobile/current-project';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';
import { buildSessionGroups } from './m-session-list-vm';

const COPY: { en: MSessionListCopy; zh: MSessionListCopy } = {
  en: { title: 'Sessions', today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier', empty: 'No sessions yet' },
  zh: { title: '会话', today: '今天', yesterday: '昨天', earlier: '更早', empty: '暂无会话' },
};

export function MSessionListScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const { currentProjectId } = useMobileProject();

  useSessionsLiveSync();
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );
  const sessions = sessionsQuery.data ?? [];
  const groups = useMemo(() => buildSessionGroups(sessions), [sessions]);
  const scope = currentProjectId ? projectInitials(currentProjectId) : undefined;

  return (
    <MScreen label="1a 会话列表">
      {sessionsQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
      ) : (
        <MSessionListView
          groups={groups}
          sessions={sessions}
          scope={scope}
          copy={copy}
          onOpen={(id) => navigate(`/m/session/${id}`)}
          onNew={() => navigate('/m/session/new')}
        />
      )}
    </MScreen>
  );
}
