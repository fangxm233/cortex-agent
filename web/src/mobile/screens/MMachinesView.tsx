import { type ReactNode } from 'react';
import { MPill, MDot, MC, MONO } from '@/mobile/ui/kit';
import { MSettingsFrame, MSettingsHeader as MDrillHeader, MSettingsBody as MScrollBody,
  MSettingsSurfaceCard as MCard } from './MSettingsControls';
import type { MachineDetailVm, MachineGpuRow } from '@/features/machines/machine-detail-vm';
import type { MMachinesVm, MMachineCard } from './m-machines-vm';
import { useVocab, type Vocab } from '@/i18n';

/** Probe state for the single expanded card. `vm` is present only once a response arrived. */
export interface MMachineDetailPanel {
  status: 'probing' | 'error' | 'ready';
  vm: MachineDetailVm | null;
  /** Host uptime, pre-formatted by the container. */
  uptime: string;
}

const META: React.CSSProperties = { font: `400 12px ${MONO}`, color: MC.muted };

// ── header trailing: daemon · N/M 在线 (real online/total; scheme L564) ──────────
function DaemonStatus({ vm, L }: { vm: MMachinesVm; L: Vocab }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: `color-mix(in srgb, ${MC.done}, ${MC.ink} 15%)` }}>
      <MDot color={MC.done} size={6} />
      {L.machDaemon} · {vm.onlineCount}/{vm.total} {L.mOnline}
    </span>
  );
}

/** Saturation reads as pressure: amber past 75%, red past 90%. */
function barColor(percent: number): string {
  if (percent >= 90) return MC.fail;
  if (percent >= 75) return MC.amber;
  return MC.run;
}

function Bar({ percent, width = 40 }: { percent: number; width?: number }) {
  return (
    <span style={{ width, height: 4, borderRadius: 2, background: MC.divider, overflow: 'hidden', flexShrink: 0 }}>
      <span style={{ display: 'block', width: `${percent}%`, height: '100%', background: barColor(percent) }} />
    </span>
  );
}

function GpuLine({ gpu }: { gpu: MachineGpuRow }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...META }}>
        <span style={{ color: MC.body, fontWeight: 600 }}>{gpu.index}</span>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {gpu.name}
        </span>
        <Bar percent={gpu.utilPercent} />
        <span style={{ color: MC.sub }}>{gpu.utilText}</span>
      </div>
      <div style={{ ...META, color: MC.muted, paddingLeft: 14, marginTop: 2 }}>
        {gpu.memText} · {gpu.tempText} · {gpu.powerText}
      </div>
      {gpu.processes.length > 0 && (
        <div style={{ ...META, color: MC.muted, paddingLeft: 14, marginTop: 2 }}>
          {gpu.processes.map((proc) => `${proc.name} ${proc.memText}`).join(' · ')}
          {gpu.hiddenProcessCount > 0 && ` +${gpu.hiddenProcessCount}`}
        </div>
      )}
    </div>
  );
}

function Notice({ text, tone }: { text: string; tone?: 'fail' }) {
  return <div style={{ ...META, color: tone === 'fail' ? MC.fail : MC.muted, marginTop: 6 }}>{text}</div>;
}

