import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import '@/design/content-surfaces.css';
import { IconButton } from '@/design/IconButton';
import { usePreviewHost, usePreviewModalChrome } from './preview-modal';
import { useDownloadFile } from './useDownloadFile';
import { useMediaSrc } from './useMediaSrc';
import { useZoom } from './useZoom';
import { useVocabOptional } from '@/i18n';
import type { MediaItem } from './preview-item';

// Shared full-screen media lightbox (modal) — the single previewer for every image/video surface on
// web AND mobile: the composer's attachment preview, a sent user message's photo/video, and an
// agent-sent image/video. Opening a preview NEVER opens a new browser tab; it raises this in-app modal
// (scrim + centered media + close/download). One instance is mounted per shell (ShellProviders)
// and opened from anywhere via `useMediaViewer().openMedia(item)`.
//
// The modal is the DEFAULT mode. Where a dock host exists (the desktop workbench — see
// `features/dock`, reached through the `design/dock-intake` seam), the lightbox also offers ◧: the
// preview leaves the modal and opens as a TAB in
// the dock beside the chat, and from then on `openMedia` opens (or focuses) a tab instead of raising
// this modal. Closing the dock (its ×) restores the modal mode.

interface MediaViewerContextValue {
  openMedia: (item: MediaItem) => void;
}

// Default to a no-op for callers outside a mounted provider; real open behavior is supplied by
// MediaViewerProvider in each shell.
const MediaViewerContext = createContext<MediaViewerContextValue>({ openMedia: () => {} });

const mono = "'IBM Plex Mono',monospace";

/** Lightbox controls sit on the dark scrim, so they keep their own light-on-glass look. */
const LIGHTBOX_CONTROL: CSSProperties = {
  borderRadius: 'var(--r-control)',
  background: 'var(--media-control-bg)',
  color: 'var(--ink-solid-fg)',
};

function Lightbox({ item, onClose, onPin }: { item: MediaItem; onClose: () => void; onPin?: () => void }): JSX.Element {
  // Resolve the source: a local composer preview already has an object URL; a workspace file is
  // fetched with auth into one (revoked on close / change) — shared with the docked preview pane.
  const { src, failed } = useMediaSrc(item);
  const dl = useDownloadFile();
  const L = useVocabOptional();
  const { containerRef, contentRef, style: zoomStyle, isZoomed, resetZoom } = useZoom({ mode: 'transform', maxScale: 8 });

  usePreviewModalChrome(onClose);

  const onDownload = (): void => {
    if (item.path) {
      dl(item.path, item.name);
    } else if (item.url) {
      const a = document.createElement('a');
      a.href = item.url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  return (
    <div
      className="content-surface"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={() => { if (!isZoomed) onClose(); else resetZoom(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 4000,
        background: 'var(--media-backdrop)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))',
        boxSizing: 'border-box',
        animation: 'cxfade .18s ease both',
      }}
    >
      {/* Top action bar — pin + download + close. Stops propagation so bar clicks don't close the modal. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 'max(14px, env(safe-area-inset-top))',
          right: 14,
          display: 'flex',
          gap: 10,
          zIndex: 2,
        }}
      >
        {onPin && (
          <IconButton label={L.mediaPin} size={38} onClick={onPin} style={{ ...LIGHTBOX_CONTROL, fontSize: 15 }}>
            ◧
          </IconButton>
        )}
        <IconButton label={L.cmDownload} size={38} onClick={onDownload} style={{ ...LIGHTBOX_CONTROL, fontSize: 16 }}>
          ↓
        </IconButton>
        <IconButton label={L.cmClose} size={38} onClick={onClose} style={{ ...LIGHTBOX_CONTROL, fontSize: 18 }}>
          ×
        </IconButton>
      </div>

      {/* Media stage — touch target for zoom gestures covers full area; transform on inner wrapper. */}
      <div
        ref={containerRef}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '94vw', maxHeight: '84vh', width: '94vw', height: '84vh', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      >
        {failed ? (
          <div style={{ color: 'var(--media-overlay-fg)', font: `500 12px ${mono}` }}>{L.cmLoadFailed.replace('{name}', item.name)}</div>
        ) : !src ? (
          <div style={{ color: 'var(--media-overlay-fg)', font: `500 12px ${mono}` }}>{L.cmLoading}</div>
        ) : item.kind === 'video' ? (
          <video
            src={src}
            controls
            autoPlay
            playsInline
            style={{ maxWidth: '94vw', maxHeight: '84vh', background: 'var(--media-stage-bg)' }}
          />
        ) : (
          <div ref={contentRef} style={{ ...zoomStyle, display: 'inline-block' }}>
            <img
              src={src}
              alt={item.name}
              draggable={false}
              style={{ maxWidth: '94vw', maxHeight: '84vh', objectFit: 'contain', display: 'block' }}
            />
          </div>
        )}
      </div>

      {/* Filename caption */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', bottom: 'max(16px, env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center', color: 'var(--media-caption-fg)', font: `500 11px ${mono}`, padding: '0 20px', pointerEvents: 'none' }}
      >
        {item.name}
      </div>
    </div>
  );
}

export function MediaViewerProvider({ children }: { children: ReactNode }): JSX.Element {
  const { item, open, close, pin } = usePreviewHost<MediaItem>();
  const value = useMemo(() => ({ openMedia: open }), [open]);
  return (
    <MediaViewerContext.Provider value={value}>
      {children}
      {item && <Lightbox item={item} onClose={close} onPin={pin} />}
    </MediaViewerContext.Provider>
  );
}

export function useMediaViewer(): MediaViewerContextValue {
  return useContext(MediaViewerContext);
}
