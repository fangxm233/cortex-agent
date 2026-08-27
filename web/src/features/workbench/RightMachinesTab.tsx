// input:  shared machines resource/detail facts and localized desktop labels
// output: themed independently expandable machine status cards
// pos:    Desktop right-panel adapter and machine list view
// >>> If I am updated, update my header comment and CORTEX.md <<<
import { useState } from 'react';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useMachinesResource, type MachineDetailResource } from '@/features/machines/useMachinesResource';
import {
  formatSince,
  type MachineGpuRow,
  type MachineMeter,
  type MachineRunRow,
} from '@/features/machines/machine-detail-vm';
import { machinePill } from './right-panel-vm';

// Machines tab — 1:1 from prototype.dc.html L1237–1274. Collapsed cards show machines.list
// (name / online pill / GPU ×N / live-runs). Expanding a card lazily fetches machines.detail: a live
// probe of the device (GPU telemetry, host vitals) joined with its running dispatch executions.
// The probe is an RPC round trip, so it only runs while a card is open and stops when it closes.

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
const META_FONT = `400 10px ${MONO}`;

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

function Bar({ percent, width = 46 }: { percent: number; width?: number }) {
  return (
    <span
      style={{
        width, height: 5, borderRadius: 3, background: 'var(--proto-line-2)',
        overflow: 'hidden', flexShrink: 0, display: 'inline-block',
      }}
    >
      <span style={{ display: 'block', width: `${percent}%`, height: '100%', background: barColor(percent) }} />
    </span>
  );
}

function MeterRow({ meters }: { meters: MachineMeter[] }) {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '8px 14px' }}>
      {meters.map((meter) => (
        <span key={meter.key} style={{ display: 'flex', alignItems: 'center', gap: 5, font: META_FONT, color: 'var(--proto-muted-2)' }}>
          <span style={{ color: 'var(--proto-muted-3)' }}>{meter.label}</span>
          <Bar percent={meter.percent} width={34} />
          <span style={{ color: 'var(--proto-muted)' }}>{meter.text}</span>
        </span>
      ))}
    </div>
  );
}

function GpuRow({ gpu }: { gpu: MachineGpuRow }) {
  return <div style={{ padding: '6px 14px', borderTop: '1px solid var(--proto-line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: META_FONT, color: 'var(--proto-muted)' }}>
        <span style={{ color: 'var(--proto-ink-3)', fontWeight: 600 }}>{gpu.index}</span>
        <span style={{ color: 'var(--proto-muted-2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {gpu.name}
        </span>
        <Bar percent={gpu.utilPercent} width={34} />
        <span style={{ width: 30, textAlign: 'right' }}>{gpu.utilText}</span>
        <span style={{ color: 'var(--proto-muted-3)' }}>{gpu.memText}</span>
        <span style={{ color: 'var(--proto-faint)' }}>{gpu.tempText}</span>
      </div>
      {gpu.owners.length > 0 && (
        <div style={{ font: META_FONT, color: 'var(--proto-accent)', marginTop: 3, paddingLeft: 14 }}>
          ↳ {gpu.owners.join(' · ')}
        </div>
      )}
      {gpu.processes.map((proc) => (
        <div key={proc.pid} style={{ font: META_FONT, color: 'var(--proto-faint)', marginTop: 2, paddingLeft: 14 }}>
          {proc.pid} {proc.name} · {proc.memText}
        </div>
      ))}
      {gpu.hiddenProcessCount > 0 && (
        <div style={{ font: META_FONT, color: 'var(--proto-faint)', marginTop: 2, paddingLeft: 14 }}>
          +{gpu.hiddenProcessCount}
        </div>
      )}
    </div>;
}

function RunRow({ run }: { run: MachineRunRow }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: META_FONT, color: 'var(--proto-muted)' }}>
      <span
        style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-accent)', flexShrink: 0, animation: 'cxpulse 1.6s ease-in-out infinite' }}
      />
      <span style={{ color: 'var(--proto-ink-3)', fontWeight: 600 }}>{run.label}</span>
      {run.gpuText && <span style={{ color: 'var(--proto-muted-3)' }}>{run.gpuText}</span>}
      {run.duration && <span style={{ marginLeft: 'auto', color: 'var(--proto-faint)' }}>{run.duration}</span>}
    </div>
  );
}

