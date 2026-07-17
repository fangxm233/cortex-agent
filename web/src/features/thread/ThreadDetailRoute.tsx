import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { LeftRail } from '@/features/workbench/LeftRail';
import { ThreadDetailView } from './ThreadDetailView';
import { useThreadGetLiveSync } from './useThreadGetLiveSync';
import type { TrailCrumb } from './thread-detail-vm';

// Route /threads/:threadId — the thread-detail center-column view (design 11b). The prototype keeps
// the left rail and swaps the workbench center+right for the detail (showRightPanel:false), so this
// mounts the real LeftRail + ThreadDetailView in the prototype's outer flex frame (L39). Binds the
// real threads.get DTO (B1) + live re-flow via useThreadGetLiveSync; the ancestor breadcrumb trail
// rides in React Router location.state.trail (carried by the 2b drill-down).

// 1s tick so the running-thread elapsed clock advances (matches the prototype's sim clock feel).
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function ThreadDetailRoute(): JSX.Element {
  const { threadId = '' } = useParams();
  const L = useVocab();
  const location = useLocation();
  const trail = ((location.state as { trail?: TrailCrumb[] } | null)?.trail ?? []).filter(
    (t) => t.id !== threadId,
  );

  const trpc = useTRPC();
  const threadQuery = useQuery(trpc.threads.get.queryOptions({ threadId }));
  useThreadGetLiveSync(threadId);
  const now = useNowTick(threadQuery.data ? ['running', 'waiting'].includes(threadQuery.data.status) : false);

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        minWidth: 1340,
        overflow: 'hidden',
        background: '#F7F8FA',
      }}
    >
      <LeftRail />
      {threadQuery.isPending ? (
        <div style={{ flex: 1, padding: 20, fontSize: 13, color: '#98A1B0' }}>{L.rpLoadingThread}</div>
      ) : threadQuery.isError ? (
        <div style={{ flex: 1, padding: 20 }}>
          <div
            style={{
              background: '#FBEDEB',
              border: '1px solid #EED3D0',
              borderRadius: 10,
              padding: '10px 14px',
              fontSize: 12.5,
              color: '#C03D33',
            }}
          >
            {L.thFailedLoadThread} {threadId}: {threadQuery.error.message}
          </div>
        </div>
      ) : (
        <ThreadDetailView detail={threadQuery.data} trail={trail} now={now} />
      )}
    </div>
  );
}
