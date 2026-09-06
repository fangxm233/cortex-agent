// input:  one docked file preview item
// output: the file's own identity/actions row over the same body the modals render
// pos:    Dock file rendering; reuses the modal renderers rather than reimplementing them
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState, type CSSProperties } from 'react';
import { PdfBody, TextBody } from '@/features/media/DocViewer';
import { HtmlBody } from '@/features/media/HtmlBody';
import { isMarkdownName } from '@/features/media/doc-kind';
import type { MediaItem } from '@/features/media/MediaViewer';
import { useDownloadFile } from '@/features/media/useDownloadFile';
import { useMediaSrc } from '@/features/media/useMediaSrc';
import { useZoom } from '@/features/media/useZoom';
import { FileBar, FileBarToggle } from './FileBar';
import { isDocItem, type FileItem } from './dock-tabs';

// A docked preview is never a lesser view: pdf/text/html go through the DocViewer's own bodies and
// media gets the lightbox's full-size source and wheel/pinch zoom.
//
// What the dock adds is the row the modals get from their header — where the file is and what can be
// done with it. A PDF already has such a row (its page pager) and takes the download there; every
// other kind gets a `FileBar`. A file with no workspace path (a composer object URL for something
// not uploaded yet) has nothing to show or download, so it gets no row at all.

const mono = "'IBM Plex Mono',monospace";

export function DockFileBody({ item }: { item: FileItem }): JSX.Element {
  const dl = useDownloadFile();
  const [source, setSource] = useState(false);
  const path = item.path;
  const download = path ? () => dl(path, item.name) : undefined;
  const markdown = isDocItem(item) && item.kind === 'text' && isMarkdownName(item.name);

  if (isDocItem(item) && item.kind === 'pdf') {
    return (
      <div style={CONTENT_STYLE.pdf}>
        <PdfBody
          item={item}
          actions={download && (
            <span role="button" data-file-download="" title="Download" onClick={download} style={PAGER_BUTTON_STYLE}>↓</span>
          )}
        />
      </div>
    );
  }

  return (
    <>
      {path && (
        <FileBar path={path} onDownload={download}>
          {markdown && (
            <FileBarToggle
              on={source}
              label={source ? 'Rendered' : 'Source'}
              title={source ? 'Show the rendered Markdown' : 'Show the unrendered Markdown source'}
              onClick={() => setSource((on) => !on)}
              data-file-source-toggle=""
            />
          )}
        </FileBar>
      )}
      <div style={isDocItem(item) && item.kind === 'text' ? CONTENT_STYLE.text : CONTENT_STYLE.fill}>
        {isDocItem(item)
          ? (item.kind === 'html' ? <HtmlBody item={item} mode="expanded" /> : <TextBody item={item} source={source} />)
          : <DockMediaBody item={item} />}
      </div>
    </>
  );
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

/** The pane's background follows the body under it — a PDF sits on the darker page surface. */
export function dockFileBackground(item: FileItem): string {
  return isDocItem(item) && item.kind === 'pdf' ? 'var(--proto-gray)' : 'var(--proto-card)';
}

// Text is the only body that does not manage its own scrolling; the rest fill and scroll internally.
const CONTENT_STYLE = {
  text: { flex: 1, minHeight: 0, overflow: 'auto' } as CSSProperties,
  fill: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } as CSSProperties,
  pdf: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } as CSSProperties,
};

const PAGER_BUTTON_STYLE: CSSProperties = {
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
