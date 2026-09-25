// input:  Modal, session ID rows, clipboard feedback
// output: SessionIdModal
// pos:    Session identifier display and copy dialog
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { Modal } from '@/design/Modal';
import { useVocab } from '@/i18n';
import { buildSessionIdRows } from '@/features/session/list/session-id';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';

// SESSION ID MODAL — opened from the ChatHeader ⋯ menu (会话ID). Shows the two identifiers a session
// carries: the human-facing Cortex ID (cortex-XXXX, SessionInfo.name) and the backend UUID — the
// backend CLI resume target (SessionInfo.backendSessionId, distinct from the track sessionId since the
// id decoupling). Each row has a copy-to-clipboard affordance. Styled with the proto-* CSS
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
  const { copiedKey, copy } = useClipboardFeedback<string>();

  const copyRow = (key: string, value: string): void => {
    if (value !== '—') void copy(value, key);
  };

  return (
    <Modal
      chrome="bare"
      size="custom"
      open={true}
      showClose={false}
      title={L.wbSessionId}
      description={L.wbBackendUuid}
      onOpenChange={(open) => { if (!open) onClose(); }}
      contentDataAttributes={{ 'data-modal': 'session-id' }}
      bodyStyle={{ overflowY: 'auto', minHeight: 0 }}
      contentStyle={{
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%,-50%)',
        animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
        width: 480,
        maxWidth: 'calc(100vw - 40px)',
        maxHeight: 'calc(100dvh - 40px)',
        background: 'var(--material-overlay-bg)',
        backdropFilter: 'var(--glass-filter)',
        WebkitBackdropFilter: 'var(--glass-filter)',
        borderRadius: 'var(--r-float)',
        boxShadow: 'var(--material-overlay-shadow)',
        zIndex: 61,
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}
    >
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--proto-line-2)'  }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>{L.wbSessionId}</span>
          <button
            type="button"
            aria-label="Close"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              font: `500 11px ${mono}`,
              color: 'var(--proto-muted)',
              border: '1px solid var(--proto-line)',
              borderRadius: 'var(--r-chip)',
              padding: '5px 8px',
              cursor: 'pointer',
            }}
          >
            esc
          </button>
        </div>

        <div style={{ background: 'transparent', padding: '14px 20px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((row) => (
            <div key={row.key}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '.02em',
                  color: 'var(--proto-muted)',
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
                  borderRadius: 'var(--r-control)',
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
                <button
                  type="button"
                  disabled={row.value === '—'}
                  className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
                  onClick={() => copyRow(row.key, row.value)}
                  style={{
                    flex: 'none',
                    font: `500 11px ${mono}`,
                    color: copiedKey === row.key ? 'var(--proto-accent)' : 'var(--proto-muted)',
                    border: '1px solid var(--proto-line-3)',
                    borderRadius: 'var(--r-chip)',
                    padding: '5px 8px',
                    background: row.value === '—' ? 'var(--proto-gray)' : 'var(--material-control-bg)',
                    boxShadow: 'var(--material-control-shadow)',
                    cursor: row.value === '—' ? 'not-allowed' : 'pointer',
                  }}
                >
                  {copiedKey === row.key ? L.wbCopied : L.wbCopy}
                </button>
              </div>
            </div>
          ))}
        </div>
    </Modal>
  );
}
