// 1g 线程详情 — the drill-in detail of one thread (from 1c「打开 ›」), scheme-mobile.dc.html 1g L387-438.
// Non-Tab page (the shell hides the Tab bar). Binds the real threads.get DTO (B1) + live re-flow via
// useThreadGetLiveSync; 取消 is the real threads.cancel mutation; 暂停 is inert (no pause backend op —
// GAP). The ancestor breadcrumb trail rides in React Router location.state.trail (carried by 1c's
// drill-down; honest — omitted when absent). Presentation + the pure VM live alongside (TDD).
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MThreadDetailView, type MThreadDetailCopy } from './MThreadDetailView';
import { buildMThreadDetailVm, type MThreadTrailCrumb } from './m-thread-detail-vm';

const COPY: { en: MThreadDetailCopy; zh: MThreadDetailCopy } = {
  en: {
    pause: 'Pause',
    cancel: 'Cancel',
    artifacts: 'Artifacts',
    noArtifacts: 'No artifacts',
    pending: 'wait',
    depth: 'depth',
    status: { running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' },
  },
  zh: {
    pause: '暂停',
    cancel: '取消',
    artifacts: '产物',
    noArtifacts: '暂无产物',
    pending: '待',
    depth: '深度',
    status: { running: '运行中', waiting: '等待', done: '完成', failed: '失败', cancelled: '已取消' },
  },
};

// 1s tick so the running-thread elapsed clock advances (matches ThreadDetailRoute).
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function MThreadDetailScreen() {
  const { threadId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const trail = ((location.state as { trail?: MThreadTrailCrumb[] } | null)?.trail ?? []).filter(
    (t) => t.id !== threadId,
  );

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const threadQuery = useQuery(trpc.threads.get.queryOptions({ threadId }));
  useThreadGetLiveSync(threadId);
  const live = threadQuery.data ? ['running', 'waiting'].includes(threadQuery.data.status) : false;
  const now = useNowTick(live);

  const cancel = useMutation(
    trpc.threads.cancel.mutationOptions({
      onSettled: () => {
        queryClient.invalidateQueries(trpc.threads.get.queryFilter({ threadId }));
        queryClient.invalidateQueries(trpc.threads.list.queryFilter());
      },
      onSuccess: () => navigate('/m/threads'),
    }),
  );

  if (threadQuery.isPending) {
    return (
      <MScreen label="1g 线程详情">
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>…</div>
      </MScreen>
    );
  }
  if (threadQuery.isError) {
    return (
      <MScreen label="1g 线程详情">
        <div
          style={{
            margin: 14,
            background: MC.failBg,
            border: `1px solid ${MC.failBorder}`,
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12.5,
            color: MC.fail,
          }}
        >
          {threadId}: {threadQuery.error.message}
        </div>
      </MScreen>
    );
  }

  const vm = buildMThreadDetailVm(threadQuery.data, trail, now);
  return (
    <MThreadDetailView
      vm={vm}
      copy={copy}
      onBack={() => navigate(-1)}
      onMore={() => { /* rename/export/archive menu — out of 1g scope */ }}
      onCancel={() => cancel.mutate({ threadId })}
    />
  );
}
