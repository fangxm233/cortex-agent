// input:  shared daemon resource, desktop confirmation state and shell connection helpers
// output: themed desktop daemon diagnostics, restart and disconnect modal
// pos:    Desktop shell adapter for canonical daemon lifecycle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect, useState } from 'react';
import type { Tone } from '@/design/tone';
import { useDaemonResource } from '@/features/daemon/useDaemonResource';
import { useVocab } from '@/i18n';
import { isNativeShell } from '@/lib/desktop-config';
import { disconnectShell } from '@/lib/shell-connection';
import { BUILD_STAMP } from '@/lib/build-info';

// Daemon status modal — 1:1 from scheme.dc.html #17a (L2376–2441).
// Opened by clicking the daemon badge in the LeftRail header.
// Two process rows (cortex-daemon, cortex-server) with liveness dot,
// PID, uptime, port/extras. Soft restart + Hard restart with inline
// confirmation for hard restart.

export interface DaemonStatusModalProps {
  open: boolean;
  onClose: () => void;
}

function toneColor(tone: Tone): string {
  if (tone === 'done') return 'var(--proto-success)';
  if (tone === 'failed') return 'var(--proto-danger)';
  return 'var(--pill-cancelled-fg)';
}

function toneBg(tone: Tone): string {
  if (tone === 'done') return 'var(--proto-success-bg)';
  if (tone === 'failed') return 'var(--proto-danger-bg)';
  return 'var(--pill-cancelled-bg)';
}

