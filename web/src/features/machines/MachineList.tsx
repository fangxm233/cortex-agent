import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useLang, useVocab } from '@/i18n';
import { useMachinesResource, type MachineDetailResource } from './useMachinesResource';
import {
  formatSince,
  type MachineGpuRow,
  type MachineMeter,
} from './machine-detail-vm';
import { machinePill } from './machines-menu-vm';

// Machine cards for the top-bar machines menu. Collapsed cards show machines.list (name / online
// pill / GPU ×N). Expanding a card lazily fetches machines.detail: a live probe of the device (GPU
// telemetry, host vitals). The probe is an RPC round trip, so it only runs while the menu is open
// and the card is expanded.

// Server-rack icon: two shelf rows with a status LED each (14×14 viewport, stroke 1.6).
const MACHINE_ICON = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" strokeWidth="1.6">
    <rect x="1.5" y="2" width="11" height="4" rx="1" stroke="currentColor" />
    <rect x="1.5" y="8" width="11" height="4" rx="1" stroke="currentColor" />
    <circle cx="11" cy="4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="11" cy="10" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

const MONO = "'IBM Plex Mono',monospace";
const META_FONT = `400 11px ${MONO}`;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      fill="none"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }}
    >
      <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Saturation reads as pressure: amber past 75%, red past 90%. */
function barColor(percent: number): string {
  if (percent >= 90) return 'var(--proto-danger)';
  if (percent >= 75) return 'var(--proto-amber)';
  return 'var(--proto-accent)';
}

function Bar({ percent }: { percent: number }) {
  return (
    <span style={{ height: 4, borderRadius: 2, background: 'var(--proto-line-4)', overflow: 'hidden', minWidth: 0 }}>
      <span style={{ display: 'block', width: `${percent}%`, height: '100%', borderRadius: 2, background: barColor(percent) }} />
    </span>
  );
}

const VALUE: CSSProperties = { color: 'var(--proto-ink-3)', textAlign: 'right', whiteSpace: 'nowrap' };
const FAINT: CSSProperties = { color: 'var(--proto-muted-3)' };

function Section({ children, divided = true }: { children: ReactNode; divided?: boolean }) {
  return <div style={{ padding: '8px 12px', borderTop: divided ? '1px solid var(--proto-line-soft)' : 0 }}>{children}</div>;
}

/** Host vitals as aligned rows: label · bar · value. */
function Vitals({ meters }: { meters: MachineMeter[] }) {
  return (
    <Section divided={false}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(40px, 1fr) auto', alignItems: 'center',
        columnGap: 10, rowGap: 5, font: META_FONT, color: 'var(--proto-muted)' }}>
        {meters.map((meter) => <Fragment key={meter.key}>
          <span>{meter.label}</span>
          <Bar percent={meter.percent} />
          <span style={VALUE}>{meter.text}</span>
        </Fragment>)}
      </div>
    </Section>
  );
}

function GpuRows({ gpus, model, divided }: { gpus: MachineGpuRow[]; model: string | null; divided: boolean }) {
  const L = useVocab();
  return (
    <Section divided={divided}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6, font: META_FONT }}>
        <span style={{ fontWeight: 600, color: 'var(--proto-muted)', flex: 'none' }}>{L.mGpu}</span>
        {model && <span title={model} style={{ ...FAINT, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(28px, 1fr) auto auto auto auto', alignItems: 'center',
        columnGap: 9, rowGap: 3, font: META_FONT, color: 'var(--proto-muted)' }}>
        {gpus.map((gpu) => <Fragment key={gpu.index}>
          <span style={{ color: 'var(--proto-ink-3)', fontWeight: 600 }}>{gpu.index}</span>
          <Bar percent={gpu.utilPercent} />
          <span style={VALUE}>{gpu.utilText}</span>
          <span style={VALUE}>{gpu.memText}</span>
          <span style={{ textAlign: 'right' }}>{gpu.tempText}</span>
          <span style={{ textAlign: 'right' }}>{gpu.powerText}</span>
          <GpuSubline gpu={gpu} showName={!model} />
        </Fragment>)}
      </div>
    </Section>
  );
}

