import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { buildThreadDetailVm, type TrailCrumb, type DetailStepSub } from './thread-detail-vm';
import { ThreadPipeline } from './ThreadPipeline';
import { ThreadArtifactPanel } from './ThreadArtifactPanel';

// Thread detail 11b (design §6.3 F2) — 1:1 from prototype.dc.html L398–522. Header bar (‹ back ·
// breadcrumbs · name · tid · status pill · Pause/Cancel) + meta bar (template/started/elapsed/cost/
// task + depth dots) + content (left PIPELINE column, right THREAD ARTIFACT 440px). Binds the real
// threads.get DTO through buildThreadDetailVm. Cancel = real threads.cancel mutation; Pause is inert
// (no threads pause MutateOp — GAP-P). Nested drill-down (2b) re-roots threads.get on the child,
// carrying the ancestor {id,name} trail through React Router location.state for the breadcrumb.

export interface ThreadDetailViewProps {
  detail: ThreadDetail;
  trail: TrailCrumb[];
  now: number;
}

export function ThreadDetailView({ detail, trail, now }: ThreadDetailViewProps): JSX.Element {
  const vm = buildThreadDetailVm(detail, trail, now);
  const L = useVocab();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [hover, setHover] = useState<string | null>(null);
  const hp = (key: string) => ({
    onMouseEnter: () => setHover(key),
    onMouseLeave: () => setHover((h) => (h === key ? null : h)),
  });

  const cancel = useMutation(
    trpc.threads.cancel.mutationOptions({
      onSettled: () => {
        queryClient.invalidateQueries(trpc.threads.list.queryFilter());
        queryClient.invalidateQueries(trpc.threads.get.queryFilter({ threadId: detail.id }));
      },
      onSuccess: () => navigate('/workbench'),
    }),
  );

  const openSub = (sub: DetailStepSub) => {
    navigate(`/threads/${sub.id}`, {
      state: { trail: [...trail, { id: vm.tid, name: vm.name }] },
    });
  };

  const goCrumb = (index: number) => {
    // index 0 = project (→ workbench); ancestor crumbs re-root on that thread with a shorter trail.
    if (index === 0) {
      navigate('/workbench');
      return;
    }
    const target = trail[index - 1];
    navigate(`/threads/${target.id}`, { state: { trail: trail.slice(0, index - 1) } });
  };

  return (
    <div
      data-thread-detail={vm.tid}
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {/* header bar */}
      <div
        style={{
          height: 50,
          flex: 'none',
          borderBottom: '1px solid var(--proto-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 20px',
          background: 'var(--proto-card)',
        }}
      >
        <span
          {...hp('back')}
          onClick={() => navigate('/workbench')}
          style={{
            fontSize: 14,
            color: hover === 'back' ? 'var(--proto-ink)' : 'var(--proto-muted)',
            cursor: 'pointer',
            padding: '4px 8px 4px 0',
          }}
        >
          ‹
        </span>
        {vm.crumbs.map((cr, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <span
              onClick={() => goCrumb(i)}
              style={{
                font: "500 12px 'IBM Plex Mono',monospace",
                color: cr.accent ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                cursor: 'pointer',
              }}
            >
              {cr.name}
            </span>
            <span style={{ color: 'var(--proto-line-3)' }}>/</span>
          </span>
        ))}
        <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>{vm.name}</span>
        <span style={{ font: "400 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>{vm.tid}</span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: vm.pill.bg,
            color: vm.pill.fg,
          }}
        >
          {vm.pill.text}
        </span>
        {/* Pause/Cancel only apply to a live (running/waiting) thread — hidden for terminal ones
            (the backend would reject cancel; the proto-shots are both Running so the match holds). */}
        {vm.live && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              title="Pause has no backend mutate op yet"
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                border: '1px solid var(--proto-line-3)',
                borderRadius: 7,
                padding: '4px 12px',
                color: 'var(--proto-ink)',
                background: 'var(--proto-card)',
                cursor: 'not-allowed',
                opacity: 0.6,
              }}
            >
              {L.pause}
            </span>
            <span
              {...hp('cancel')}
              data-cancel-thread-id={vm.tid}
              onClick={() => cancel.mutate({ threadId: detail.id })}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                border: '1px solid var(--proto-danger-bg)',
                borderRadius: 7,
                padding: '4px 12px',
                color: 'var(--proto-danger)',
                background: hover === 'cancel' ? 'var(--proto-danger-bg)' : 'var(--proto-card)',
                cursor: 'pointer',
              }}
            >
              {L.cancel}
            </span>
          </div>
        )}
      </div>

      {/* meta bar */}
      <div
        style={{
          flex: 'none',
          background: 'var(--proto-card)',
          borderBottom: '1px solid var(--proto-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 32,
          padding: '12px 20px 14px',
        }}
      >
        <MetaField label={L.thTemplate} value={vm.template} />
        <MetaField label={L.thStarted} value={vm.started} />
        <MetaField label={L.thElapsed} value={vm.elapsed} accent />
        <MetaField label={L.thCostInclChildren} value={vm.cost} />
        <MetaField label={L.thTask} value={vm.task} accent={vm.task !== '—'} />
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{ font: "500 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)', marginRight: 3 }}>
            {L.depth}
          </span>
          {vm.depthDots.map((d, i) => (
            <span
              key={i}
              style={{ width: 6, height: 6, borderRadius: '50%', background: d.filled ? 'var(--proto-accent)' : 'var(--proto-line)' }}
            />
          ))}
          <span style={{ font: "500 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', marginLeft: 3 }}>
            {vm.depthText}
          </span>
        </div>
      </div>

      {/* content */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          gap: 16,
          padding: '16px 20px',
          minHeight: 0,
          background: 'var(--proto-alt)',
          overflow: 'auto',
        }}
      >
        <ThreadPipeline vm={vm} onOpenSub={openSub} />
        <ThreadArtifactPanel artifact={vm.artifact} onOpen={() => { /* Memory viewer — Stage 6 */ }} />
      </div>
    </div>
  );
}

function MetaField({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, color: 'var(--proto-muted-3)', marginBottom: 2 }}>{label}</div>
      <div style={{ font: "600 12px 'IBM Plex Mono',monospace", color: accent ? 'var(--proto-accent)' : 'var(--proto-ink)' }}>
        {value}
      </div>
    </div>
  );
}
