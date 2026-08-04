import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { isNativeShell } from '@/lib/desktop-config';
import { disconnectShell } from '@/lib/shell-connection';

// Daemon status modal — 1:1 from scheme.dc.html #17a (L2376–2441).
// Opened by clicking the daemon badge in the LeftRail header.
// Two process rows (cortex-daemon, cortex-server) with liveness dot,
// PID, uptime, port/extras. Soft restart + Hard restart with inline
// confirmation for hard restart.

export interface DaemonStatusModalProps {
  open: boolean;
  onClose: () => void;
}

function statusColor(status: string): string {
  if (status === 'running') return 'var(--proto-success)';
  if (status === 'unknown') return 'var(--proto-amber)';
  return 'var(--proto-danger)';
}

function statusBg(status: string): string {
  if (status === 'running') return 'var(--proto-success-bg)';
  if (status === 'unknown') return 'var(--pill-waiting-bg)';
  return 'var(--proto-danger-bg)';
}

export function DaemonStatusModal({ open, onClose }: DaemonStatusModalProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const L = useVocab();
  const [confirmHard, setConfirmHard] = useState(false);

  const statusQuery = useQuery({
    ...trpc.system.daemonStatus.queryOptions({}),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  const restartMut = useMutation({
    ...trpc.system.restart.mutationOptions({
      onSuccess: () => {
        setConfirmHard(false);
        queryClient.invalidateQueries(trpc.system.daemonStatus.queryFilter());
      },
      onError: () => {
        setConfirmHard(false);
      },
    }),
  });

  const data = statusQuery.data;
  const processes = data?.processes ?? [];
  const lastRestart = data?.lastRestart;

  const onSoftRestart = () => restartMut.mutate({ kind: 'soft' as const });
  const onHardRestart = () => restartMut.mutate({ kind: 'hard' as const });

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
          background: 'rgba(25, 28, 34, 0.40)',
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
          boxShadow: '0 8px 24px rgba(16,24,40,.10)',
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
            <div
              style={{
                font: "400 10px 'IBM Plex Mono',monospace",
                color: 'var(--proto-muted-3)',
                marginTop: 1,
              }}
            >
              local
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
          {statusQuery.isLoading && (
            <div style={{ fontSize: 12, color: 'var(--proto-muted-3)', textAlign: 'center', padding: 20 }}>
              Loading…
            </div>
          )}
          {statusQuery.isError && (
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
                      background: statusColor(st),
                      flex: 'none',
                      ...(st === 'unknown' ? { animation: 'cxpulse 2s ease-in-out infinite' } : {}),
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
                      background: statusBg(st),
                      color: statusColor(st),
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
                  {proc.extras &&
                    Object.entries(proc.extras).map(([k, v]) => (
                      <span key={k}>
                        <span style={{ color: 'var(--proto-muted-3)' }}>{k} </span>
                        {v}
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
                  cursor: restartMut.isPending ? 'default' : 'pointer',
                  opacity: restartMut.isPending ? 0.5 : 1,
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
                  cursor: restartMut.isPending ? 'default' : 'pointer',
                  opacity: restartMut.isPending ? 0.5 : 1,
                }}
              >
                {restartMut.isPending ? '...' : L.dmConfirmProceed}
              </span>
            </div>
          </div>
        )}

        {/* Feedback: restart result */}
        {restartMut.isSuccess && (
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
        {restartMut.isError && (
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
