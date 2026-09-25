// input:  Drop-target element, dragged file count, current attachment count
// output: ChatDropOverlay
// pos:    Pane-wide file-drop cue portaled into the chat drop target
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { createPortal } from 'react-dom';
import { useVocab } from '@/i18n';

const mono = "'IBM Plex Mono',monospace";

// The whole chat pane accepts drops, so the cue covers the whole pane rather than only the composer.
// It never takes pointer events: the drag keeps landing on the pane's own children, which is what the
// drop target's enter/leave depth counting expects. The host element must be `position: relative`.
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
    : L.wbAttachPath;

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
          border: '1px solid var(--proto-accent-border)',
          borderRadius: 'var(--r-card)',
          padding: '10px 18px',
          boxShadow: 'var(--shadow-accent-soft)',
        }}
      >
        <span style={{ font: `600 11.5px ${mono}`, color: 'var(--proto-accent)' }}>{headline}</span>
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>{detail}</span>
      </div>
    </div>,
    target,
  );
}