/** Static facts from machines.list — shown whether or not a probe succeeded. */
function CardStatics({ card, L, uptime }: { card: MMachineCard; L: Vocab; uptime: string }) {
  const parts: string[] = [];
  if (card.connectedFor) parts.push(`${L.mConnectedFor} ${card.connectedFor}`);
  if (uptime) parts.push(`${L.mUptime} ${uptime}`);
  if (card.sshConfigured) parts.push('ssh ✓');
  if (card.capabilities.length > 0) parts.push(card.capabilities.join(','));
  return (
    <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${MC.divider}` }}>
      <div style={{ ...META, color: MC.muted }}>{parts.join(' · ')}</div>
      {card.cortexPath && (
        <div style={{ ...META, color: MC.muted, overflowWrap: 'anywhere' }}>
          {L.mPath} {card.cortexPath}
        </div>
      )}
    </div>
  );
}

function ProbePanel({ panel, L }: { panel: MMachineDetailPanel; L: Vocab }) {
  if (panel.status === 'probing') return <Notice text={L.mProbing} />;
  if (panel.status === 'error' || !panel.vm) return <Notice text={L.mProbeFailed} tone="fail" />;
  const { meters, gpus, probeError } = panel.vm;
  return (
    <>
      {probeError && <Notice text={`${L.mProbeFailed}: ${probeError}`} tone="fail" />}
      {meters.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
          {meters.map((meter) => (
            <span key={meter.key} style={{ display: 'flex', alignItems: 'center', gap: 4, ...META }}>
              <span style={{ color: MC.muted }}>{meter.label}</span>
              <Bar percent={meter.percent} width={30} />
              <span>{meter.text}</span>
            </span>
          ))}
        </div>
      )}
      {gpus.map((gpu) => (
        <GpuLine key={gpu.index} gpu={gpu} />
      ))}
      {!probeError && gpus.length === 0 && <Notice text={L.mNoGpuReported} />}
    </>
  );
}

// ── online machine card (scheme L567-581): header section · expand panel ────────
function OnlineCard({
  card,
  L,
  expanded,
  panel,
  onToggle,
}: {
  card: MMachineCard;
  L: Vocab;
  expanded: boolean;
  panel: MMachineDetailPanel | null;
  onToggle: (name: string) => void;
}) {
  return (
    <MCard tone="default" padding={0} style={{ overflow: 'hidden' }}>
      <div
        role="button"
        aria-expanded={expanded}
        onClick={() => onToggle(card.name)}
        style={{ padding: '11px 13px 9px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: `600 13px ${MONO}`, color: MC.ink }}>{card.name}</span>
          <span style={{ fontSize: 12, color: MC.muted }}>{card.os}</span>
          <span style={{ marginLeft: 'auto', flex: 'none' }}>
            <MPill tone="done">{L.machOnline}</MPill>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...META, marginTop: 4 }}>
          <span>
            {L.machHeartbeat} {card.heartbeat}
            {card.gpuCount !== null && card.gpuCount > 0 && ` · ${card.gpuCount} ${L.mGpu}`}
          </span>
        </div>

        {expanded && (
          <>
            {panel ? <ProbePanel panel={panel} L={L} /> : <Notice text={L.mProbing} />}
            <CardStatics card={card} L={L} uptime={panel?.uptime ?? ''} />
          </>
        )}
      </div>
    </MCard>
  );
}

// ── inert action button (scheme L590-591): styled 38px button, no browser-safe backend op.
// HONEST: retry-connect / view-logs need a daemon-side op with no tRPC surface here → wired as no-ops,
// mirroring the desktop settings machines pattern (rendered, non-functional).
function InertButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      style={{
        flex: 1,
        height: 38,
        borderRadius: 'var(--r-control)',
        border: '1.5px solid var(--proto-line-3)',
        background: 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)',
        color: MC.ink,
        fontSize: 12.5,
        fontWeight: 600,
        boxSizing: 'border-box',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ── offline machine card (scheme L586-593): fail-toned, retry/logs buttons ───────
function OfflineCard({
  card,
  L,
  expanded,
  onToggle,
}: {
  card: MMachineCard;
  L: Vocab;
  expanded: boolean;
  onToggle: (name: string) => void;
}) {
  return (
    <MCard tone="fail" padding="11px 13px">
      <div role="button" aria-expanded={expanded} onClick={() => onToggle(card.name)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: `600 13px ${MONO}`, color: MC.sub }}>{card.name}</span>
          <span style={{ fontSize: 12, color: MC.muted }}>{card.os}</span>
          <span style={{ marginLeft: 'auto', flex: 'none' }}>
            <MPill tone="failed">{L.machOffline}</MPill>
          </span>
        </div>
        <div style={{ ...META, marginTop: 4 }}>
          {L.machLastHeartbeat} {card.heartbeat}
        </div>
        {/* An offline machine is never probed — say so rather than showing an empty telemetry frame. */}
        {expanded && (
          <>
            <Notice text={L.mOfflineNoTelemetry} />
            <CardStatics card={card} L={L} uptime="" />
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <InertButton>{L.machRetry}</InertButton>
        <InertButton>{L.machLogs}</InertButton>
      </div>
    </MCard>
  );
}

// ── footer registry line (scheme L594) ──────────────────────────────────────────
function RegistryFooter({ L }: { L: Vocab }) {
  return (
    <div style={{ padding: '2px 4px', fontSize: 12, color: MC.muted, textAlign: 'right' }}>{L.setEditOnDesktop}</div>
  );
}

export function MMachinesView({
  vm,
  onBack,
  expanded,
  onToggle,
  panel,
  onAdd,
  addDisabled,
}: {
  vm: MMachinesVm;
  onBack: () => void;
  /** Name of the single expanded card; null when all are collapsed. */
  expanded: string | null;
  onToggle: (name: string) => void;
  /** Probe state for the expanded card; null when nothing is expanded or it is offline. */
  panel: MMachineDetailPanel | null;
  onAdd: () => void;
  addDisabled: boolean;
}) {
  const L = useVocab();
  return (
    <MSettingsFrame label="Settings · Machines" header={<MDrillHeader onBack={onBack} trailing={<DaemonStatus vm={vm} L={L} />}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>{L.stNavMachines}</div>
      </MDrillHeader>}>
      <MScrollBody>
        {vm.cards.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.muted, fontSize: 13 }}>{L.machEmpty}</div>
        )}
        {vm.cards.map((card) =>
          card.online ? (
            <OnlineCard
              key={card.name}
              card={card}
              L={L}
              expanded={expanded === card.name}
              panel={expanded === card.name ? panel : null}
              onToggle={onToggle}
            />
          ) : (
            <OfflineCard
              key={card.name}
              card={card}
              L={L}
              expanded={expanded === card.name}
              onToggle={onToggle}
            />
          ),
        )}
        <button type="button" data-machine-add onClick={onAdd} disabled={addDisabled}
          style={{ border: `1px solid ${MC.runBorder}`, borderRadius: 'var(--r-chip)', padding: '9px 12px',
            background: MC.runBg, color: MC.run, fontSize: 11, fontWeight: 650 }}>
          {L.machAdd}
        </button>
        {vm.cards.length > 0 && <RegistryFooter L={L} />}
      </MScrollBody>
    </MSettingsFrame>
  );
}
