import { createPortal } from 'react-dom';
import { useVocab } from '@/i18n';

// The whole chat pane accepts drops, so the cue covers the whole pane rather than only the composer.
// It never takes pointer events: the drag keeps landing on the pane's own children, which is what the
// drop target's enter/leave depth counting expects. The host element must be `position: relative`.
// The dashed accent edge is the drop-target indicator; the label inside is an ordinary floating card.
export function ChatDropOverlay({ target, fileCount, attachedCount }: {
  target: HTMLElement | null;
  fileCount: number;
  attachedCount: number;
}): JSX.Element | null {
  const L = useVocab();
  if (!target) return null;
  const adding = attachedCount > 0;
  const headline = adding
    ? fileCount > 0 ? L.wbDropAddMoreN.replace('{n}', String(fileCount)) : L.wbDropAddMore
    : fileCount > 0 ? L.wbDropFilesPlural.replace('{n}', String(fileCount)) : L.wbDropFilesSingular;
  const detail = adding
    ? L.wbDragOverCount.replace('{n}', String(attachedCount)).replace('{m}', String(attachedCount + fileCount))
    : null;

  return createPortal(
    <div
      data-chat-drop-overlay
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 8,
        zIndex: 30,
        pointerEvents: 'none',
        borderRadius: 'var(--r-float)',
        outline: '1.5px dashed var(--proto-accent)',
        outlineOffset: -1.5,
        background: 'color-mix(in srgb, var(--proto-accent) 6%, transparent)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 3,
          background: 'var(--proto-card)',
          border: '1px solid var(--proto-line)',
          borderRadius: 'var(--r-card)',
          padding: '10px 18px',
          boxShadow: 'var(--material-overlay-shadow)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{headline}</span>
        {detail && <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted)' }}>{detail}</span>}
      </div>
    </div>,
    target,
  );
}
