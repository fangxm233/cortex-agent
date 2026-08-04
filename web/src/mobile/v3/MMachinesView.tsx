// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1k L556-599)
//
// 1k 机器 — the machines registry, drilled from the project page (1e→1k). NON-Tab drill page: the shell
// hides the Tab bar for /m/machines. Pure presentational view (render-testable without tRPC providers);
// the container (MMachinesScreen) binds `machines.list`, the `machines.detail` probe and navigation.
//
// Cards expand one at a time. The expanded panel renders real probe telemetry (per-GPU util/VRAM/temp,
// host meters, the runs holding each GPU) — the scheme's mocked bars are now backed by machines.detail.
import { type ReactNode } from 'react';
import { MDrillHeader, MScrollBody, MCard, MPill, MDot, MC, MONO } from '@/mobile/ui/kit';
import type { MachineDetailVm, MachineGpuRow, MachineRunRow } from '@/features/workbench/machine-detail-vm';
import type { MMachinesVm, MMachineCard } from './m-machines-vm';

export interface MMachinesCopy {
  title: string;
  online: string;
  offline: string;
  hb: string;
  lastHb: string;
  gpu: string;
  running: string;
  daemon: string;
  onlineWord: string;
  retry: string;
  logs: string;
  registered: string;
  editDesktop: string;
  empty: string;
  probing: string;
  probeFailed: string;
  noGpu: string;
  offlineNoTelemetry: string;
  up: string;
  uptime: string;
  path: string;
}

/** Probe state for the single expanded card. `vm` is present only once a response arrived. */
export interface MMachineDetailPanel {
  status: 'probing' | 'error' | 'ready';
  vm: MachineDetailVm | null;
  /** Host uptime, pre-formatted by the container. */
  uptime: string;
}

const META: React.CSSProperties = { font: `400 9.5px ${MONO}`, color: MC.muted };

// ── header trailing: daemon · N/M 在线 (real online/total; scheme L564) ──────────
function DaemonStatus({ vm, copy }: { vm: MMachinesVm; copy: MMachinesCopy }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: MC.done }}>
      <MDot color={MC.done} size={6} />
      {copy.daemon} · {vm.onlineCount}/{vm.total} {copy.onlineWord}
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
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {gpu.name}
        </span>
        <Bar percent={gpu.utilPercent} />
        <span style={{ color: MC.sub }}>{gpu.utilText}</span>
      </div>
      <div style={{ ...META, color: MC.faint, paddingLeft: 14, marginTop: 2 }}>
        {gpu.memText} · {gpu.tempText} · {gpu.powerText}
        {gpu.owners.length > 0 && <span style={{ color: MC.run }}> · {gpu.owners.join(' ')}</span>}
      </div>
      {gpu.processes.length > 0 && (
        <div style={{ ...META, color: MC.faint, paddingLeft: 14, marginTop: 2 }}>
          {gpu.processes.map((proc) => `${proc.name} ${proc.memText}`).join(' · ')}
          {gpu.hiddenProcessCount > 0 && ` +${gpu.hiddenProcessCount}`}
        </div>
      )}
    </div>
  );
}

function RunLine({ run }: { run: MachineRunRow }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...META, marginTop: 5 }}>
      <MDot color={MC.run} size={5} pulse />
      <span style={{ color: MC.body, fontWeight: 600 }}>{run.label}</span>
      {run.gpuText && <span style={{ color: MC.sub }}>{run.gpuText}</span>}
      {run.duration && <span style={{ marginLeft: 'auto', color: MC.faint }}>{run.duration}</span>}
    </div>
  );
}

function Notice({ text, tone }: { text: string; tone?: 'fail' }) {
  return <div style={{ ...META, color: tone === 'fail' ? MC.fail : MC.faint, marginTop: 6 }}>{text}</div>;
}

