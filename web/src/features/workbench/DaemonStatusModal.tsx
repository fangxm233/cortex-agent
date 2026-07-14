import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';

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
  if (status === 'running') return '#23854F';
  if (status === 'unknown') return '#C99A2E';
  return '#C03D33';
}

function statusBg(status: string): string {
  if (status === 'running') return '#E9F4EE';
  if (status === 'unknown') return '#F7ECCE';
  return '#FBEDEB';
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
          background: '#fff',
          border: '1px solid #E7E9EE',
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
            borderBottom: '1px solid #EFF1F5',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: '#191C22',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              font: "600 12px 'IBM Plex Mono',monospace",
            }}
          >
            cx
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#191C22' }}>
              {L.dmDaemon}
            </div>
            <div
              style={{
                font: "400 10px 'IBM Plex Mono',monospace",
                color: '#98A1B0',
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
              color: '#98A1B0',
              border: '1px solid #E7E9EE',
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
            <div style={{ fontSize: 12, color: '#98A1B0', textAlign: 'center', padding: 20 }}>
              Loading…
            </div>
          )}
          {statusQuery.isError && (
            <div style={{ fontSize: 12, color: '#C03D33', textAlign: 'center', padding: 20 }}>
              Failed to load daemon status
            </div>
          )}

          {processes.map((proc) => {
            const st = proc.status;
            return (
              <div
                key={proc.name}
                style={{
                  border: '1px solid #E7E9EE',
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
                      color: '#191C22',
                    }}
                  >
                    {proc.name}
                  </span>
                  <span
                    style={{
                      font: "400 9.5px 'IBM Plex Mono',monospace",
                      color: '#98A1B0',
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
                    color: '#5B6472',
                    flexWrap: 'wrap',
                  }}
                >
                  {proc.uptime && (
                    <span>
                      <span style={{ color: '#98A1B0' }}>{L.dmUp} </span>
                      {proc.uptime}
                    </span>
                  )}
                  {proc.pid != null && (
                    <span>
                      <span style={{ color: '#98A1B0' }}>{L.dmPid} </span>
                      {proc.pid}
                    </span>
                  )}
                  {proc.port != null && (
                    <span>
                      <span style={{ color: '#98A1B0' }}>{L.dmPort} </span>
                      :{proc.port}
                    </span>
                  )}
                  {proc.extras &&
                    Object.entries(proc.extras).map(([k, v]) => (
                      <span key={k}>
                        <span style={{ color: '#98A1B0' }}>{k} </span>
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
                color: '#B6BDC9',
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
              borderTop: '1px solid #EFF1F5',
              padding: '12px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>
                  {L.dmSoftRestart}
                </div>
                <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 1 }}>
                  {L.dmSoftRestartDesc}
                </div>
              </div>
              <span
                onClick={onSoftRestart}
                style={{
                  flex: 'none',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: '#191C22',
                  border: '1px solid #D9DCE3',
                  background: '#fff',
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
                <div style={{ fontSize: 12, fontWeight: 600, color: '#C03D33' }}>
                  {L.dmHardRestart}
                </div>
                <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 1 }}>
                  {L.dmHardRestartDesc}
                </div>
              </div>
              <span
                onClick={() => setConfirmHard(true)}
                style={{
                  flex: 'none',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: '#C03D33',
                  border: '1px solid #EBC7C3',
                  background: '#FBEDEB',
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
              borderTop: '1px solid #EFF1F5',
              padding: '12px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              style={{
                border: '1px solid #EFDDB0',
                background: '#FDF9F0',
                borderRadius: 9,
                padding: '10px 14px',
              }}
            >
              <div
                style={{ fontSize: 12, fontWeight: 600, color: '#8A5B06' }}
              >
                {L.dmHardConfirm}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: '#5B6472',
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
                  color: '#191C22',
                  border: '1px solid #D9DCE3',
                  background: '#fff',
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
                  color: '#fff',
                  background: '#C03D33',
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
              borderTop: '1px solid #EFF1F5',
              padding: '10px 20px',
              fontSize: 11.5,
              color: '#23854F',
              fontWeight: 600,
            }}
          >
            {L.dmRestartSent}
          </div>
        )}
        {restartMut.isError && (
          <div
            style={{
              borderTop: '1px solid #EFF1F5',
              padding: '10px 20px',
              fontSize: 11.5,
              color: '#C03D33',
              fontWeight: 600,
            }}
          >
            {L.dmRestartFailed}
          </div>
        )}
      </div>
    </>
  );
}
