import { useEffect, useState } from 'react';
import { useVocab } from '@/i18n';
import { buildSessionIdRows } from './session-id';

// SESSION ID MODAL — opened from the ChatHeader ⋯ menu (会话ID). Shows the two identifiers a session
// carries: the human-facing Cortex ID (cortex-XXXX, SessionInfo.name) and the backend UUID
// (SessionInfo.sessionId). Each row has a copy-to-clipboard affordance. Styled with the proto-* CSS
// variables so it re-themes light/dark; centered card + scrim, esc / click-away close (mirrors
// NewProjectModal).

const mono = "'IBM Plex Mono',monospace";

export function SessionIdModal({
  cortexId,
  backendUuid,
  onClose,
}: {
  cortexId: string | null | undefined;
  backendUuid: string | null | undefined;
  onClose: () => void;
}): JSX.Element {
  const L = useVocab();
  const rows = buildSessionIdRows({
    cortexId,
    backendUuid,
    cortexIdLabel: L.wbCortexId,
    backendUuidLabel: L.wbBackendUuid,
  });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = (key: string, value: string) => {
    if (value === '—') return;
    void navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1400);
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(25,28,34,.34)',
          zIndex: 60,
          animation: 'cxfade .18s ease',
        }}
      />
      <div
        data-modal="session-id"
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
          width: 480,
          background: 'var(--proto-card)',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(16,24,40,.3)',
          zIndex: 61,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px 0' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>{L.wbSessionId}</span>
          <span
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              font: `500 9.5px ${mono}`,
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

        <div style={{ padding: '14px 20px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((row) => (
            <div key={row.key}>
              <div
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: '.05em',
                  color: 'var(--proto-muted-3)',
                  marginBottom: 6,
                }}
              >
                {row.label}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  border: '1px solid var(--proto-line)',
                  borderRadius: 9,
                  padding: '9px 12px',
                  background: 'var(--proto-alt)',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    font: `500 12.5px ${mono}`,
                    color: 'var(--proto-ink)',
                    userSelect: 'all',
                    wordBreak: 'break-all',
                  }}
                >
                  {row.value}
                </span>
                <span
                  onClick={() => copy(row.key, row.value)}
                  style={{
                    flex: 'none',
                    font: `500 9.5px ${mono}`,
                    color: copiedKey === row.key ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                    border: '1px solid var(--proto-line-3)',
                    borderRadius: 6,
                    padding: '3px 8px',
                    cursor: row.value === '—' ? 'default' : 'pointer',
                    opacity: row.value === '—' ? 0.4 : 1,
                  }}
                >
                  {copiedKey === row.key ? L.wbCopied : L.wbCopy}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