export function DaemonStatusModal({ open, onClose }: DaemonStatusModalProps) {
  const L = useVocab();
  const [confirmHard, setConfirmHard] = useState(false);
  const daemon = useDaemonResource({ enabled: open });
  const { processes, lastRestart } = daemon.facts;

  useEffect(() => {
    if (daemon.restartState === 'success' || daemon.restartState === 'error') setConfirmHard(false);
  }, [daemon.restartState]);

  const onSoftRestart = () => daemon.restart('soft');
  const onHardRestart = () => daemon.restart('hard');

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 40,
          background: 'var(--overlay-scrim-medium)',
        }}
      />

      {/* Modal card */}
      <div
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 50,
          width: 470,
          background: 'var(--proto-card)',
          border: '1px solid var(--proto-line)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-panel)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '16px 20px 14px',
            borderBottom: '1px solid var(--proto-line-2)',
          }}
        >
          <div
            aria-label="Cortex"
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: 'var(--brand-badge-bg)',
              border: '1px solid var(--brand-badge-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* 25c 皮层弧 C — 两弧一核成 C / 由核向外的信号 (scheme.dc.html §25c) */}
            <svg width={20} height={20} viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <circle cx={33} cy={32} r={6} fill="var(--brand-badge-core)" />
              <path
                d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36"
                stroke="var(--brand-badge-arc)"
                strokeWidth={6}
                strokeLinecap="round"
              />
              <path
                d="M48.6 17.95A21 21 0 1 0 48.6 46.05"
                stroke="var(--brand-badge-arc)"
                strokeWidth={6}
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>
              {L.dmDaemon}
            </div>
            {/* Frontend build stamp (Vite-injected, see lib/build-info.ts) — changes every build so an
                OTA frontend swap is verifiable on-device. Content hash / build id, never a fabricated
                semver. It reads here rather than in the rail footer: this is the system-status surface. */}
            <div
              style={{
                font: "400 10px 'IBM Plex Mono',monospace",
                color: 'var(--proto-muted-3)',
                marginTop: 1,
              }}
            >
              local · build {BUILD_STAMP}
            </div>
          </div>
          <span
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              font: "500 9.5px 'IBM Plex Mono',monospace",
              color: 'var(--proto-muted-3)',
              border: '1px solid var(--proto-line)',
              borderRadius: 5,
              padding: '2px 6px',
              cursor: 'pointer',
            }}
          >
            esc
          </span>
        </div>

        {/* Process rows */}
        <div
          style={{
            padding: '14px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {daemon.loading && (
            <div style={{ fontSize: 12, color: 'var(--proto-muted-3)', textAlign: 'center', padding: 20 }}>
              Loading…
            </div>
          )}
          {daemon.error && (
            <div style={{ fontSize: 12, color: 'var(--proto-danger)', textAlign: 'center', padding: 20 }}>
              Failed to load daemon status
            </div>
          )}

          {processes.map((proc) => {
            const st = proc.status;
            return (
              <div
                key={proc.name}
                style={{
                  border: '1px solid var(--proto-line)',
                  borderRadius: 10,
                  padding: '11px 14px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: toneColor(proc.tone),
                      flex: 'none',
                    }}
                  />
                  <span
                    style={{
                      font: "600 12px 'IBM Plex Mono',monospace",
                      color: 'var(--proto-ink)',
                    }}
                  >
                    {proc.name}
                  </span>
                  <span
                    style={{
                      font: "400 9.5px 'IBM Plex Mono',monospace",
                      color: 'var(--proto-muted-3)',
                    }}
                  >
                    {proc.label}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10.5,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: toneBg(proc.tone),
                      color: toneColor(proc.tone),
                    }}
                  >
                    {st}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 14,
                    marginTop: 8,
                    font: "400 10px 'IBM Plex Mono',monospace",
                    color: 'var(--proto-muted)',
                    flexWrap: 'wrap',
                  }}
                >
                  {proc.uptime && (
                    <span>
                      <span style={{ color: 'var(--proto-muted-3)' }}>{L.dmUp} </span>
                      {proc.uptime}
                    </span>
                  )}
                  {proc.pid != null && (
                    <span>
                      <span style={{ color: 'var(--proto-muted-3)' }}>{L.dmPid} </span>
                      {proc.pid}
                    </span>
                  )}
                  {proc.port != null && (
                    <span>
                      <span style={{ color: 'var(--proto-muted-3)' }}>{L.dmPort} </span>
                      :{proc.port}
                    </span>
                  )}
                  {proc.extras.map((extra) => (
                    <span key={extra.key}>
                      <span style={{ color: 'var(--proto-muted-3)' }}>{extra.key} </span>
                      {extra.value}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}

          {lastRestart?.at && (
            <div
              style={{
                font: "400 9.5px 'IBM Plex Mono',monospace",
                color: 'var(--proto-faint)',
                padding: '0 2px',
              }}
            >
              {L.dmLastRestart} {new Date(lastRestart.at).toLocaleDateString()}{' '}
              {new Date(lastRestart.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {lastRestart.reason
                ? ` · ${L.dmReason}: ${lastRestart.reason}`
                : ''}
            </div>
          )}
        </div>

        {/* Restart actions */}
        {!confirmHard && (
          <div
            style={{
              borderTop: '1px solid var(--proto-line-2)',
              padding: '12px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-ink)' }}>
                  {L.dmSoftRestart}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 1 }}>
                  {L.dmSoftRestartDesc}
                </div>
              </div>
              <span
                onClick={onSoftRestart}
                style={{
                  flex: 'none',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'var(--proto-ink)',
                  border: '1px solid var(--proto-line-3)',
                  background: 'var(--proto-card)',
                  borderRadius: 8,
                  padding: '6px 14px',
                  cursor: daemon.restartState === 'pending' ? 'default' : 'pointer',
                  opacity: daemon.restartState === 'pending' ? 0.5 : 1,
                }}
              >
                {L.dmSoftRestart}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-danger)' }}>
                  {L.dmHardRestart}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 1 }}>
                  {L.dmHardRestartDesc}
                </div>
              </div>
              <span
                onClick={() => setConfirmHard(true)}
                style={{
                  flex: 'none',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'var(--proto-danger)',
                  border: '1px solid var(--proto-danger-bg)',
                  background: 'var(--proto-danger-bg)',
                  borderRadius: 8,
                  padding: '6px 14px',
                  cursor: 'pointer',
                }}
              >
                {L.dmHardRestart}
              </span>
            </div>
          </div>
        )}

        {/* Hard restart confirmation */}
        {confirmHard && (
          <div
            style={{
              borderTop: '1px solid var(--proto-line-2)',
              padding: '12px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              style={{
                border: '1px solid var(--proto-amber-border)',
                background: 'var(--proto-amber-bg)',
                borderRadius: 9,
                padding: '10px 14px',
              }}
            >
              <div
                style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-amber-fg)' }}
              >
                {L.dmHardConfirm}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--proto-muted)',
                  marginTop: 4,
                  lineHeight: 1.5,
                }}
              >
                {L.dmHardConfirmDetail}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <span
                onClick={() => setConfirmHard(false)}
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'var(--proto-ink)',
                  border: '1px solid var(--proto-line-3)',
                  background: 'var(--proto-card)',
                  borderRadius: 8,
                  padding: '6px 14px',
                  cursor: 'pointer',
                }}
              >
                {L.dmConfirmCancel}
              </span>
              <span
                onClick={onHardRestart}
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'var(--ink-solid-fg)',
                  background: 'var(--proto-danger)',
                  borderRadius: 8,
                  padding: '6px 14px',
                  cursor: daemon.restartState === 'pending' ? 'default' : 'pointer',
                  opacity: daemon.restartState === 'pending' ? 0.5 : 1,
                }}
              >
                {daemon.restartState === 'pending' ? '...' : L.dmConfirmProceed}
              </span>
            </div>
          </div>
        )}

        {/* Feedback: restart result */}
        {daemon.restartState === 'success' && (
          <div
            style={{
              borderTop: '1px solid var(--proto-line-2)',
              padding: '10px 20px',
              fontSize: 11.5,
              color: 'var(--proto-success)',
              fontWeight: 600,
            }}
          >
            {L.dmRestartSent}
          </div>
        )}
        {daemon.restartState === 'error' && (
          <div
            style={{
              borderTop: '1px solid var(--proto-line-2)',
              padding: '10px 20px',
              fontSize: 11.5,
              color: 'var(--proto-danger)',
              fontWeight: 600,
            }}
          >
            {L.dmRestartFailed}
          </div>
        )}

        {/* Disconnect — clears the saved server + token and returns to the connect (login) screen.
            Only in the native desktop shell (isNativeShell): in browser / ui-http mode auth is
            same-origin / Cloudflare Access with no local creds to clear and no connect screen. */}
        {isNativeShell() && (
          <div
            style={{
              borderTop: '1px solid var(--proto-line-2)',
              padding: '12px 20px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-ink)' }}>
                {L.dmDisconnect}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 1 }}>
                {L.dmDisconnectDesc}
              </div>
            </div>
            <span
              onClick={() => void disconnectShell()}
              style={{
                flex: 'none',
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--proto-ink)',
                border: '1px solid var(--proto-line-3)',
                background: 'var(--proto-card)',
                borderRadius: 8,
                padding: '6px 14px',
                cursor: 'pointer',
              }}
            >
              {L.dmDisconnect}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
