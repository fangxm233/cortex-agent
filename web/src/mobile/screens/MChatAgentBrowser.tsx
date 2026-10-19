import type { CSSProperties } from 'react';
import { MobileOverlayPortal } from '@/design/mobile-overlay-host';
import { useBackDismiss } from '@/design/use-back-dismiss';
import { useVocabOptional } from '@/i18n';
import { AgentBrowserView } from '@/features/agent-browser/AgentBrowserView';
import { MBackChevron, MC } from '@/mobile/ui/kit';

// The session's browser on the phone: its capsule above the composer opens the live page full
// screen, to watch only. Taking it over is a desktop affair.

const SHEET: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 12, display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
  background: MC.backdrop,
  paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', boxSizing: 'border-box',
};

const TITLE: CSSProperties = {
  minWidth: 0, fontSize: 15.5, fontWeight: 620, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

export function MAgentBrowserSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }): JSX.Element {
  const L = useVocabOptional();
  useBackDismiss(onClose);
  return (
    <MobileOverlayPortal>
      <div data-agent-browser-sheet={sessionId} style={SHEET}>
        <div style={{ flex: 'none', height: 48, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 0 4px', minWidth: 0 }}>
          <button type="button" aria-label={L.back} onClick={onClose}
            style={{ width: 44, height: 44, border: 0, padding: 0, background: 'transparent', cursor: 'pointer',
              display: 'grid', placeItems: 'center', color: MC.ink }}>
            <MBackChevron />
          </button>
          <span style={TITLE}>{L.abTitle}</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <AgentBrowserView sessionId={sessionId} visible readOnly />
        </div>
      </div>
    </MobileOverlayPortal>
  );
}
