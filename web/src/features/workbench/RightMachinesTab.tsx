import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { machinePill } from './right-panel-vm';
import {
  buildMachineDetailVm,
  formatSince,
  formatUptime,
  type MachineGpuRow,
  type MachineMeter,
  type MachineRunRow,
} from './machine-detail-vm';

// Machines tab — 1:1 from prototype.dc.html L1237–1274. Collapsed cards show machines.list
// (name / online pill / GPU ×N / live-runs). Expanding a card lazily fetches machines.detail: a live
// probe of the device (GPU telemetry, host vitals) joined with its running dispatch executions.
// The probe is an RPC round trip, so it only runs while a card is open and stops when it closes.

const LIST_REFRESH_MS = 10_000;
const PROBE_REFRESH_MS = 5_000;

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
  return (
    <div style={{ padding: '6px 14px', borderTop: '1px solid var(--proto-line-soft)' }}>
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
    </div>
  );
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

/** Expanded body. Probing only happens for online machines; everything else renders from machines.list. */
function MachineDetailBody({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.machines.detail.queryOptions({ machine: machine.name }),
    enabled: machine.online,
    refetchInterval: machine.online ? PROBE_REFRESH_MS : false,
  });

  if (!machine.online) {
    return (
      <>
        <Notice text={L.mOfflineNoTelemetry} tone="muted" />
        <MetaFooter machine={machine} uptime="" />
      </>
    );
  }
  if (query.isPending) return <Notice text={L.mProbing} tone="muted" />;
  if (query.isError) return <Notice text={L.mProbeFailed} tone="danger" />;

  const vm = buildMachineDetailVm(query.data);
  return (
    <>
      {vm.probeError && <Notice text={`${L.mProbeFailed}: ${vm.probeError}`} tone="danger" />}
      {vm.meters.length > 0 && <MeterRow meters={vm.meters} />}
      {vm.gpus.map((gpu) => (
        <GpuRow key={gpu.index} gpu={gpu} />
      ))}
      {!vm.probeError && vm.gpus.length === 0 && <Notice text={L.mNoGpuReported} tone="muted" />}
      {vm.liveRuns.length > 0 && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--proto-line-soft)', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {vm.liveRuns.map((run) => (
            <RunRow key={run.key} run={run} />
          ))}
        </div>
      )}
      <MetaFooter machine={machine} uptime={formatUptime(query.data.vitals?.uptimeSec ?? null)} />
    </>
  );
}

function MachineCard({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const pill = machinePill(machine.online);
  const iconColor = machine.online ? 'var(--proto-accent)' : 'var(--proto-muted-2)';

  const subParts: string[] = [];
  if (machine.gpuCount != null) subParts.push(`${L.mGpu} ×${machine.gpuCount}`);
  subParts.push(machine.os);
  if (machine.liveRuns > 0) subParts.push(`${machine.liveRuns} ${L.mLiveRuns}`);

  return (
    <div
      style={{
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)',
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
      }}
    >
      <div
        role="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          padding: '11px 14px 9px',
          cursor: 'pointer',
          borderBottom: `1px solid ${open ? 'var(--proto-line-soft)' : 'transparent'}`,
        }}
      >
        {/* header row: chevron · icon · name · pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-flex', color: 'var(--proto-muted-3)' }}>
            <Chevron open={open} />
          </span>
          <span style={{ display: 'inline-flex', color: iconColor }}>{MACHINE_ICON}</span>
          <span style={{ font: `600 12.5px ${MONO}`, color: 'var(--proto-ink)' }}>{machine.name}</span>
          <span
            style={{
              marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, padding: '2px 8px',
              borderRadius: 999, background: pill.bg, color: pill.fg,
            }}
          >
            {pill.text}
          </span>
        </div>
        {/* sub-line: GPU count · os · live-runs indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <span style={{ font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)', paddingLeft: 17 }}>
            {subParts.join(' · ')}
          </span>
          {machine.liveRuns > 0 && (
            <span
              style={{
                marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%',
                background: 'var(--proto-accent)', flexShrink: 0,
                animation: 'cxpulse 1.6s ease-in-out infinite',
              }}
            />
          )}
        </div>
      </div>
      {open && <MachineDetailBody machine={machine} />}
    </div>
  );
}

export function RightMachinesTab() {
  const L = useVocab();
  const trpc = useTRPC();
  const machinesQuery = useQuery({
    ...trpc.machines.list.queryOptions({}),
    // Connect/disconnect is not pushed to the UI, so the roster is polled to stay honest.
    refetchInterval: LIST_REFRESH_MS,
  });
  const machines = machinesQuery.data ?? [];
  const countLabel = machinesQuery.isSuccess ? String(machines.length) : '—';

  return (
    <>
      {/* aggregate header (prototype L1237–1243): label + machine count */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 18px',
          borderBottom: '1px solid var(--proto-line-2)',
          flex: 'none',
        }}
      >
        <span style={{ fontSize: 10.5, color: 'var(--proto-muted)' }}>{L.machines}</span>
        <span style={{ marginLeft: 'auto', font: `500 10.5px ${MONO}`, color: 'var(--proto-muted)' }}>
          {countLabel}
        </span>
      </div>

      {/* machine list body */}
      <div
        style={{
          flex: 1,
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          overflow: 'auto',
          minHeight: 0,
        }}
      >
        {machines.map((m) => (
          <MachineCard key={m.name} machine={m} />
        ))}

        {/* empty state — neutral placeholder names (atlas, nimbus), no private machine names */}
        {machinesQuery.isSuccess && machines.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: '26px 12px',
              border: '1px dashed var(--proto-line)',
              borderRadius: 10,
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted-2)' }}>{L.mNoMachines}</div>
            <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', marginTop: 4, lineHeight: 1.6 }}>
              {L.rpNoMachinesHint}
            </div>
          </div>
        )}

        {machinesQuery.isPending && (
          <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--proto-muted-3)', padding: '24px 0' }}>
            {L.rpLoadingMachines}
          </div>
        )}

        {machinesQuery.isError && (
          <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--proto-danger)', padding: '24px 0' }}>
            {L.rpFailedLoadMachines}
          </div>
        )}
      </div>
    </>
  );
}