/** Model (mixed hosts only) and the heaviest processes, under the bar column. */
function GpuSubline({ gpu, showName }: { gpu: MachineGpuRow; showName: boolean }) {
  if (!showName && gpu.processes.length === 0) return null;
  return (
    <div style={{ gridColumn: '2 / -1', marginBottom: 4, fontSize: 10.5, lineHeight: 1.5, ...FAINT, overflowWrap: 'anywhere' }}>
      {showName && <div title={gpu.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gpu.name}</div>}
      {gpu.processes.map((proc) => (
        <div key={proc.pid}>
          <span style={{ color: 'var(--proto-muted)' }}>{proc.name}</span> {proc.memText} · {proc.pid}
        </div>
      ))}
      {gpu.hiddenProcessCount > 0 && <div>+{gpu.hiddenProcessCount}</div>}
    </div>
  );
}

/** Connection facts from machines.list — rendered even when the machine is offline or the probe fails. */
function MetaFooter({ machine, uptime }: { machine: MachineInfo; uptime: string }) {
  const L = useVocab();
  const lang = useLang();
  const parts: string[] = [];
  if (machine.connectedAt) parts.push(`${L.mConnectedFor} ${formatSince(machine.connectedAt, lang)}`);
  if (machine.lastHeartbeat) parts.push(`${L.mHeartbeat} ${formatSince(machine.lastHeartbeat, lang)}`);
  if (uptime) parts.push(`${L.mUptime} ${uptime}`);
  if (parts.length === 0) return null;
  return (
    <div style={{ padding: '6px 12px 8px', borderTop: '1px solid var(--proto-line-soft)',
      font: `400 10.5px ${MONO}`, ...FAINT, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
      {parts.join(' · ')}
    </div>
  );
}

function Notice({ text, tone }: { text: string; tone: 'muted' | 'danger' }) {
  return (
    <div
      style={{
        padding: '8px 12px',
        font: META_FONT,
        color: tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-muted)',
      }}
    >
      {text}
    </div>
  );
}

/** Expanded body consumes shared lifecycle facts; the desktop keeps its own telemetry JSX. */
function MachineDetailBody({ detail }: { detail: MachineDetailResource }) {
  const L = useVocab();
  if (detail.status === 'offline') return <>
    <Notice text={L.mOfflineNoTelemetry} tone="muted" />
    <MetaFooter machine={detail.machine} uptime="" />
  </>;
  if (detail.status === 'probing') return <Notice text={L.mProbing} tone="muted" />;
  if (detail.status === 'error' || !detail.facts) return <Notice text={L.mProbeFailed} tone="danger" />;
  const vm = detail.facts;
  return <>
    {vm.probeError && <Notice text={`${L.mProbeFailed}: ${vm.probeError}`} tone="danger" />}
    {vm.meters.length > 0 && <Vitals meters={vm.meters} />}
    {vm.gpus.length > 0 && <GpuRows gpus={vm.gpus} model={vm.gpuModel} divided={vm.meters.length > 0} />}
    {!vm.probeError && vm.gpus.length === 0 && <Notice text={L.mNoGpuReported} tone="muted" />}
    <MetaFooter machine={detail.machine} uptime={detail.uptime} />
  </>;
}

function MachineCardTitle({ machine, open }: { machine: MachineInfo; open: boolean }) {
  const L = useVocab();
  const pill = machinePill(machine.online, { online: L.mOnline, offline: L.mOffline });
  const iconColor = machine.online ? 'var(--proto-accent)' : 'var(--proto-muted-2)';
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ display: 'inline-flex', color: 'var(--proto-muted-3)' }}><Chevron open={open} /></span>
    <span style={{ display: 'inline-flex', color: iconColor }}>{MACHINE_ICON}</span>
    <span title={machine.name} style={{ font: `600 12.5px ${MONO}`, color: 'var(--proto-ink)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{machine.name}</span>
    <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 11, fontWeight: 600, padding: '2px 8px',
      borderRadius: 'var(--r-pill)', background: pill.bg, color: pill.fg, textTransform: 'capitalize' }}>{pill.text}</span>
  </div>;
}

