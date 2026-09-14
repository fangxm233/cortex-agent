// input:  controlled bare Modal, session totals rows and localized labels
// output: Accessible themed whole-session statistics overlay
// pos:    Desktop session-totals detail hosted by the shared dialog primitive
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Modal } from '@/design/Modal';
import { useVocab } from '@/i18n';
import type { SessionStatsRow } from './session-stats';

// SESSION STATS MODAL — opened from the composer status line's totals segment. Spells out what the
// one-line summary compresses: how many runs, how many agent turns, how long the agent actually
// worked, how long the conversation has been open, what it cost, and how much of that cost was
// spent by Agent-tool children. Same card/scrim chrome as SessionIdModal.

const mono = "'IBM Plex Mono',monospace";

export function SessionStatsModal({
  rows,
  onClose,
}: {
  rows: SessionStatsRow[];
  onClose: () => void;
}): JSX.Element {
  const L = useVocab();

  return (
    <Modal
      chrome="bare"
      size="custom"
      open={true}
      showClose={false}
      title={L.wbSessionStats}
      description={L.wbSessionStatsHint}
      onOpenChange={(open) => { if (!open) onClose(); }}
      contentDataAttributes={{ 'data-modal': 'session-stats' }}
      bodyStyle={{ display: 'contents' }}
      contentStyle={{
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%,-50%)',
        animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
        width: 420,
        background: 'var(--proto-card)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-overlay-strong)',
        zIndex: 61,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px 0' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>{L.wbSessionStats}</span>
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

      <div style={{ padding: '12px 20px 18px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((row) => (
          <div
            key={row.key}
            data-session-stats-row={row.key}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              padding: '9px 0',
              borderBottom: '1px solid var(--proto-line)',
            }}
          >
            <span style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', flex: 1, minWidth: 0 }}>
              {row.label}
            </span>
            <span style={{ font: `600 12.5px ${mono}`, color: 'var(--proto-ink)', flex: 'none' }}>
              {row.value}
            </span>
          </div>
        ))}
        <div style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--proto-muted-3)', paddingTop: 10 }}>
          {L.wbSessionStatsHint}
        </div>
      </div>
    </Modal>
  );
}
