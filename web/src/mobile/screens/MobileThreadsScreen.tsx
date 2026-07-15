// 5b 移动端线程 — 1:1 from scheme.dc.html L3005–3108. Fills the mobile shell's 5b slot (线程 tab).
// Header (线程 + 活跃/历史 segment + 今日 budget band) + a list of thread cards that reuse the desktop
// L2-expand / L3-drill step-tree rules. Real tRPC: threads.list (list + segment count), threads.get
// (step tree / nesting, via MobileThreadCard), cost.summary (budget band). The shell owns the iOS frame
// + bottom Tab; this screen renders header + scroll content only. ZH copy via useVocab.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadInfo, ThreadDetail, ThreadChildNode } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { threadScopeFilter, type Scope } from '@/features/workbench/scope';
import { useThreadsLiveSync } from '@/features/workbench/useThreadsLiveSync';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { MobileThreadCard } from './MobileThreadCard';
import { MobileThreadsHeader, MobileThreadCardView, budgetBand } from './MobileThreadViews';

interface DrillEntry {
  id: string;
  name: string;
}

function detailToInfo(detail: ThreadDetail): ThreadInfo {
  return {
    id: detail.id,
    templateName: detail.templateName,
    currentStep: detail.currentStep,
    status: detail.status,
    projectId: detail.projectId,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    totalSteps: detail.totalSteps,
    artifactPath: detail.artifactPath,
  };
}

// A drilled thread rendered full-page inside the 5b frame (整页下钻). Re-roots threads.get on the child
// and renders it with the same card view; supports deeper drilling and a ‹ 返回 back affordance.
function MobileThreadDrillView({
  entry,
  onBack,
  onDrill,
}: {
  entry: DrillEntry;
  onBack: () => void;
  onDrill: (n: ThreadChildNode) => void;
}) {
  const trpc = useTRPC();
  const vocab = useVocab();
  const queryClient = useQueryClient();
  useThreadGetLiveSync(entry.id);
  const detailQuery = useQuery(trpc.threads.get.queryOptions({ threadId: entry.id }));
  const cancel = useMutation(
    trpc.threads.cancel.mutationOptions({
      onSettled: () => {
        queryClient.invalidateQueries(trpc.threads.list.queryFilter());
        queryClient.invalidateQueries(trpc.threads.get.queryFilter({ threadId: entry.id }));
      },
    }),
  );
  const detail = detailQuery.data;
  const thread = detail ? detailToInfo(detail) : null;
  return (
    <>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px 10px', borderBottom: '1px solid #E7E9EE', background: '#F2F2F7' }}>
        <span onClick={onBack} style={{ fontSize: 16, fontWeight: 600, color: '#4655D4', cursor: 'pointer' }}>‹ {vocab.back}</span>
        <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: '#191C22' }}>{entry.name}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px 0', display: 'flex', flexDirection: 'column', gap: 10, background: '#F2F2F7' }}>
        {detail && thread ? (
          <MobileThreadCardView
            thread={thread}
            detail={detail}
            now={Date.now()}
            vocab={vocab}
            expanded
            onToggle={() => {}}
            onCancel={() => cancel.mutate({ threadId: entry.id })}
            onDrill={onDrill}
          />
        ) : (
          <div style={{ fontSize: 12, color: '#98A1B0', padding: '20px 0', textAlign: 'center' }}>…</div>
        )}
      </div>
    </>
  );
}

export function MobileThreadsScreen() {
  const trpc = useTRPC();
  const vocab = useVocab();
  const [segment, setSegment] = useState<Scope>('active');
  const [trail, setTrail] = useState<DrillEntry[]>([]);
  useThreadsLiveSync();

  const threadsQuery = useQuery(trpc.threads.list.queryOptions({ status: threadScopeFilter(segment) }));
  const activeQuery = useQuery(trpc.threads.list.queryOptions({ status: threadScopeFilter('active') }));
  const costQuery = useQuery(trpc.cost.summary.queryOptions({}));

  const threads = threadsQuery.data ?? [];
  const activeCount = activeQuery.data?.length ?? 0;
  const band = useMemo(() => budgetBand(costQuery.data?.today), [costQuery.data?.today]);
  const now = Date.now();

  const pushDrill = (node: ThreadChildNode) =>
    setTrail((t) => [...t, { id: node.id, name: node.templateName ?? node.id }]);
  const popDrill = () => setTrail((t) => t.slice(0, -1));

  return (
    <div
      data-screen-label="5b"
      data-mobile-threads=""
      style={{ height: '100%', display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top)', boxSizing: 'border-box', background: '#F2F2F7' }}
    >
      {trail.length > 0 ? (
        <MobileThreadDrillView entry={trail[trail.length - 1]} onBack={popDrill} onDrill={pushDrill} />
      ) : (
        <>
          <MobileThreadsHeader vocab={vocab} segment={segment} activeCount={activeCount} band={band} onSegment={setSegment} />
          <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px 0', display: 'flex', flexDirection: 'column', gap: 10, background: '#F2F2F7' }}>
            {threads.map((t) => (
              <MobileThreadCard key={t.id} thread={t} now={now} onDrill={pushDrill} />
            ))}
            {threadsQuery.isSuccess && threads.length === 0 && (
              <div style={{ fontSize: 12, color: '#98A1B0', textAlign: 'center', padding: '28px 0' }}>—</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
