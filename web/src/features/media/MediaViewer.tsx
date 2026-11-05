import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import '@/design/content-surfaces.css';
import { IconButton } from '@/design/IconButton';
import { usePreviewHost, usePreviewModalChrome } from './preview-modal';
import { useDownloadFile } from './useDownloadFile';
import { useMediaSrc } from './useMediaSrc';
import { useZoom, type UseZoomReturn } from './useZoom';
import { SLIDE_PITCH, useLightboxNav, type StageSwipe } from './lightbox-nav';
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
// ← / → and a horizontal swipe, and counts its place in the caption. On touch the neighbours ride a
// track beside the shown item, so a swipe drags the next image in under the finger.

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
  overflow: 'hidden',
  animation: 'cxfade .18s ease both',
};

/** One item's place on the swipe track; it clips its own (zoomed) content to the stage box. */
const SLIDE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
};

/** A neighbouring video is not fetched until it is shown. */
const NO_SOURCE = {};

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

function SlideImage({ src, name, zoom }: { src: string; name: string; zoom: UseZoomReturn | null }): JSX.Element {
  return (
    <div ref={zoom?.contentRef} style={{ ...zoom?.style, display: 'inline-block' }}>
      <img src={src} alt={name} draggable={false} style={{ ...MEDIA_BOX, objectFit: 'contain', display: 'block' }} />
    </div>
  );
}

/** `zoom` is set on the shown slide only; a neighbouring video stays a ▶ until shown. */
function SlideBody({ item, src, failed, zoom }: { item: MediaItem; src: string | null; failed: boolean; zoom: UseZoomReturn | null }): JSX.Element {
  const L = useVocabOptional();
  const note = { color: 'var(--media-overlay-fg)', font: `500 12px ${mono}` };
  if (failed) return <div style={note}>{L.cmLoadFailed.replace('{name}', item.name)}</div>;
  if (!src) return <div style={note}>{zoom || item.kind === 'image' ? L.cmLoading : '▶'}</div>;
  if (item.kind === 'video') {
    return <video key={src} src={src} controls autoPlay playsInline style={{ ...MEDIA_BOX, background: 'var(--media-stage-bg)' }} />;
  }
  return <SlideImage src={src} name={item.name} zoom={zoom} />;
}

/** One item on the track, `offset` slides from the shown one. Keyed by group position, so the
 *  neighbour that slides in keeps its loaded image when it becomes the shown slide. */
function Slide({ item, offset, zoom }: { item: MediaItem; offset: number; zoom: UseZoomReturn | null }): JSX.Element {
  // A local composer preview already has an object URL; a workspace file is fetched with auth into
  // one (revoked on close / change) — shared with the docked preview pane.
  const wanted = zoom !== null || item.kind === 'image';
  const { src, failed } = useMediaSrc(wanted ? item : NO_SOURCE);
  const transform = offset === 0 ? undefined : `translateX(calc(${offset} * ${SLIDE_PITCH}))`;
  return (
    <div style={{ ...SLIDE, transform }}>
      <SlideBody item={item} src={wanted ? src : null} failed={failed} zoom={zoom} />
    </div>
  );
}

/** Media stage — the zoom and swipe gestures' touch target covers the full area. It holds the
 *  track of the shown item and its neighbours; the zoom transform sits on the shown image. */
function LightboxStage({ items, index, zoom, swipe }: { items: readonly MediaItem[]; index: number; zoom: UseZoomReturn; swipe: StageSwipe }): JSX.Element {
  const near = [index - 1, index, index + 1].filter((i) => i >= 0 && i < items.length);
  return (
    <div ref={zoom.containerRef} onClick={stopClick} {...swipe.handlers}
      style={{ ...MEDIA_BOX, width: '94vw', height: '84vh', position: 'relative', touchAction: 'none' }}>
      <div ref={swipe.trackRef} style={{ position: 'absolute', inset: 0 }}>
        {near.map((i) => <Slide key={i} item={items[i]} offset={i - index} zoom={i === index ? zoom : null} />)}
      </div>
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
  items: readonly MediaItem[];
  index: number;
  onStep: (delta: number) => void;
  onClose: () => void;
  onPin?: () => void;
}

function Lightbox({ items, index, onStep, onClose, onPin }: LightboxProps): JSX.Element {
  const item = items[index];
  const count = items.length;
  const zoom = useZoom({ mode: 'transform', maxScale: 8 });
  const { isZoomed, resetZoom } = zoom;
  usePreviewModalChrome(onClose);
  const step = (delta: number): void => {
    if (index + delta < 0 || index + delta >= count) return;
    resetZoom();
    onStep(delta);
  };
  const swipe = useLightboxNav(step, index, count, isZoomed);
  return (
    <div className="content-surface" role="dialog" aria-modal="true" aria-label={item.name}
      onClick={() => { if (!isZoomed) onClose(); else resetZoom(); }} style={SCRIM}>
      <LightboxActions item={item} onClose={onClose} onPin={onPin} />
      <LightboxStage items={items} index={index} zoom={zoom} swipe={swipe} />
      {count > 1 && <LightboxSteps index={index} count={count} onStep={step} />}
      <LightboxCaption name={item.name} index={index} count={count} />
    </div>
  );
}

export function MediaViewerProvider({ children }: { children: ReactNode }): JSX.Element {
  const { item, items, index, open, step, close, pin } = usePreviewHost<MediaItem>();
  const value = useMemo(() => ({ openMedia: open }), [open]);
  return (
    <MediaViewerContext.Provider value={value}>
      {children}
      {item && <Lightbox items={items} index={index} onStep={step} onClose={close} onPin={pin} />}
    </MediaViewerContext.Provider>
  );
}

export function useMediaViewer(): MediaViewerContextValue {
  return useContext(MediaViewerContext);
}
