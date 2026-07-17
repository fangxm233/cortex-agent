// 1c 线程 — the current project's threads (scheme-mobile.dc.html 1c L174–238). Header = 线程 title +
// current-project QN tag + 活跃/历史 segment + 今日 budget band; body = thread pipeline cards, each
// drilling into the thread detail page (打开 › → /m/thread/:id). A `waiting` thread is a manager
// SUSPENDED on its children (DR-0014), rendered as a live pipeline card with the amber 等待子线程 pill —
// NOT an approval block, so it no longer routes to the approval queue. Real tRPC:
// threads.list (scoped to the current project; active-status query for the 活跃 count), threads.get
// (per running card — pipeline stages + cost + child count, mirrors MobileThreadCard), cost.summary
// (今日 budget band). Live refresh via useThreadsLiveSync. The shell owns the bottom Tab bar.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ThreadInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { useMobileProject } from '@/mobile/current-project';
import { threadScopeFilter, type Scope } from '@/features/workbench/scope';
import { useThreadsLiveSync } from '@/features/workbench/useThreadsLiveSync';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { MScreen, MScrollBody, MC } from '@/mobile/ui/kit';
import { MThreadsHeader, MRunningCard, type MThreadsCopy } from './MThreadsView';
import { threadsBudgetBand, isLiveThread } from './m-threads-vm';

const COPY: { en: MThreadsCopy; zh: MThreadsCopy } = {
  en: {
    title: 'Threads', active: 'Active', history: 'History', today: 'Today', open: 'Open',
    subthread: 'subthreads', empty: 'No threads', running: 'Running',
    waiting: 'Suspended', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
  },
  zh: {
    title: '线程', active: '活跃', history: '历史', today: '今日', open: '打开',
    subthread: '子线程', empty: '暂无线程', running: '运行中',
    waiting: '等待子线程', done: '已完成', failed: '失败', cancelled: '已取消',
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
  const [segment, setSegment] = useState<Scope>('active');
  useThreadsLiveSync();

  const projectId = currentProjectId ?? undefined;
  const listQuery = useQuery(
    trpc.threads.list.queryOptions({ projectId, status: threadScopeFilter(segment) }),
  );
  const activeQuery = useQuery(
    trpc.threads.list.queryOptions({ projectId, status: threadScopeFilter('active') }),
  );
  const costQuery = useQuery(trpc.cost.summary.queryOptions({ projectId }));

  const threads = listQuery.data ?? [];
  const activeCount = activeQuery.data?.length ?? 0;
  const band = useMemo(
    () => threadsBudgetBand(costQuery.data?.today, costQuery.data?.dailyBudget),
    [costQuery.data?.today, costQuery.data?.dailyBudget],
  );
  const scope = currentProjectId ? projectInitials(currentProjectId) : undefined;
  const now = Date.now();

  return (
    <MScreen
      label="1c 线程"
      header={
        <MThreadsHeader
          copy={copy}
          qn={scope}
          segment={segment}
          activeCount={activeCount}
          band={band}
          onSegment={setSegment}
        />
      }
    >
      <MScrollBody>
        {listQuery.isSuccess && threads.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        )}
        {threads.map((t) => {
          const onOpen = () => navigate(`/m/thread/${t.id}`);
          // Live (running / suspended-on-children) → live threads.get card (pipeline/cost/children);
          // terminal (history) → summary-only card. Every card drills into the thread detail page.
          return isLiveThread(t.status) ? (
            <MThreadRunningCard key={t.id} info={t} now={now} copy={copy} onOpen={onOpen} />
          ) : (
            <MRunningCard key={t.id} info={t} detail={undefined} now={now} copy={copy} onOpen={onOpen} />
          );
        })}
      </MScrollBody>
    </MScreen>
  );
}
