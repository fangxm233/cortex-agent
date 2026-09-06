// input:  one docked file preview item
// output: the same body the preview modals render, sized for the pane
// pos:    Dock file rendering; reuses the modal renderers rather than reimplementing them
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { PdfBody, TextBody } from '@/features/media/DocViewer';
import { HtmlBody } from '@/features/media/HtmlBody';
import type { MediaItem } from '@/features/media/MediaViewer';
import { useMediaSrc } from '@/features/media/useMediaSrc';
import { useZoom } from '@/features/media/useZoom';
import { isDocItem, type FileItem } from './dock-tabs';

// A docked preview is never a lesser view: pdf/text/html go through the DocViewer's own bodies and
// media gets the lightbox's full-size source and wheel/pinch zoom.

const mono = "'IBM Plex Mono',monospace";

export function DockFileBody({ item }: { item: FileItem }): JSX.Element {
  if (isDocItem(item)) {
    if (item.kind === 'pdf') return <PdfBody item={item} />;
    if (item.kind === 'html') return <HtmlBody item={item} mode="expanded" />;
    return <TextBody item={item} />;
  }
  return <DockMediaBody item={item} />;
}

/** Docs scroll (their renderers own the layout); media is centered and clipped. */
export function dockFileBodyStyle(item: FileItem): React.CSSProperties {
  if (isDocItem(item)) {
    return { overflow: 'auto', background: item.kind === 'pdf' ? 'var(--proto-gray)' : 'var(--proto-card)' };
  }
  return { display: 'flex', flexDirection: 'column', overflow: 'hidden' };
}

/** Full-size image / video inside the docked pane (wheel + pinch zoom, like the lightbox). */
function DockMediaBody({ item }: { item: MediaItem }): JSX.Element {
  const { src, failed } = useMediaSrc(item);
  const { containerRef, contentRef, style: zoomStyle } = useZoom({ mode: 'transform', minScale: 1, maxScale: 8 });

  if (failed) return <DockCentered failed>Failed to load {item.name}</DockCentered>;
  if (!src) return <DockCentered>Loading…</DockCentered>;

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 12, boxSizing: 'border-box' }}
    >
      {item.kind === 'video' ? (
        <video src={src} controls playsInline style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: 'var(--media-stage-bg)' }} />
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

export function DockCentered({ children, failed }: { children: React.ReactNode; failed?: boolean }): JSX.Element {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 20px', textAlign: 'center', color: failed ? 'var(--proto-faint)' : 'var(--proto-muted-2)', font: `500 12px ${mono}` }}>
      {children}
    </div>
  );
}
