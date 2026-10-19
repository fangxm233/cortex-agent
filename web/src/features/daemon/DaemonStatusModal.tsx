import { useEffect, useState, type CSSProperties } from 'react';
import { Button, IconButton } from '@/design';
import { useDaemonResource } from '@/features/daemon/useDaemonResource';
import { useVocab } from '@/i18n';
import { isNativeShell } from '@/lib/desktop-config';
import { disconnectShell } from '@/lib/shell-connection';
import { BUILD_STAMP } from '@/lib/build-info';
import { ActionRow, ProcessSection, RebuildSection, RecentSection, RestartSection } from './daemon-sections';

// Daemon status modal (scheme.dc.html #17a), opened from the top bar's daemon badge and Help →
// Daemon status. The floating sheet is the only box; inside it the processes, the last rebuild,
// recent events and the restart actions are flat sections.

export interface DaemonStatusModalProps {
  open: boolean;
  onClose: () => void;
}

const SHEET_STYLE: CSSProperties = {
  position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 50,
  width: 470, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
  background: 'var(--glass-2)', backdropFilter: 'var(--glass-filter)',
  WebkitBackdropFilter: 'var(--glass-filter)', borderRadius: 'var(--r-float)',
  boxShadow: 'var(--shadow-panel), 0 0 0 1px var(--proto-line-2)', overflow: 'hidden',
};

function BrandMark() {
  return (
    <div aria-label="Cortex" style={{
      width: 28, height: 28, borderRadius: 'var(--r-chip)', background: 'var(--brand-badge-bg)',
      boxShadow: '0 0 0 1px var(--brand-badge-border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* 25c 皮层弧 C — 两弧一核成 C / 由核向外的信号 (scheme.dc.html §25c) */}
      <svg width={20} height={20} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <circle cx={33} cy={32} r={6} fill="var(--brand-badge-core)" />
        <path d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36" stroke="var(--brand-badge-arc)" strokeWidth={6} strokeLinecap="round" />
        <path d="M48.6 17.95A21 21 0 1 0 48.6 46.05" stroke="var(--brand-badge-arc)" strokeWidth={6} strokeLinecap="round" />
      </svg>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </svg>
  );
}

function SheetHeader({ onClose }: { onClose: () => void }) {
  const L = useVocab();
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px 12px 20px', borderBottom: '1px solid var(--proto-line-2)' }}>
      <BrandMark />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>{L.dmDaemon}</div>
        {/* Frontend build stamp (Vite-injected, see lib/build-info.ts) — changes every build so an
            OTA frontend swap is verifiable on-device. Only the stamp itself is code. */}
        <div style={{ fontSize: 11, color: 'var(--proto-muted-3)', marginTop: 1 }}>
          {L.dmnLocal} · {L.dmnBuild} <span style={{ fontFamily: 'var(--font-code)', fontSize: 10.5 }}>{BUILD_STAMP}</span>
        </div>
      </div>
      <IconButton label={L.cmClose} size={28} onClick={onClose} style={{ marginLeft: 'auto' }}>
        <CloseGlyph />
      </IconButton>
    </div>
  );
}

function LoadState({ loading, failed }: { loading: boolean; failed: boolean }) {
  const L = useVocab();
  if (!loading && !failed) return null;
  return (
    <div style={{ fontSize: 12, color: failed ? 'var(--proto-danger)' : 'var(--proto-muted-3)', textAlign: 'center', padding: 20 }}>
      {failed ? L.dmnLoadFailed : L.cmLoading}
    </div>
  );
}

/** Clears the saved server + token and returns to the connect screen. Native shell only: in the
 *  browser auth is same-origin / Cloudflare Access, with no local creds and no connect screen. */
function DisconnectRow() {
  const L = useVocab();
  if (!isNativeShell()) return null;
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--proto-line-3)' }}>
      <ActionRow title={L.dmDisconnect} desc={L.dmDisconnectDesc} first>
        <Button size="sm" data-action="disconnect" onClick={() => void disconnectShell()}>{L.dmDisconnect}</Button>
      </ActionRow>
    </div>
  );
}

export function DaemonStatusModal({ open, onClose }: DaemonStatusModalProps) {
  const L = useVocab();
  const [confirmHard, setConfirmHard] = useState(false);
  const daemon = useDaemonResource({ enabled: open });
  const { processes, lastRestart, rebuild } = daemon.facts;

  useEffect(() => {
    if (daemon.restartState === 'success' || daemon.restartState === 'error') setConfirmHard(false);
  }, [daemon.restartState]);

  if (!open) return null;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'var(--overlay-scrim-medium)' }} />
      <div role="dialog" aria-label={L.dmDaemon} data-daemon-status-modal="" style={SHEET_STYLE}>
        <SheetHeader onClose={onClose} />
        <div style={{ overflowY: 'auto', padding: '0 20px 14px' }}>
          <LoadState loading={daemon.loading} failed={!!daemon.error} />
          <ProcessSection processes={processes} />
          <RebuildSection rebuild={rebuild} />
          <RecentSection lastRestart={lastRestart} />
          <RestartSection
            confirmHard={confirmHard}
            restartState={daemon.restartState}
            onSoft={() => daemon.restart('soft')}
            onArmHard={() => setConfirmHard(true)}
            onCancelHard={() => setConfirmHard(false)}
            onHard={() => daemon.restart('hard')}
          />
          <DisconnectRow />
        </div>
      </div>
    </>
  );
}
