// input:  ThreadDetail DTO, modal callbacks, and optional chat renderer
// output: navigation-free desktop thread detail content
// pos:    Presentational body of the thread detail modal
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { ReactNode } from 'react';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { buildThreadDetailVm, type DetailStepSub, type ThreadDetailVm } from './thread-detail-vm';
import { ThreadPipeline } from './ThreadPipeline';
import { ThreadArtifactPanel } from './ThreadArtifactPanel';

export interface ThreadDetailViewProps {
  detail: ThreadDetail;
  now: number;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
  onCancel: () => void;
  cancelPending?: boolean;
  renderStepChat?: (sessionId: string | null, live: boolean) => ReactNode;
}

function StatusPill({ vm }: { vm: ThreadDetailVm }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: vm.pill.bg, color: vm.pill.fg }}>
      {vm.pill.text}
    </span>
  );
}

function LiveActions({ onCancel, pending }: { onCancel: () => void; pending: boolean }) {
  const L = useVocab();
  return (
    <>
      <span title="Pause has no backend mutate op yet" style={{ fontSize: 11.5, fontWeight: 600, border: '1px solid var(--proto-line-3)', borderRadius: 7, padding: '4px 12px', color: 'var(--proto-ink)', background: 'var(--proto-card)', cursor: 'not-allowed', opacity: 0.6 }}>
        {L.pause}
      </span>
      <button type="button" disabled={pending} onClick={onCancel} style={{ fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', border: '1px solid var(--proto-danger-bg)', borderRadius: 7, padding: '4px 12px', color: 'var(--proto-danger)', background: 'var(--proto-card)', cursor: pending ? 'default' : 'pointer', opacity: pending ? 0.6 : 1 }}>
        {L.cancel}
      </button>
    </>
  );
}

function DetailHeader({ vm, onClose, onCancel, cancelPending }: {
  vm: ThreadDetailVm; onClose: () => void; onCancel: () => void; cancelPending: boolean;
}) {
  return (
    <div style={{ height: 50, flex: 'none', borderBottom: '1px solid var(--proto-line)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 20px', background: 'var(--proto-card)' }}>
      <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>{vm.name}</span>
      <span style={{ font: "400 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>{vm.tid}</span>
      <StatusPill vm={vm} />
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {vm.live && <LiveActions onCancel={onCancel} pending={cancelPending} />}
        <button data-close-thread-detail="true" type="button" aria-label="Close" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'var(--proto-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}>×</button>
      </div>
    </div>
  );
}

function MetaField({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, color: 'var(--proto-muted-3)', marginBottom: 2 }}>{label}</div>
      <div style={{ font: "600 12px 'IBM Plex Mono',monospace", color: accent ? 'var(--proto-accent)' : 'var(--proto-ink)' }}>{value}</div>
    </div>
  );
}

function DepthField({ vm }: { vm: ThreadDetailVm }) {
  const L = useVocab();
  return (
    <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{ font: "500 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)', marginRight: 3 }}>{L.depth}</span>
      {vm.depthDots.map((dot, index) => <span key={index} style={{ width: 6, height: 6, borderRadius: '50%', background: dot.filled ? 'var(--proto-accent)' : 'var(--proto-line)' }} />)}
      <span style={{ font: "500 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', marginLeft: 3 }}>{vm.depthText}</span>
    </div>
  );
}

function DetailMeta({ vm }: { vm: ThreadDetailVm }) {
  const L = useVocab();
  return (
    <div style={{ flex: 'none', background: 'var(--proto-card)', borderBottom: '1px solid var(--proto-line)', display: 'flex', alignItems: 'center', gap: 32, padding: '12px 20px 14px' }}>
      <MetaField label={L.thTemplate} value={vm.template} />
      <MetaField label={L.thStarted} value={vm.started} />
      <MetaField label={L.thElapsed} value={vm.elapsed} accent />
      <MetaField label={L.thCostInclChildren} value={vm.cost} />
      <MetaField label={L.thTask} value={vm.task} accent={vm.task !== '—'} />
      <DepthField vm={vm} />
    </div>
  );
}

function DetailContent({ vm, onOpenThread, renderStepChat }: {
  vm: ThreadDetailVm;
  onOpenThread: (threadId: string) => void;
  renderStepChat?: (sessionId: string | null, live: boolean) => ReactNode;
}) {
  const openSub = (sub: DetailStepSub) => onOpenThread(sub.id);
  return (
    <div style={{ flex: 1, display: 'flex', gap: 16, padding: '16px 20px', minHeight: 0, background: 'var(--proto-alt)', overflow: 'auto' }}>
      <ThreadPipeline vm={vm} onOpenSub={openSub} renderStepChat={renderStepChat} />
      <ThreadArtifactPanel artifact={vm.artifact} />
    </div>
  );
}

export function ThreadDetailView(props: ThreadDetailViewProps): JSX.Element {
  const vm = buildThreadDetailVm(props.detail, props.now);
  return (
    <div data-thread-detail={vm.tid} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <DetailHeader vm={vm} onClose={props.onClose} onCancel={props.onCancel} cancelPending={!!props.cancelPending} />
      <DetailMeta vm={vm} />
      <DetailContent vm={vm} onOpenThread={props.onOpenThread} renderStepChat={props.renderStepChat} />
    </div>
  );
}
