// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1k L556-599)
//
// 1k 机器 — the machines registry, drilled from the project page (1e→1k). NON-Tab drill page: the shell
// hides the Tab bar for /m/machines. Pure presentational view (render-testable without tRPC providers);
// the container (MMachinesScreen) binds `machines.list` and navigation.
import { type ReactNode } from 'react';
import { MDrillHeader, MScrollBody, MCard, MPill, MDot, MC, MONO } from '@/mobile/ui/kit';
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
}

// ── header trailing: daemon · N/M 在线 (real online/total; scheme L564) ──────────
function DaemonStatus({ vm, copy }: { vm: MMachinesVm; copy: MMachinesCopy }) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        fontWeight: 600,
        color: MC.done,
      }}
    >
      <MDot color={MC.done} size={6} />
      {copy.daemon} · {vm.onlineCount}/{vm.total} {copy.onlineWord}
    </span>
  );
}

// ── online machine card (scheme L567-581): header section · GPU line · run row ───
function OnlineCard({ card, copy }: { card: MMachineCard; copy: MMachinesCopy }) {
  return (
    <MCard tone="default" padding={0} style={{ overflow: 'hidden' }}>
      {/* header section */}
      <div style={{ padding: '11px 13px 9px', borderBottom: `1px solid ${MC.divider}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: `600 12.5px ${MONO}`, color: MC.ink }}>{card.name}</span>
          <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>{card.os}</span>
          <span style={{ marginLeft: 'auto', flex: 'none' }}>
            <MPill tone="done">{copy.online}</MPill>
          </span>
        </div>
        {/* sub-line: real heartbeat. GAP: scheme's `client v0.4.2` + `fs.watch ✓` are mocks (no DTO) → omitted. */}
        <div style={{ font: `400 9.5px ${MONO}`, color: MC.muted, marginTop: 4 }}>
          {copy.hb} {card.heartbeat}
        </div>
      </div>

      {/* GPU line — honest gpuCount only.
          GAP: the scheme's per-GPU util+VRAM bars (`GPU0 · 4090 82% · 18.2G`) have NO DTO source
          (MachineInfo carries only gpuCount) → render the count, never the fabricated bars. */}
      {card.gpuCount !== null && card.gpuCount > 0 && (
        <div style={{ padding: '10px 13px', borderBottom: `1px solid ${MC.divider}` }}>
          <span style={{ font: `500 10px ${MONO}`, color: MC.sub }}>
            {card.gpuCount} {copy.gpu}
          </span>
        </div>
      )}

      {/* running-execution row — real liveRuns count.
          GAP: the run NAME (scheme `cortex-run exp-024…`) isn't in MachineInfo → show `N 运行中` only. */}
      {card.liveRuns > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px' }}>
          <MDot color={MC.run} size={6} pulse />
          <span style={{ font: `500 11px ${MONO}`, color: MC.body }}>
            {card.liveRuns} {copy.running}
          </span>
        </div>
      )}
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
  onRetry,
  onLogs,
}: {
  card: MMachineCard;
  copy: MMachinesCopy;
  onRetry?: (name: string) => void;
  onLogs?: (name: string) => void;
}) {
  return (
    <MCard tone="fail" padding="11px 13px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ font: `600 12.5px ${MONO}`, color: MC.sub }}>{card.name}</span>
        <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>{card.os}</span>
        <span style={{ marginLeft: 'auto', flex: 'none' }}>
          <MPill tone="failed">{copy.offline}</MPill>
        </span>
      </div>
      {/* GAP: offline DTO has null lastHeartbeat → `上次心跳 —` (scheme's `2 小时前 · ssh 超时` is a mock). */}
      <div style={{ font: `400 9.5px ${MONO}`, color: MC.muted, marginTop: 4 }}>
        {copy.lastHb} {card.heartbeat}
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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '2px 4px',
        font: `400 9.5px ${MONO}`,
        color: MC.faint,
      }}
    >
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
  onRetry,
  onLogs,
}: {
  vm: MMachinesVm;
  copy: MMachinesCopy;
  onBack: () => void;
  onRetry?: (name: string) => void;
  onLogs?: (name: string) => void;
}) {
  return (
    <>
      <MDrillHeader onBack={onBack} trailing={<DaemonStatus vm={vm} copy={copy} />}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
          {copy.title}
        </div>
      </MDrillHeader>
      <MScrollBody gap={10}>
        {vm.cards.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        )}
        {vm.cards.map((card) =>
          card.online ? (
            <OnlineCard key={card.name} card={card} copy={copy} />
          ) : (
            <OfflineCard key={card.name} card={card} copy={copy} onRetry={onRetry} onLogs={onLogs} />
          ),
        )}
        {vm.cards.length > 0 && <RegistryFooter vm={vm} copy={copy} />}
      </MScrollBody>
    </>
  );
}