/** Static facts from machines.list — rendered even when the machine is offline or the probe fails. */
function MetaFooter({ machine, uptime }: { machine: MachineInfo; uptime: string }) {
  const L = useVocab();
  const parts: string[] = [];
  if (machine.connectedAt) parts.push(`${L.mConnectedFor} ${formatSince(machine.connectedAt)}`);
  if (machine.lastHeartbeat) parts.push(`${L.mHeartbeat} ${formatSince(machine.lastHeartbeat)}`);
  if (uptime) parts.push(`${L.mUptime} ${uptime}`);
  if (machine.sshConfigured) parts.push(`${L.mSsh} ✓`);
  if (machine.capabilities.length > 0) parts.push(machine.capabilities.join(','));
  return (
    <div style={{ padding: '7px 14px 9px', borderTop: '1px solid var(--proto-line-soft)' }}>
      <div style={{ font: META_FONT, color: 'var(--proto-faint)', lineHeight: 1.7 }}>{parts.join(' · ')}</div>
      {machine.cortexPath && (
        <div style={{ font: META_FONT, color: 'var(--proto-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {L.mPath} {machine.cortexPath}
        </div>
      )}
    </div>
  );
}

function Notice({ text, tone }: { text: string; tone: 'muted' | 'danger' }) {
  return (
    <div
      style={{
        padding: '8px 14px',
        font: META_FONT,
        color: tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-muted-3)',
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
    {vm.meters.length > 0 && <MeterRow meters={vm.meters} />}
    {vm.gpus.map((gpu) => <GpuRow key={gpu.index} gpu={gpu} />)}
    {!vm.probeError && vm.gpus.length === 0 && <Notice text={L.mNoGpuReported} tone="muted" />}
    {vm.liveRuns.length > 0 && <div style={{ padding: '8px 14px', borderTop: '1px solid var(--proto-line-soft)', display: 'flex', flexDirection: 'column', gap: 5 }}>
      {vm.liveRuns.map((run) => <RunRow key={run.key} run={run} />)}
    </div>}
    <MetaFooter machine={detail.machine} uptime={detail.uptime} />
  </>;
}

function MachineCardTitle({ machine, open }: { machine: MachineInfo; open: boolean }) {
  const pill = machinePill(machine.online);
  const iconColor = machine.online ? 'var(--proto-accent)' : 'var(--proto-muted-2)';
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ display: 'inline-flex', color: 'var(--proto-muted-3)' }}><Chevron open={open} /></span>
    <span style={{ display: 'inline-flex', color: iconColor }}>{MACHINE_ICON}</span>
    <span style={{ font: `600 12.5px ${MONO}`, color: 'var(--proto-ink)' }}>{machine.name}</span>
    <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, padding: '2px 8px',
      borderRadius: 999, background: pill.bg, color: pill.fg }}>{pill.text}</span>
  </div>;
}

function MachineCardMeta({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
  const parts = [machine.gpuCount == null ? '' : `${L.mGpu} ×${machine.gpuCount}`, machine.os,
    machine.liveRuns > 0 ? `${machine.liveRuns} ${L.mLiveRuns}` : ''].filter(Boolean);
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
    <span style={{ font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)', paddingLeft: 17 }}>
      {parts.join(' · ')}
    </span>
    {machine.liveRuns > 0 && <span style={{ marginLeft: 'auto', width: 6, height: 6,
      borderRadius: '50%', background: 'var(--proto-accent)', flexShrink: 0,
      animation: 'cxpulse 1.6s ease-in-out infinite' }} />}
  </div>;
}

function MachineCard({ machine, open, detail, onToggle }: {
  machine: MachineInfo; open: boolean; detail: MachineDetailResource | undefined; onToggle: () => void;
}) {
  return <div style={{ background: 'var(--proto-card)', border: '1px solid var(--proto-line)',
    borderRadius: 10, boxShadow: 'var(--shadow-card-subtle)' }}>
    <div role="button" aria-expanded={open} onClick={onToggle}
      style={{ padding: '11px 14px 9px', cursor: 'pointer',
        borderBottom: `1px solid ${open ? 'var(--proto-line-soft)' : 'transparent'}` }}>
      <MachineCardTitle machine={machine} open={open} />
      <MachineCardMeta machine={machine} />
    </div>
    {open && detail && <MachineDetailBody detail={detail} />}
  </div>;
}

function MachinesHeader({ count }: { count: string }) {
  const L = useVocab();
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px',
    borderBottom: '1px solid var(--proto-line-2)', flex: 'none' }}>
    <span style={{ fontSize: 10.5, color: 'var(--proto-muted)' }}>{L.machines}</span>
    <span style={{ marginLeft: 'auto', font: `500 10.5px ${MONO}`, color: 'var(--proto-muted)' }}>{count}</span>
  </div>;
}

function MachineListState({ loading, error, empty }: { loading: boolean; error: boolean; empty: boolean }) {
  const L = useVocab();
  if (loading) return <div style={{ textAlign: 'center', fontSize: 11,
    color: 'var(--proto-muted-3)', padding: '24px 0' }}>{L.rpLoadingMachines}</div>;
  if (error) return <div style={{ textAlign: 'center', fontSize: 11,
    color: 'var(--proto-danger)', padding: '24px 0' }}>{L.rpFailedLoadMachines}</div>;
  if (!empty) return null;
  return <div style={{ textAlign: 'center', padding: '26px 12px',
    border: '1px dashed var(--proto-line)', borderRadius: 10 }}>
    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted-2)' }}>{L.mNoMachines}</div>
    <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', marginTop: 4,
      lineHeight: 1.6 }}>{L.rpNoMachinesHint}</div>
  </div>;
}

interface RightMachinesViewProps {
  machines: MachineInfo[];
  loading: boolean;
  error: boolean;
  expanded: ReadonlySet<string>;
  detailFor: (name: string) => MachineDetailResource | undefined;
  onToggle: (name: string) => void;
}

export function RightMachinesView(props: RightMachinesViewProps) {
  const count = !props.loading && !props.error ? String(props.machines.length) : '—';
  return <><MachinesHeader count={count} />
    <div style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column',
      gap: 10, overflow: 'auto', minHeight: 0 }}>
      {props.machines.map((machine) => <MachineCard key={machine.name} machine={machine}
        open={props.expanded.has(machine.name)} detail={props.detailFor(machine.name)}
        onToggle={() => props.onToggle(machine.name)} />)}
      <MachineListState loading={props.loading} error={props.error} empty={props.machines.length === 0} />
    </div>
  </>;
}

export function RightMachinesTab() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const machines = useMachinesResource([...expanded]);
  const toggle = (name: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return <RightMachinesView machines={machines.machines} loading={machines.loading}
    error={!!machines.error} expanded={expanded} detailFor={machines.detailFor} onToggle={toggle} />;
}