/** Static facts from machines.list — shown whether or not a probe succeeded. */
function CardStatics({ card, copy, uptime }: { card: MMachineCard; copy: MMachinesCopy; uptime: string }) {
  const parts: string[] = [];
  if (card.connectedFor) parts.push(`${copy.up} ${card.connectedFor}`);
  if (uptime) parts.push(`${copy.uptime} ${uptime}`);
  if (card.sshConfigured) parts.push('ssh ✓');
  if (card.capabilities.length > 0) parts.push(card.capabilities.join(','));
  return (
    <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${MC.divider}` }}>
      <div style={{ ...META, color: MC.faint }}>{parts.join(' · ')}</div>
      {card.cortexPath && (
        <div style={{ ...META, color: MC.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {copy.path} {card.cortexPath}
        </div>
      )}
    </div>
  );
}

function ProbePanel({ panel, copy }: { panel: MMachineDetailPanel; copy: MMachinesCopy }) {
  if (panel.status === 'probing') return <Notice text={copy.probing} />;
  if (panel.status === 'error' || !panel.vm) return <Notice text={copy.probeFailed} tone="fail" />;
  const { meters, gpus, liveRuns, probeError } = panel.vm;
  return (
    <>
      {probeError && <Notice text={`${copy.probeFailed}: ${probeError}`} tone="fail" />}
      {meters.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
          {meters.map((meter) => (
            <span key={meter.key} style={{ display: 'flex', alignItems: 'center', gap: 4, ...META }}>
              <span style={{ color: MC.faint }}>{meter.label}</span>
              <Bar percent={meter.percent} width={30} />
              <span>{meter.text}</span>
            </span>
          ))}
        </div>
      )}
      {gpus.map((gpu) => (
        <GpuLine key={gpu.index} gpu={gpu} />
      ))}
      {!probeError && gpus.length === 0 && <Notice text={copy.noGpu} />}
      {liveRuns.map((run) => (
        <RunLine key={run.key} run={run} />
      ))}
    </>
  );
}

// ── online machine card (scheme L567-581): header section · expand panel ────────
function OnlineCard({
  card,
  copy,
  expanded,
  panel,
  onToggle,
}: {
  card: MMachineCard;
  copy: MMachinesCopy;
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
          <span style={{ font: `600 12.5px ${MONO}`, color: MC.ink }}>{card.name}</span>
          <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>{card.os}</span>
          <span style={{ marginLeft: 'auto', flex: 'none' }}>
            <MPill tone="done">{copy.online}</MPill>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...META, marginTop: 4 }}>
          <span>
            {copy.hb} {card.heartbeat}
            {card.gpuCount !== null && card.gpuCount > 0 && ` · ${card.gpuCount} ${copy.gpu}`}
            {card.liveRuns > 0 && ` · ${card.liveRuns} ${copy.running}`}
          </span>
          {card.liveRuns > 0 && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
              <MDot color={MC.run} size={6} pulse />
            </span>
          )}
        </div>

        {expanded && (
          <>
            {panel ? <ProbePanel panel={panel} copy={copy} /> : <Notice text={copy.probing} />}
            <CardStatics card={card} copy={copy} uptime={panel?.uptime ?? ''} />
          </>
        )}
      </div>
    </MCard>
  );
}

// ── inert action button (scheme L590-591): styled 38px button, no browser-safe backend op.
// HONEST: retry-connect / view-logs need a daemon-side op with no tRPC surface here → wired as no-ops,
// mirroring the desktop settings machines pattern (rendered, non-functional).
function InertButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        height: 38,
        borderRadius: 10,
        border: '1.5px solid var(--proto-line-3)',
        background: 'var(--proto-card)',
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
  copy,
  expanded,
  onToggle,
  onRetry,
  onLogs,
}: {
  card: MMachineCard;
  copy: MMachinesCopy;
  expanded: boolean;
  onToggle: (name: string) => void;
  onRetry?: (name: string) => void;
  onLogs?: (name: string) => void;
}) {
  return (
    <MCard tone="fail" padding="11px 13px">
      <div role="button" aria-expanded={expanded} onClick={() => onToggle(card.name)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: `600 12.5px ${MONO}`, color: MC.sub }}>{card.name}</span>
          <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>{card.os}</span>
          <span style={{ marginLeft: 'auto', flex: 'none' }}>
            <MPill tone="failed">{copy.offline}</MPill>
          </span>
        </div>
        <div style={{ ...META, marginTop: 4 }}>
          {copy.lastHb} {card.heartbeat}
        </div>
        {/* An offline machine is never probed — say so rather than showing an empty telemetry frame. */}
        {expanded && (
          <>
            <Notice text={copy.offlineNoTelemetry} />
            <CardStatics card={card} copy={copy} uptime="" />
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <InertButton onClick={onRetry ? () => onRetry(card.name) : undefined}>{copy.retry}</InertButton>
        <InertButton onClick={onLogs ? () => onLogs(card.name) : undefined}>{copy.logs}</InertButton>
      </div>
    </MCard>
  );
}

// ── footer registry line (scheme L594) ──────────────────────────────────────────
function RegistryFooter({ vm, copy }: { vm: MMachinesVm; copy: MMachinesCopy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px', font: `400 9.5px ${MONO}`, color: MC.faint }}>
      <span>
        machines.json · {vm.total} {copy.registered}
      </span>
      <span style={{ marginLeft: 'auto', color: MC.muted }}>{copy.editDesktop}</span>
    </div>
  );
}

export function MMachinesView({
  vm,
  copy,
  onBack,
  expanded,
  onToggle,
  panel,
  onRetry,
  onLogs,
}: {
  vm: MMachinesVm;
  copy: MMachinesCopy;
  onBack: () => void;
  /** Name of the single expanded card; null when all are collapsed. */
  expanded: string | null;
  onToggle: (name: string) => void;
  /** Probe state for the expanded card; null when nothing is expanded or it is offline. */
  panel: MMachineDetailPanel | null;
  onRetry?: (name: string) => void;
  onLogs?: (name: string) => void;
}) {
  return (
    <>
      <MDrillHeader onBack={onBack} trailing={<DaemonStatus vm={vm} copy={copy} />}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>{copy.title}</div>
      </MDrillHeader>
      <MScrollBody gap={10}>
        {vm.cards.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>{copy.empty}</div>
        )}
        {vm.cards.map((card) =>
          card.online ? (
            <OnlineCard
              key={card.name}
              card={card}
              copy={copy}
              expanded={expanded === card.name}
              panel={expanded === card.name ? panel : null}
              onToggle={onToggle}
            />
          ) : (
            <OfflineCard
              key={card.name}
              card={card}
              copy={copy}
              expanded={expanded === card.name}
              onToggle={onToggle}
              onRetry={onRetry}
              onLogs={onLogs}
            />
          ),
        )}
        {vm.cards.length > 0 && <RegistryFooter vm={vm} copy={copy} />}
      </MScrollBody>
    </>
  );
}
