// input:  mobile route params, threads.get query, and cancel mutation
// output: bound mobile thread detail screen
// pos:    Mobile drill-in controller for one thread
// >>> If I am updated, update my header comment and CORTEX.md <<<

// Non-Tab page; ancestor breadcrumbs ride in React Router location state.
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { useDocViewer } from '@/features/media/DocViewer';
import { docKindOf } from '@/features/media/doc-kind';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MThreadDetailView, type MThreadDetailCopy } from './MThreadDetailView';
import { buildMThreadDetailVm, type MThreadTrailCrumb, type MThreadArtifactVm } from './m-thread-detail-vm';

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

// 1s tick so the running-thread elapsed clock advances (matches the desktop detail modal).
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

  const { openDoc } = useDocViewer();
  const handleArtifactClick = useCallback((artifact: MThreadArtifactVm) => {
    const kind = docKindOf(artifact.filename);
    if (kind) {
      openDoc({ kind, name: artifact.filename, path: artifact.wsRelPath });
    }
  }, [openDoc]);

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
      onArtifactClick={handleArtifactClick}
    />
  );
}
