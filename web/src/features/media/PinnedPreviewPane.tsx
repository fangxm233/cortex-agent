// input:  React, preview state, media/document renderers
// output: PinnedPreviewPane and PinnedPreviewPanel
// pos:    Docked media/document preview pane
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { PdfBody, TextBody } from './DocViewer';
import type { MediaItem } from './MediaViewer';
import { isDocPreviewItem, previewDownloadPath, splitFromDrag, type PreviewItem } from './pinned-preview';
import { usePinnedPreview } from './PinnedPreviewProvider';
import { useDownloadFile } from './useDownloadFile';
import { useMediaSrc } from './useMediaSrc';
import { useZoom } from './useZoom';

// DOCKED PREVIEW PANE — the pinned counterpart of the preview modals. Mounted by the workbench
// frame as a flex sibling between CenterChat and RightPanel, so pinning splits the center region
// into chat (left) | preview (right) instead of covering it with a scrim. Its left edge is a drag
// divider (split ratio persisted); its × unpins, restoring the modal preview mode.
// The BODY reuses the same renderers as the modals — full-size media (`useMediaSrc`, wheel/pinch
// zoom) and the DocViewer's `PdfBody` / `TextBody` — so a docked preview is never a lesser view.

const mono = "'IBM Plex Mono',monospace";

export const PINNED_PREVIEW_EMPTY_HINT = 'Click an image or file to preview it here.';

/** Full-size image / video inside the docked pane (wheel + pinch zoom, like the lightbox). */
function PinnedMediaBody({ item }: { item: MediaItem }): JSX.Element {
  const { src, failed } = useMediaSrc(item);
  const { containerRef, contentRef, style: zoomStyle } = useZoom({ mode: 'transform', minScale: 1, maxScale: 8 });

  if (failed) return <Centered failed>Failed to load {item.name}</Centered>;
  if (!src) return <Centered>Loading…</Centered>;

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 12, boxSizing: 'border-box' }}
    >
      {item.kind === 'video' ? (
        <video src={src} controls playsInline style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: '#000' }} />
      ) : (
        <div ref={contentRef} style={{ ...zoomStyle, display: 'inline-block', maxWidth: '100%', maxHeight: '100%' }}>
          <img
            src={src}
            alt={item.name}
            draggable={false}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
        </div>
      )}
    </div>
  );
}

function Centered({ children, failed }: { children: ReactNode; failed?: boolean }): JSX.Element {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 20px', textAlign: 'center', color: failed ? 'var(--proto-faint)' : 'var(--proto-muted-2)', font: `500 12px ${mono}` }}>
      {children}
    </div>
  );
}

/** Presentational docked pane — chrome + body. State/wiring lives in `PinnedPreviewPane`. */
export function PinnedPreviewPanel({
  item,
  split,
  onClose,
  onResizeStart,
  onDownload,
  rootRef,
}: {
  item: PreviewItem | null;
  split: number;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
  onDownload?: () => void;
  rootRef?: Ref<HTMLDivElement>;
}): JSX.Element {
  const isDoc = !!item && isDocPreviewItem(item);
  const downloadPath = item ? previewDownloadPath(item) : null;
  return (
    <div
      ref={rootRef}
      data-pane="preview"
      style={{
        flexGrow: split,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--proto-card)',
        borderLeft: '1px solid var(--proto-line)',
        position: 'relative',
      }}
    >
      {/* Divider — drag to re-balance chat vs preview. */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onMouseDown={onResizeStart}
        style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 3 }}
      />

      {/* Header — same 50px height as the chat header, so the two panes line up. */}
      <div
        style={{
          height: 50,
          flex: 'none',
          borderBottom: '1px solid var(--proto-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
        }}
      >
        <span
          title={item?.name}
          style={{ flex: 1, minWidth: 0, font: `600 11.5px ${mono}`, color: 'var(--proto-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {item?.name ?? 'Preview'}
        </span>
        {downloadPath && (
          <span role="button" title="Download" onClick={onDownload} style={btnStyle}>
            ↓
          </span>
        )}
        <span role="button" title="Unpin preview" onClick={onClose} style={{ ...btnStyle, fontSize: 16 }}>
          ×
        </span>
      </div>

      {/* Body — docs scroll (their renderers own the layout), media is centered and clipped. */}
      <div
        style={
          isDoc
            ? { flex: 1, minHeight: 0, overflow: 'auto', background: item?.kind === 'pdf' ? 'var(--proto-gray)' : 'var(--proto-card)' }
            : { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
        }
      >
        {!item ? (
          <Centered>{PINNED_PREVIEW_EMPTY_HINT}</Centered>
        ) : isDocPreviewItem(item) ? (
          item.kind === 'pdf' ? <PdfBody item={item} /> : <TextBody item={item} />
        ) : (
          <PinnedMediaBody item={item as MediaItem} />
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: '1px solid var(--proto-line)',
  background: 'var(--proto-card)',
  color: 'var(--proto-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  cursor: 'pointer',
  flex: 'none',
  userSelect: 'none',
};

/** The dock host: registers itself (so previews CAN be pinned on this surface) and renders the
 *  docked pane while pinned mode is on. Rendered by the workbench frame only. */
export function PinnedPreviewPane(): JSX.Element | null {
  const { pinned, item, split, unpin, setSplit, registerHost } = usePinnedPreview();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const dl = useDownloadFile();

  useEffect(() => registerHost(), [registerHost]);

  // Divider drag: the resizable region is the chat pane + this pane (the two rails are fixed-width),
  // measured from this pane and its preceding sibling at drag start.
  const onResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault();
    const pane = paneRef.current;
    const chat = pane?.previousElementSibling as HTMLElement | null;
    if (!pane || !chat) return;
    const paneRect = pane.getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    const regionLeft = chatRect.left;
    const regionWidth = chatRect.width + paneRect.width;
    let last = split;
    const onMove = (ev: MouseEvent): void => {
      last = splitFromDrag(regionLeft, regionWidth, ev.clientX);
      setSplit(last);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      setSplit(last, true);
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!pinned) return null;

  const path = item ? previewDownloadPath(item) : null;
  return (
    <PinnedPreviewPanel
      rootRef={paneRef}
      item={item}
      split={split}
      onClose={unpin}
      onResizeStart={onResizeStart}
      onDownload={path && item ? () => dl(path, item.name) : undefined}
    />
  );
}
