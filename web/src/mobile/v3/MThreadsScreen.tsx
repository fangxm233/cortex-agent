// input:  thread/cost queries, project scope, grouped thread model
// output: grouped mobile Threads screen with detail navigation
// pos:    Mobile thread-list data container
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ThreadInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { useMobileProject } from '@/mobile/current-project';
import { groupThreads } from '@/features/workbench/scope';
import { useRecentNow } from '@/features/workbench/useRecentNow';
import { useThreadsLiveSync } from '@/features/workbench/useThreadsLiveSync';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { MScreen, MScrollBody, MC } from '@/mobile/ui/kit';
import { MThreadSections, MThreadsHeader, MRunningCard, type MThreadsCopy } from './MThreadsView';
import { threadsBudgetBand, isLiveThread } from './m-threads-vm';

const COPY: { en: MThreadsCopy; zh: MThreadsCopy } = {
  en: {
    title: 'Threads', active: 'Active', history: 'History', today: 'Today', open: 'Open',
    subthread: 'subthreads', empty: 'No threads', running: 'Running',
    waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
  },
  zh: {
    title: '线程', active: '活跃', history: '历史', today: '今日', open: '打开',
    subthread: '子线程', empty: '暂无线程', running: '运行中',
    waiting: '等待中', done: '已完成', failed: '失败', cancelled: '已取消',
  },
};

// A RUNNING thread card that lazily fetches its own `threads.get` (pipeline stages, cost, child count)
// and live-syncs so the pipeline advances in place — mirrors MobileThreadCard. Mounted only for running
// threads; terminal (history) cards render from the list summary (no threads.get / SSE per archived one).
function MThreadRunningCard({
  info,
  now,
  copy,
  onOpen,
}: {
  info: ThreadInfo;
  now: number;
  copy: MThreadsCopy;
  onOpen: () => void;
}) {
  const trpc = useTRPC();
  useThreadGetLiveSync(info.id);
  const detailQuery = useQuery(trpc.threads.get.queryOptions({ threadId: info.id }));
  return <MRunningCard info={info} detail={detailQuery.data} now={now} copy={copy} onOpen={onOpen} />;
}

export function MThreadsScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const { currentProjectId } = useMobileProject();
  const now = useRecentNow(true);
  useThreadsLiveSync();

  const projectId = currentProjectId ?? undefined;
  const listQuery = useQuery(trpc.threads.list.queryOptions({ projectId }));
  const costQuery = useQuery(trpc.cost.summary.queryOptions({ projectId }));
  const groups = groupThreads(listQuery.data ?? []);
  const band = useMemo(
    () => threadsBudgetBand(costQuery.data?.today, costQuery.data?.dailyBudget),
    [costQuery.data?.today, costQuery.data?.dailyBudget],
  );
  const scope = currentProjectId ? projectInitials(currentProjectId) : undefined;

  return (
    <MScreen
      label="1c 线程"
      header={
        <MThreadsHeader copy={copy} qn={scope} band={band} />
      }
    >
      <MScrollBody>
        {listQuery.isSuccess && groups.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        )}
        <MThreadSections
          groups={groups}
          copy={copy}
          renderThread={(thread) => {
            const onOpen = () => navigate(`/m/thread/${thread.id}`);
            return isLiveThread(thread.status) ? (
              <MThreadRunningCard key={thread.id} info={thread} now={now} copy={copy} onOpen={onOpen} />
            ) : (
              <MRunningCard key={thread.id} info={thread} detail={undefined} now={now} copy={copy} onOpen={onOpen} />
            );
          }}
        />
      </MScrollBody>
    </MScreen>
  );
}