function MachineCardMeta({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
  const parts = [machine.gpuCount == null ? '' : `${L.mGpu} ×${machine.gpuCount}`, machine.os].filter(Boolean);
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
    <span style={{ font: `400 11px ${MONO}`, color: 'var(--proto-muted)', paddingLeft: 17 }}>
      {parts.join(' · ')}
    </span>
  </div>;
}

function MachineCard({ machine, open, detail, onToggle }: {
  machine: MachineInfo; open: boolean; detail: MachineDetailResource | undefined; onToggle: () => void;
}) {
  // Glass-on-glass inside the menu sheet: translucent fill, no filter of its own.
  return <div style={{ background: 'var(--material-card-bg)', border: 0, borderRadius: 'var(--r-card)',
    boxShadow: 'var(--material-card-shadow), 0 0 0 1px var(--proto-line-2)' }}>
    <div role="button" aria-expanded={open} onClick={onToggle}
      style={{ padding: '10px 12px', cursor: 'pointer',
        borderBottom: `1px solid ${open ? 'var(--proto-line-soft)' : 'transparent'}` }}>
      <MachineCardTitle machine={machine} open={open} />
      <MachineCardMeta machine={machine} />
    </div>
    {open && detail && <MachineDetailBody detail={detail} />}
  </div>;
}

function MachineListState({ loading, error, empty }: { loading: boolean; error: boolean; empty: boolean }) {
  const L = useVocab();
  if (loading) return <div style={{ textAlign: 'center', fontSize: 11,
    color: 'var(--proto-muted)', padding: '24px 0' }}>{L.rpLoadingMachines}</div>;
  if (error) return <div style={{ textAlign: 'center', fontSize: 11,
    color: 'var(--proto-danger)', padding: '24px 0' }}>{L.rpFailedLoadMachines}</div>;
  if (!empty) return null;
  return <div style={{ textAlign: 'center', padding: '26px 12px',
    border: '1px dashed var(--proto-line)', borderRadius: 'var(--r-card)' }}>
    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted)' }}>{L.mNoMachines}</div>
  </div>;
}

interface MachineListViewProps {
  machines: MachineInfo[];
  loading: boolean;
  error: boolean;
  expanded: ReadonlySet<string>;
  detailFor: (name: string) => MachineDetailResource | undefined;
  onToggle: (name: string) => void;
}

export function MachineListView(props: MachineListViewProps) {
  return <div style={{ flex: 1, minHeight: 0, padding: '2px 12px 12px', display: 'flex',
    flexDirection: 'column', gap: 6, overflow: 'auto', scrollbarGutter: 'stable' }}>
    {props.machines.map((machine) => <MachineCard key={machine.name} machine={machine}
      open={props.expanded.has(machine.name)} detail={props.detailFor(machine.name)}
      onToggle={() => props.onToggle(machine.name)} />)}
    <MachineListState loading={props.loading} error={props.error} empty={props.machines.length === 0} />
  </div>;
}

/** Expansion lives with the caller so it survives the menu closing; probes run only while mounted. */
export function MachineList({ expanded, onToggle }: {
  expanded: ReadonlySet<string>;
  onToggle: (name: string) => void;
}) {
  const machines = useMachinesResource([...expanded]);
  return <MachineListView machines={machines.machines} loading={machines.loading}
    error={!!machines.error} expanded={expanded} detailFor={machines.detailFor} onToggle={onToggle} />;
}
