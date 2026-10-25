import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import '@/design/content-surfaces.css';
import { IconButton } from '@/design/IconButton';
import { usePreviewHost, usePreviewModalChrome } from './preview-modal';
import { useDownloadFile } from './useDownloadFile';
import { useMediaSrc } from './useMediaSrc';
import { useZoom, type UseZoomReturn } from './useZoom';
import { useLightboxNav, type StageSwipe } from './lightbox-nav';
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
//
// A surface showing several media together (one message's attachments, or the images in one
// message's text) passes them as `group`: the lightbox then steps through that group with ‹ ›,
// ← / → and a horizontal swipe, and counts its place in the caption.

interface MediaViewerContextValue {
  /** `group`, when given, must contain `item`; the lightbox steps through it. */
  openMedia: (item: MediaItem, group?: readonly MediaItem[]) => void;
}

// Default to a no-op for callers outside a mounted provider; real open behavior is supplied by
// MediaViewerProvider in each shell.
const MediaViewerContext = createContext<MediaViewerContextValue>({ openMedia: () => {} });

const mono = "'IBM Plex Mono',monospace";
const MEDIA_BOX: CSSProperties = { maxWidth: '94vw', maxHeight: '84vh' };

/** Lightbox controls sit on the dark scrim, so they keep their own light-on-glass look. */
const LIGHTBOX_CONTROL: CSSProperties = {
  borderRadius: 'var(--r-control)',
  background: 'var(--media-control-bg)',
  color: 'var(--ink-solid-fg)',
};

const SCRIM: CSSProperties = {
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
};

const stopClick = (e: { stopPropagation: () => void }): void => e.stopPropagation();

function useDownloadItem(): (item: MediaItem) => void {
  const dl = useDownloadFile();
  return (item) => {
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
}

/** Top action bar — pin + download + close. Stops propagation so bar clicks don't close the modal. */
function LightboxActions({ item, onClose, onPin }: { item: MediaItem; onClose: () => void; onPin?: () => void }): JSX.Element {
  const L = useVocabOptional();
  const download = useDownloadItem();
  return (
    <div onClick={stopClick} style={{ position: 'absolute', top: 'max(14px, env(safe-area-inset-top))', right: 14, display: 'flex', gap: 10, zIndex: 2 }}>
      {onPin && (
        <IconButton label={L.mediaPin} size={38} onClick={onPin} style={{ ...LIGHTBOX_CONTROL, fontSize: 15 }}>
          ◧
        </IconButton>
      )}
      <IconButton label={L.cmDownload} size={38} onClick={() => download(item)} style={{ ...LIGHTBOX_CONTROL, fontSize: 16 }}>
        ↓
      </IconButton>
      <IconButton label={L.cmClose} size={38} onClick={onClose} style={{ ...LIGHTBOX_CONTROL, fontSize: 18 }}>
        ×
      </IconButton>
    </div>
  );
}

function StageBody({ item, src, failed, zoom }: { item: MediaItem; src: string | null; failed: boolean; zoom: UseZoomReturn }): JSX.Element {
  const L = useVocabOptional();
  const note = { color: 'var(--media-overlay-fg)', font: `500 12px ${mono}` };
  if (failed) return <div style={note}>{L.cmLoadFailed.replace('{name}', item.name)}</div>;
  if (!src) return <div style={note}>{L.cmLoading}</div>;
  if (item.kind === 'video') {
    return <video key={src} src={src} controls autoPlay playsInline style={{ ...MEDIA_BOX, background: 'var(--media-stage-bg)' }} />;
  }
  return (
    <div ref={zoom.contentRef} style={{ ...zoom.style, display: 'inline-block' }}>
      <img src={src} alt={item.name} draggable={false} style={{ ...MEDIA_BOX, objectFit: 'contain', display: 'block' }} />
    </div>
  );
}

/** Media stage — the zoom gestures' touch target covers the full area; the transform sits on the inner wrapper. */
function LightboxStage({ item, zoom, swipe }: { item: MediaItem; zoom: UseZoomReturn; swipe: StageSwipe }): JSX.Element {
  // A local composer preview already has an object URL; a workspace file is fetched with auth into
  // one (revoked on close / change) — shared with the docked preview pane.
  const { src, failed } = useMediaSrc(item);
  return (
    <div ref={zoom.containerRef} onClick={stopClick} {...swipe}
      style={{ ...MEDIA_BOX, width: '94vw', height: '84vh', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <StageBody item={item} src={src} failed={failed} zoom={zoom} />
    </div>
  );
}

/** ‹ › at the scrim's edges; each hides at its end of the group. */
function LightboxSteps({ index, count, onStep }: { index: number; count: number; onStep: (delta: number) => void }): JSX.Element {
  const L = useVocabOptional();
  const edge = (side: 'left' | 'right'): CSSProperties => ({
    ...LIGHTBOX_CONTROL, position: 'absolute', top: '50%', [side]: 14, transform: 'translateY(-50%)', fontSize: 22, zIndex: 2,
  });
  return (
    <>
      {index > 0 && <IconButton label={L.mediaPrevItem} size={38} onClick={(e) => { stopClick(e); onStep(-1); }} style={edge('left')}>‹</IconButton>}
      {index < count - 1 && <IconButton label={L.mediaNextItem} size={38} onClick={(e) => { stopClick(e); onStep(1); }} style={edge('right')}>›</IconButton>}
    </>
  );
}

function LightboxCaption({ name, index, count }: { name: string; index: number; count: number }): JSX.Element {
  return (
    <div onClick={stopClick}
      style={{ position: 'absolute', bottom: 'max(16px, env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center', color: 'var(--media-caption-fg)', font: `500 11px ${mono}`, padding: '0 20px', pointerEvents: 'none' }}>
      {count > 1 ? `${index + 1} / ${count} · ${name}` : name}
    </div>
  );
}

interface LightboxProps {
  item: MediaItem;
  index: number;
  count: number;
  onStep: (delta: number) => void;
  onClose: () => void;
  onPin?: () => void;
}

function Lightbox({ item, index, count, onStep, onClose, onPin }: LightboxProps): JSX.Element {
  const zoom = useZoom({ mode: 'transform', maxScale: 8 });
  const { isZoomed, resetZoom } = zoom;
  usePreviewModalChrome(onClose);
  const step = (delta: number): void => {
    if (index + delta < 0 || index + delta >= count) return;
    resetZoom();
    onStep(delta);
  };
  const swipe = useLightboxNav(step, count > 1, isZoomed);
  return (
    <div className="content-surface" role="dialog" aria-modal="true" aria-label={item.name}
      onClick={() => { if (!isZoomed) onClose(); else resetZoom(); }} style={SCRIM}>
      <LightboxActions item={item} onClose={onClose} onPin={onPin} />
      <LightboxStage item={item} zoom={zoom} swipe={swipe} />
      {count > 1 && <LightboxSteps index={index} count={count} onStep={step} />}
      <LightboxCaption name={item.name} index={index} count={count} />
    </div>
  );
}

export function MediaViewerProvider({ children }: { children: ReactNode }): JSX.Element {
  const { item, index, count, open, step, close, pin } = usePreviewHost<MediaItem>();
  const value = useMemo(() => ({ openMedia: open }), [open]);
  return (
    <MediaViewerContext.Provider value={value}>
      {children}
      {item && <Lightbox item={item} index={index} count={count} onStep={step} onClose={close} onPin={pin} />}
    </MediaViewerContext.Provider>
  );
}

export function useMediaViewer(): MediaViewerContextValue {
  return useContext(MediaViewerContext);
}
