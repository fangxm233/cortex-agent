import { useQuery } from '@tanstack/react-query';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { machinePill } from './right-panel-vm';

// Machines tab — 1:1 from prototype.dc.html L1237–1274. Replaces the GAP-M structural stub with
// real machines.list data: aggregate-header (count), machine cards (name / online pill / GPU ×N /
// live-runs indicator), empty/loading/error states. Only MachineInfo DTO consumed — no backend internals.

// Server-rack icon: two shelf rows with a status LED each (14×14 viewport, stroke 1.6).
const MACHINE_ICON = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" strokeWidth="1.6">
    <rect x="1.5" y="2" width="11" height="4" rx="1" stroke="currentColor" />
    <rect x="1.5" y="8" width="11" height="4" rx="1" stroke="currentColor" />
    <circle cx="11" cy="4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="11" cy="10" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

function MachineCard({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
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
        padding: '11px 14px 9px',
      }}
    >
      {/* header row: icon · name · pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', color: iconColor }}>{MACHINE_ICON}</span>
        <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>
          {machine.name}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10.5,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: pill.bg,
            color: pill.fg,
          }}
        >
          {pill.text}
        </span>
      </div>
      {/* sub-line: GPU count · os · live-runs indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
        <span style={{ font: "400 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
          {subParts.join(' · ')}
        </span>
        {machine.liveRuns > 0 && (
          <span
            style={{
              marginLeft: 'auto',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--proto-accent)',
              flexShrink: 0,
              animation: 'cxpulse 1.6s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}

export function RightMachinesTab() {
  const L = useVocab();
  const trpc = useTRPC();
  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));
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
        <span style={{ marginLeft: 'auto', font: "500 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>
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
